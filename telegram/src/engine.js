import fs from 'node:fs';
import { parse, search, catalog, warnings } from './catalog.js';
import { likelyWhisperHallucination } from '../../public/voice-utils.js';
import { splitPositions } from './splitter.js';
import { exportDraft } from './export.js';
export const VERSION=JSON.parse(fs.readFileSync(new URL('../../app-version.json',import.meta.url)));
const MENU={keyboard:[[{text:'➕ Новая смета'},{text:'📋 Показать'}],[{text:'✅ Завершить'},{text:'📤 Экспорт'}],[{text:'❌ Отменить'}]],resize_keyboard:true};
const HELP=`Agent Stroy v${VERSION.version} (build ${VERSION.build})\n/new Название объекта — начать смету\nОдно сообщение — одна или несколько позиций. Можно перечислить товары голосом, использовать переносы строк или сказать «следующая строка».\n/list — текущая смета; /row ID — карточка строки\n/edit ID текст — заменить строку\n/clarify ID текст — дополнить строку (или ответьте текстом/голосом на её карточку)\n/qty ID число единица — количество\n/item ID товар — найти товар\n/variant ID — выбрать вариант
/manual ID товар | вариант — ручной ввод\n/delete ID, /restore ID — убрать/вернуть строку\n/merge ID1 ID2 — склеить в указанном порядке
/split ID текст — разделить строку (позиции с новой строки)\n/retry ID — повторить неудавшееся распознавание\n/finish — завершить, даже если есть поля для проверки\n/export — файлы CSV и JSON\n/history — последние сметы; /show ID — посмотреть свою смету\n/cancel — отменить с подтверждением\nЦены и поставщики в эту версию не входят.`;
const JSONp=l=>JSON.parse(l.parsed);
export class Engine {
  constructor(store,c,{telegram,transcriber}={}){this.s=store;this.c=c;this.telegram=telegram;this.transcriber=transcriber;}
  enqueue(updates){this.s.enqueue(updates,this.c.maxPending);}
  message(chat,text,extra={}){return {payload:{chat_id:chat,text,...extra}};}
  chunks(chat,text){
    const result=[];let chunk='';
    for(const line of text.split('\n')){if((chunk+line).length>3800){if(chunk)result.push(this.message(chat,chunk));chunk='';}if(line.length>3800){for(let i=0;i<line.length;i+=3700)result.push(this.message(chat,line.slice(i,i+3700)));}else chunk+=line+'\n';}
    if(chunk)result.push(this.message(chat,chunk.trimEnd()));return result;
  }
  card(chat,line){
    const p=JSONp(line),ws=warnings(line);
    const text=`Строка #${line.id}\n${line.raw_text||'Голос пока не распознан'}\n\nТовар: ${p.family?.name||'не определён'}\nВариант: ${p.variant?.label||'не выбран'}\nКоличество: ${p.quantity??'—'} ${p.unit||p.orderUnit||''}\n${ws.length?'Проверьте: '+ws.join('; '):'Разобрано. Можно исправить.'}\nОтветьте на эту карточку для уточнения.`;
    return {lineId:line.id,payload:{chat_id:chat,text,reply_markup:{inline_keyboard:[
      [{text:'Товар',callback_data:`r:${line.id}:${line.revision}:family`},{text:'Вариант',callback_data:`r:${line.id}:${line.revision}:variant`}],
      [{text:'Удалить',callback_data:`r:${line.id}:${line.revision}:delete`},...(line.status==='failed'?[{text:'Повторить STT',callback_data:`r:${line.id}:${line.revision}:retry`}]:[])]
    ]}}};
  }
  updateLine(id,text){
    if(!text.trim()||text.length>2000)throw new Error('text_length');
    this.s.run("UPDATE lines SET raw_text=?,parsed=?,status='ready',revision=revision+1 WHERE id=?",text.trim(),JSON.stringify(parse(text)),id);
    return this.s.one('SELECT * FROM lines WHERE id=?',id);
  }
  addParts(chat,draft,text,sourceUpdate,firstLine=null){
    const parts=splitPositions(text);
    if(this.s.lines(draft.id).length+parts.length-(firstLine?1:0)>200)throw new Error('draft_full');
    let first=firstLine;
    if(!first){
      const position=this.s.one('SELECT coalesce(max(position),0)+1 AS n FROM lines WHERE draft_id=?',draft.id).n;
      const id=Number(this.s.run('INSERT INTO lines(draft_id,position,source_update) VALUES(?,?,?)',draft.id,position,sourceUpdate).lastInsertRowid);
      first=this.s.line(draft.id,id);
    }
    if(parts.length>1)this.s.run('UPDATE lines SET position=position+? WHERE draft_id=? AND position>?',parts.length-1,draft.id,first.position);
    const lines=[this.updateLine(first.id,parts[0])];
    for(let i=1;i<parts.length;i++){
      const id=Number(this.s.run('INSERT INTO lines(draft_id,position) VALUES(?,?)',draft.id,first.position+i).lastInsertRowid);
      lines.push(this.updateLine(id,parts[i]));
    }
    lines.forEach((line,i)=>this.s.run('INSERT OR IGNORE INTO source_parts VALUES(?,?,?)',sourceUpdate,i,line.id));
    const effects=lines.map(l=>this.card(chat,l));
    if(lines.length>1)effects.unshift(this.message(chat,`Сообщение разделено на ${lines.length} строк. Проверьте карточки; /merge ID1 ID2 — склеить, /split ID текст — разделить иначе.`));
    return effects;
  }
  summary(chat,draft){
    const lines=this.s.lines(draft.id);
    let text=`Смета #${draft.id}: ${draft.title}\nСтатус: ${draft.status==='draft'?'черновик':draft.status==='finished'?'завершена':'отменена'}\n`;
    for(const line of lines){const p=JSONp(line);text+=`\n#${line.id} ${line.raw_text||'[голос не распознан]'}\n → ${p.family?.name||'?'} · ${p.variant?.label||'?'} · ${p.quantity??'?'} ${p.unit||p.orderUnit||''}${warnings(line).length?' ⚠':''}\n`;}
    if(!lines.length)text+='\nСтрок пока нет. Отправьте голосовое сообщение.';
    return this.chunks(chat,text);
  }
  exports(chat,draft){const e=exportDraft(draft,this.s.lines(draft.id),VERSION);return [['csv','text/csv',e.csv],['json','application/json',e.json]].map(([ext,mime,content])=>({method:'sendDocument',payload:{chat_id:chat,_document:{name:`smeta-${draft.id}.${ext}`,mime,content}}}));}
  replyLine(message,draft){
    if(!message.reply_to_message)return null;
    const found=this.s.one("SELECT line_id FROM outbox WHERE message_id=? AND json_extract(payload,'$.chat_id')=? AND line_id IS NOT NULL",message.reply_to_message.message_id,message.chat.id);
    return found?this.s.line(draft.id,found.line_id):null;
  }
  async step(){
    const event=this.s.one("SELECT * FROM inbox WHERE status='pending' ORDER BY id LIMIT 1");if(!event)return false;
    this.s.run("UPDATE inbox SET status='processing' WHERE id=?",event.id);
    const u=JSON.parse(event.payload),m=u.message||u.callback_query?.message,chat=m.chat.id,user=String(u.message?.from?.id||u.callback_query.from.id);
    try{
      if(u.message)u.message._updateId=event.id;
      if(u.message?.voice)await this.voice(event.id,u.message,user);
      else if((u.message?.text||'').match(/^\/retry(?:@\w+)?\s+\d+\s*$/i)){
        const id=Number(u.message.text.trim().split(/\s+/)[1]);await this.retry(event.id,chat,user,id);
      }else if(u.callback_query?.data?.endsWith(':retry')){
        const d=this.s.active(user,chat),parts=u.callback_query.data.split(':'),line=d&&this.s.line(d.id,Number(parts[1]));
        if(!line||line.revision!==Number(parts[2]))this.s.tx(()=>this.s.emit(event.id,[this.message(chat,'Кнопка устарела. Откройте /list.')]));
        else await this.retry(event.id,chat,user,line.id);
      }else this.s.tx(()=>{const effects=u.callback_query?this.callback(u.callback_query,user):this.command(u.message,user);this.s.emit(event.id,effects);});
    }catch(error){
      this.s.tx(()=>this.s.emit(event.id,[this.message(chat,error.message==='text_length'?'Текст строки должен быть от 1 до 2000 символов.':error.message==='message_length'?'Сообщение не добавлено: до 50 позиций, 2000 символов на позицию и 12000 на сообщение. Разбейте его на части.':error.message==='draft_full'?'Не хватает места в смете (максимум 200 строк). Сообщение не добавлено; завершите смету и начните новую.':'Не удалось обработать действие. Черновик сохранён; проверьте /list и повторите команду.')]));
      console.error(JSON.stringify({event:'update.failed',updateId:event.id,code:'processing_error'}));
    }
    return true;
  }
  command(m,user){
    const chat=m.chat.id;
    if(!m.text)return [this.message(chat,'Отправьте голосовое сообщение или текст. /help — команды.')];
    const shortcuts={'➕ Новая смета':'/new','📋 Показать':'/list','✅ Завершить':'/finish','📤 Экспорт':'/export','❌ Отменить':'/cancel'};
    const text=shortcuts[m.text]||m.text.trim();
    const match=text.match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/),cmd=match?.[1]?.toLowerCase(),args=(match?.[2]||'').trim();
    let draft=this.s.active(user,chat);
    if(cmd==='start'||cmd==='help')return [this.message(chat,HELP,{reply_markup:MENU})];
    if(cmd==='new'){
      if(draft)return [this.message(chat,`Уже есть черновик #${draft.id}. Продолжайте его либо /finish или /cancel.`,{reply_markup:MENU})];
      if(args.length>150)return [this.message(chat,'Название — до 150 символов.')];
      const id=Number(this.s.run('INSERT INTO drafts(user_id,chat_id,title) VALUES(?,?,?)',user,String(chat),args||'Новая смета').lastInsertRowid);
      return [this.message(chat,`Смета #${id} начата. Отправляйте одну или несколько позиций в голосовом либо текстовом сообщении.`,{reply_markup:MENU})];
    }
    if(cmd==='history')return this.chunks(chat,'Последние сметы:\n'+this.s.q('SELECT * FROM drafts WHERE user_id=? AND chat_id=? ORDER BY id DESC LIMIT 20',user,String(chat)).map(d=>`#${d.id} ${d.title} (${d.status})`).join('\n'));
    if(cmd==='show'){
      const d=this.s.one('SELECT * FROM drafts WHERE id=? AND user_id=? AND chat_id=?',Number(args)||0,user,String(chat));
      return d?this.summary(chat,d):[this.message(chat,'Смета не найдена.')];
    }
    if(cmd==='export'){
      const d=draft||this.s.one("SELECT * FROM drafts WHERE user_id=? AND chat_id=? AND status='finished' ORDER BY id DESC LIMIT 1",user,String(chat));
      return d?this.exports(chat,d):[this.message(chat,'Сначала создайте смету: /new.')];
    }
    if(!draft)return [this.message(chat,'Начните смету кнопкой «Новая смета» или /new Название объекта.',{reply_markup:MENU})];
    if(cmd==='list')return this.summary(chat,draft);
    if(cmd==='finish'){
      const lines=this.s.lines(draft.id);if(!lines.length)return [this.message(chat,'Пустую смету завершить нельзя.')];
      const warningCount=lines.filter(l=>warnings(l).length).length;
      this.s.run("UPDATE drafts SET status='finished' WHERE id=?",draft.id);draft={...draft,status:'finished'};
      return [this.message(chat,`Смета #${draft.id} завершена. Строк: ${lines.length}. Требуют проверки: ${warningCount}.\nЭто список материалов без расчёта стоимости. /new — следующая смета.`),...this.summary(chat,draft),...this.exports(chat,draft)];
    }
    if(cmd==='cancel')return [this.message(chat,`Отменить смету #${draft.id}? Она останется в истории.`,{reply_markup:{inline_keyboard:[[{text:'Да, отменить',callback_data:`cancel:${draft.id}`},{text:'Продолжить',callback_data:`keep:${draft.id}`}]]}})];
    if(cmd==='restore'){
      const l=this.s.one("SELECT * FROM lines WHERE draft_id=? AND id=? AND status='deleted'",draft.id,Number(args)||0);
      if(!l)return [this.message(chat,'Удалённая строка не найдена.')];
      const hasFailure=this.s.one("SELECT 1 FROM voice_jobs WHERE line_id=? AND status='failed'",l.id);
      this.s.run('UPDATE lines SET status=?,revision=revision+1 WHERE id=?',hasFailure&&!l.raw_text?'failed':'ready',l.id);
      return [this.card(chat,this.s.line(draft.id,l.id))];
    }
    if(cmd==='split'){
      const mm=args.match(/^(\d+)\s+([\s\S]+)$/),line=mm&&this.s.line(draft.id,Number(mm[1]));
      if(!line||splitPositions(mm[2]).length<2)return [this.message(chat,'Пример: /split ID и затем две позиции с новой строки.')];
      return this.addParts(chat,draft,mm[2],m._updateId,line);
    }
    if(cmd==='merge'){
      const [a,b]=args.split(/\s+/).map(Number),first=this.s.line(draft.id,a||0),second=this.s.line(draft.id,b||0);
      if(!first||!second||a===b)return [this.message(chat,'Укажите две разные строки: /merge ID1 ID2.')];
      const line=this.updateLine(a,[first.raw_text,second.raw_text].filter(Boolean).join(' '));
      this.s.run("UPDATE lines SET status='deleted',revision=revision+1 WHERE id=?",b);return [this.card(chat,line)];
    }
    if(['edit','clarify','qty','item','variant','delete','manual','row'].includes(cmd)){
      const mm=args.match(/^(\d+)(?:\s+([\s\S]*))?$/),id=Number(mm?.[1]||0),rest=mm?.[2]||'',line=this.s.line(draft.id,id);
      if(!line)return [this.message(chat,'Строка не найдена. Нужен ID из /list.')];
      if(cmd==='row')return [this.card(chat,line)];
      if(cmd==='delete'){this.s.run("UPDATE lines SET status='deleted',revision=revision+1 WHERE id=?",id);return [this.message(chat,`Строка #${id} убрана. /restore ${id} — вернуть.`)];}
      if(cmd==='variant')return this.variantOptions(chat,line,Number(rest)||0);
      if(cmd==='manual'){
        const [name,variant='']=rest.split('|').map(x=>x.trim());
        if(!name||name.length>150||variant.length>150)return [this.message(chat,`Пример: /manual ${id} Товар | Вариант`)];
        const p=JSONp(line);p.family={id:null,name};p.variant=variant?{id:null,label:variant}:null;p.familyCandidates=[];p.variantCandidates=[];
        this.s.run('UPDATE lines SET parsed=?,revision=revision+1 WHERE id=?',JSON.stringify(p),id);return [this.card(chat,this.s.line(draft.id,id))];
      }
      if(cmd==='item')return this.familyOptions(chat,line,rest||line.raw_text);
      if(cmd==='qty'){
        const qty=rest.match(/^(\d+(?:[.,]\d+)?)\s+(.{1,30})$/u);if(!qty||!Number.isFinite(Number(qty[1].replace(',','.')))||Number(qty[1].replace(',','.'))<=0)return [this.message(chat,`Пример: /qty ${id} 30 мешок`)];
        const p=JSONp(line);p.quantity=Number(qty[1].replace(',','.'));p.unit=qty[2].trim();this.s.run('UPDATE lines SET parsed=?,revision=revision+1 WHERE id=?',JSON.stringify(p),id);
        return [this.card(chat,this.s.line(draft.id,id))];
      }
      return [this.card(chat,this.updateLine(id,cmd==='edit'?rest:[line.raw_text,rest].join(' ')))];
    }
    if(cmd)return [this.message(chat,'Неизвестная команда. /help — список.')];
    if(m.reply_to_message){const line=this.replyLine(m,draft);if(!line)return [this.message(chat,'Ответьте на карточку строки текущей сметы либо используйте /clarify ID текст.')];return [this.card(chat,this.updateLine(line.id,line.raw_text+' '+text))];}
    return this.addParts(chat,draft,text,m._updateId);
  }
  familyOptions(chat,line,query){
    const candidates=search(query).slice(0,5);
    if(!candidates.length)return [this.message(chat,`Не нашёл товар. /edit ${line.id} новый текст — исправить название.`)];
    return [this.message(chat,`Товар для #${line.id}:`,{reply_markup:{inline_keyboard:candidates.map(f=>[{text:f.name.slice(0,60),callback_data:`r:${line.id}:${line.revision}:f:${f.id}`}])}})];
  }
  variantOptions(chat,line,page=0){
    const family=catalog.families.find(f=>f.id===JSONp(line).family?.id);
    if(!family)return [this.message(chat,`Сначала выберите товар: /item ${line.id} название.`)];
    const variants=family.variants;
    page=Math.max(0,Math.min(Math.floor(Number(page)||0),Math.floor((variants.length-1)/15)));
    const navigation=[];
    if(page>0)navigation.push({text:'← Назад',callback_data:`r:${line.id}:${line.revision}:page:${page-1}`});
    if((page+1)*15<variants.length)navigation.push({text:'Далее →',callback_data:`r:${line.id}:${line.revision}:page:${page+1}`});
    return [this.message(chat,`Варианты #${line.id}, страница ${page+1}:`,{reply_markup:{inline_keyboard:[...variants.slice(page*15,page*15+15).map(v=>[{text:v.label.slice(0,60),callback_data:`r:${line.id}:${line.revision}:v:${v.id}`}]),...(navigation.length?[navigation]:[]),[{text:'Без варианта',callback_data:`r:${line.id}:${line.revision}:v:none`}]]}})];
  }
  callback(q,user){
    const chat=q.message.chat.id,draft=this.s.active(user,chat),data=String(q.data||'');
    if(!draft)return [this.message(chat,'Нет активной сметы. /new — начать.')];
    if(data===`keep:${draft.id}`)return [this.message(chat,'Продолжайте отправлять позиции.')];
    if(data===`cancel:${draft.id}`){this.s.run("UPDATE drafts SET status='cancelled' WHERE id=?",draft.id);return [this.message(chat,`Смета #${draft.id} отменена. /new — начать новую.`)];}
    const [,id,rev,action,value]=data.split(':'),line=this.s.line(draft.id,Number(id)||0);
    if(!line||line.revision!==Number(rev))return [this.message(chat,'Кнопка устарела. /list — номера строк; /row ID — свежая карточка.')];
    if(action==='delete'){this.s.run("UPDATE lines SET status='deleted',revision=revision+1 WHERE id=?",line.id);return [this.message(chat,`Строка #${line.id} убрана. /restore ${line.id} — вернуть.`)];}
    if(action==='family')return this.familyOptions(chat,line,line.raw_text);
    if(action==='variant')return this.variantOptions(chat,line);
    if(action==='page')return this.variantOptions(chat,line,Number(value));
    const p=JSONp(line);
    if(action==='f'){
      const family=catalog.families.find(f=>f.id===value);if(!family)return [this.message(chat,'Товар не найден.')];
      p.family={id:family.id,name:family.name,orderUnit:family.orderUnit};p.variant=null;p.orderUnit=family.orderUnit;
      if(!p.unit)p.unit=family.orderUnit;
    }else if(action==='v'){
      const family=catalog.families.find(f=>f.id===p.family?.id),v=family?.variants.find(v=>v.id===value);
      if(value!=='none'&&!v)return [this.message(chat,'Вариант не найден.')];p.variant=v?{...v,familyId:family.id}:null;
    }else return [this.message(chat,'Кнопка недоступна.')];
    this.s.run('UPDATE lines SET parsed=?,revision=revision+1 WHERE id=?',JSON.stringify(p),line.id);
    return [this.card(chat,this.s.line(draft.id,line.id))];
  }
  async voice(eventId,m,user){
    const chat=m.chat.id,draft=this.s.active(user,chat),voice=m.voice;
    if(!draft){this.s.tx(()=>this.s.emit(eventId,[this.message(chat,'Сначала начните смету: /new Название объекта. Голос не отправлялся на распознавание.')]));return;}
    if(!Number.isInteger(voice.duration)||voice.duration<1||voice.duration>this.c.maxVoiceSeconds||!voice.file_id||voice.file_size>this.c.maxVoiceBytes){this.s.tx(()=>this.s.emit(eventId,[this.message(chat,`Запись должна быть до ${this.c.maxVoiceSeconds} секунд и ${Math.floor(this.c.maxVoiceBytes/1000000)} МБ. Разделите длинный список на несколько сообщений.`)]));return;}
    let job=this.s.one('SELECT * FROM voice_jobs WHERE id=?',eventId);
    if(!job&&!m.reply_to_message&&this.s.lines(draft.id).length>=200){this.s.tx(()=>this.s.emit(eventId,[this.message(chat,'В смете уже 200 строк. Завершите её и начните следующую.')]));return;}
    if(!job){
      const reply=m.reply_to_message?this.replyLine(m,draft):null;
      if(m.reply_to_message&&!reply){this.s.tx(()=>this.s.emit(eventId,[this.message(chat,'Ответьте на карточку строки текущей сметы.') ]));return;}
      this.s.tx(()=>{
        let lineId=reply?.id;
        if(!lineId){const n=this.s.one('SELECT coalesce(max(position),0)+1 AS n FROM lines WHERE draft_id=?',draft.id).n;lineId=Number(this.s.run('INSERT INTO lines(draft_id,position,source_update) VALUES(?,?,?)',draft.id,n,eventId).lastInsertRowid);}
        this.s.run('INSERT INTO voice_jobs(id,line_id,voice,kind) VALUES(?,?,?,?)',eventId,lineId,JSON.stringify(voice),reply?'append':'new');
      });job=this.s.one('SELECT * FROM voice_jobs WHERE id=?',eventId);
    }
    await this.runVoiceJob(eventId,chat,draft,job);
  }
  async retry(eventId,chat,user,id){
    const draft=this.s.active(user,chat),line=draft&&this.s.line(draft.id,id);
    const retryJob=Number(this.s.get(`retry:${eventId}`,0));
    const job=line&&(retryJob?this.s.one('SELECT * FROM voice_jobs WHERE id=? AND line_id=?',retryJob,line.id):this.s.one("SELECT * FROM voice_jobs WHERE line_id=? AND status='failed' ORDER BY id DESC LIMIT 1",line.id));
    if(!job||(!retryJob&&job.attempt>=3)){this.s.tx(()=>this.s.emit(eventId,[this.message(chat,'Нет неудавшейся записи для повтора либо достигнут предел 3 повторов. Исправьте текст вручную.')]));return;}
    this.s.tx(()=>{
      const retryKey=`retry:${eventId}`;
      if(!this.s.get(retryKey)){
        this.s.run("UPDATE voice_jobs SET attempt=attempt+1,status='pending',error=NULL WHERE id=?",job.id);
        this.s.set(retryKey,job.id);
      }
    });
    await this.runVoiceJob(eventId,chat,draft,this.s.one('SELECT * FROM voice_jobs WHERE id=?',job.id));
  }
  async runVoiceJob(eventId,chat,draft,job){
    try{
      let text=job.transcript;
      if(text===null){
        const voice=JSON.parse(job.voice),bytes=await this.telegram.download(voice,this.c.maxVoiceBytes);
        text=await this.transcriber.transcribe(bytes,voice.duration,`${job.id}:${job.attempt}`);
        this.s.run('UPDATE voice_jobs SET transcript=? WHERE id=?',text,job.id);
      }
      if(!text||likelyWhisperHallucination(text))throw new Error('no_speech');
      this.s.tx(()=>{
        const line=this.s.line(draft.id,job.line_id);if(!line)throw new Error('line_missing');
        const effects=job.kind==='append'?[this.card(chat,this.updateLine(line.id,[line.raw_text,text].filter(Boolean).join(' ')))]:this.addParts(chat,draft,text,job.id,line);
        this.s.run("UPDATE voice_jobs SET status='complete',error=NULL WHERE id=?",job.id);
        this.s.emit(eventId,effects);
      });
    }catch(e){
      const codes=new Set(['budget','cooldown','uncertain','groq_rate_limit','groq_error','groq_transport','no_speech','file_too_large','invalid_ogg','text_length','message_length','draft_full']);
      const code=codes.has(e.code||e.message)?(e.code||e.message):'voice_error';
      this.s.tx(()=>{
        this.s.run("UPDATE voice_jobs SET status='failed',error=? WHERE id=?",code,job.id);
        if(job.kind==='new')this.s.run("UPDATE lines SET status='failed',revision=revision+1 WHERE id=?",job.line_id);
        const detail=['budget','cooldown','groq_rate_limit'].includes(code)?'Достигнут лимит распознавания. Повторите позже.':code==='no_speech'?'Не удалось получить полезную речь.':['message_length','draft_full'].includes(code)?'Список не добавлен: слишком много строк или слишком длинный текст. Разделите сообщение либо начните новую смету.':code==='uncertain'?'Предыдущая отправка могла выполниться до перезапуска. Автоматически повторять её не стал.':'Не удалось распознать запись.';
        this.s.emit(eventId,[this.message(chat,`${detail} Строка #${job.line_id} сохранена. /retry ${job.line_id} — повторить; /edit ${job.line_id} текст — ввести вручную.`)]);
      });
    }
  }
}
