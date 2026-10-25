import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { config } from '../src/config.js';
import { catalog, parse } from '../src/catalog.js';
function fixture(t,{stt,download}={}){
  const s=new Store();t.after(()=>s.close());const c=config({ALLOWED_USER_IDS:'1,2'},{requireSecrets:false});let calls=0,downloads=0;
  const e=new Engine(s,c,{telegram:{download:async(...args)=>{downloads++;return download?download(...args):Buffer.from('OggSfixture');}},transcriber:{transcribe:async(...args)=>{calls++;return stt?stt(...args):'ротбанд 30 кг 12 мешков';}}});
  let id=0;
  const put=async(content,user=1)=>{const u={update_id:++id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},...content}};e.enqueue([u]);await e.step();return u;};
  return {s,e,c,put,get calls(){return calls;},get downloads(){return downloads;}};
}
const voice={voice:{file_id:'file',duration:3,file_size:100}};
test('start, voice, corrections, finish and export',async t=>{
  const f=fixture(t);await f.put({text:'/new Север'});await f.put(voice);await f.put({text:'/qty 1 15 мешок'});await f.put({text:'/finish'});
  assert.equal(f.s.one('SELECT status FROM drafts').status,'finished');assert.equal(JSON.parse(f.s.one('SELECT parsed FROM lines').parsed).quantity,15);
  assert.equal(f.calls,1);assert.equal(f.s.q("SELECT * FROM outbox WHERE method='sendDocument'").length,2);
});
test('one voice can create several rows with one STT call',async t=>{
  const f=fixture(t,{stt:async()=>'Ротбанд 30 кг 12 мешков. Саморезы 100 штук.'});await f.put({text:'/new'});await f.put(voice);assert.equal(f.s.lines(1).length,2);assert.equal(f.calls,1);
});
test('duplicate updates cannot create another line or STT call',async t=>{
  const f=fixture(t);await f.put({text:'/new'});const u=await f.put(voice);f.e.enqueue([u,u]);assert.equal(await f.e.step(),false);assert.equal(f.s.lines(1).length,1);assert.equal(f.calls,1);
});
test('two employees have isolated drafts and cannot edit each others line',async t=>{
  const f=fixture(t);await f.put({text:'/new'},1);await f.put({text:'цемент 20 мешков'},1);await f.put({text:'/new'},2);await f.put({text:'/edit 1 украдено'},2);assert.equal(f.s.lines(1)[0].raw_text,'цемент 20 мешков');assert.equal(f.s.lines(2).length,0);
});
test('unauthorized and group updates are not persisted or processed',async t=>{
  const f=fixture(t);await f.put({text:'/new'},99);f.e.enqueue([{update_id:100,message:{from:{id:1},chat:{id:-1,type:'group'},...voice}}]);assert.equal(f.s.q('SELECT * FROM inbox').length,0);assert.equal(f.calls,0);
});
test('voice before new draft, oversize, long duration spend no STT',async t=>{
  const f=fixture(t);await f.put(voice);await f.put({text:'/new'});await f.put({voice:{...voice.voice,duration:121}});await f.put({voice:{...voice.voice,file_size:20_000_000}});assert.equal(f.calls,0);assert.equal(f.downloads,0);
});
test('failed STT keeps row and requires an explicit retry',async t=>{
  let bad=true;const f=fixture(t,{stt:async()=>{if(bad)throw new Error('network');return 'цемент 20 мешков';}});
  await f.put({text:'/new'});await f.put(voice);assert.equal(f.s.lines(1)[0].status,'failed');bad=false;await f.put({text:'/retry 1'});assert.equal(f.s.lines(1).length,1);assert.equal(f.s.lines(1)[0].status,'ready');assert.equal(f.calls,2);
});
test('hallucination never creates an apparently recognized line',async t=>{
  const f=fixture(t,{stt:async()=>'Продолжение следует...'});await f.put({text:'/new'});await f.put(voice);assert.equal(f.s.lines(1)[0].status,'failed');assert.equal(f.s.lines(1)[0].raw_text,'');
});
test('reply voice appends to row instead of creating a new row',async t=>{
  const f=fixture(t);await f.put({text:'/new'});await f.put({text:'ротбанд 30 кг'});
  f.s.run('UPDATE outbox SET message_id=123 WHERE line_id=1');await f.put({...voice,reply_to_message:{message_id:123}});assert.equal(f.s.lines(1).length,1);assert.match(f.s.lines(1)[0].raw_text,/ротбанд 30 кг ротбанд/);
});
test('reply to a finished or different draft does not modify it',async t=>{
  const f=fixture(t);await f.put({text:'/new'});await f.put({text:'цемент 10 мешков'});f.s.run('UPDATE outbox SET message_id=123 WHERE line_id=1');await f.put({text:'/finish'});await f.put({text:'/new'});await f.put({...voice,reply_to_message:{message_id:123}});assert.equal(f.calls,0);assert.equal(f.s.lines(1)[0].raw_text,'цемент 10 мешков');
});
test('text edit resets a manually chosen structure; manual entry clears catalog identifiers',async t=>{
  const f=fixture(t);await f.put({text:'/new'});await f.put({text:'ротбанд 30 кг 3 мешка'});await f.put({text:'/manual 1 Неизвестный товар | Особый вариант'});
  let p=JSON.parse(f.s.lines(1)[0].parsed);assert.equal(p.family.id,null);assert.equal(p.variant.id,null);
  await f.put({text:'/edit 1 дюбель гвозди три штуки'});p=JSON.parse(f.s.lines(1)[0].parsed);assert.equal(p.family.name,'Дюбель-гвоздь');assert.equal(p.variant,null);
});
test('delete/restore and merge are draft scoped and keep source order',async t=>{
  const f=fixture(t);await f.put({text:'/new'});await f.put({text:'ротбанд 30 кг'});await f.put({text:'12 мешков'});await f.put({text:'/delete 2'});assert.equal(f.s.lines(1).length,1);await f.put({text:'/restore 2'});await f.put({text:'/merge 1 2'});assert.equal(f.s.lines(1).length,1);assert.equal(f.s.lines(1)[0].raw_text,'ротбанд 30 кг 12 мешков');
});
test('new never silently replaces an active draft; cancellation needs callback',async t=>{
  const f=fixture(t);await f.put({text:'/new A'});await f.put({text:'/new B'});await f.put({text:'/cancel'});assert.equal(f.s.active(1,1).title,'A');
  f.e.enqueue([{update_id:50,callback_query:{id:'cb',from:{id:1},message:{chat:{id:1,type:'private'}},data:'cancel:1'}}]);await f.e.step();assert.equal(f.s.active(1,1),undefined);
});
test('stale inline buttons cannot overwrite newer corrections',async t=>{
  const f=fixture(t);await f.put({text:'/new'});await f.put({text:'ротбанд 30 кг 3 мешка'});await f.put({text:'/qty 1 7 мешок'});
  f.e.enqueue([{update_id:50,callback_query:{id:'x',from:{id:1},message:{chat:{id:1,type:'private'}},data:'r:1:1:f:F0001'}}]);await f.e.step();assert.equal(JSON.parse(f.s.lines(1)[0].parsed).quantity,7);assert.match(JSON.parse(f.s.q('SELECT payload FROM outbox ORDER BY id DESC LIMIT 1')[0].payload).text,/устарела/);
});
test('variant picker has navigation to catalog entries after first page',async t=>{
  const f=fixture(t),family=catalog.families.find(x=>x.variants.length>20);await f.put({text:'/new'});await f.put({text:'позиция'});
  const p={family:{id:family.id,name:family.name}};f.s.run('UPDATE lines SET parsed=? WHERE id=1',JSON.stringify(p));const options=f.e.variantOptions(1,f.s.lines(1)[0],1);
  assert.match(JSON.stringify(options),new RegExp(family.variants[15].id));assert.match(JSON.stringify(options),/Назад/);
});
test('real catalog matching never selects mass SKU from volume and never spends bare number twice',()=>{
  assert.equal(parse('грунтовка 10 литров').variant,null);assert.equal(parse('грунтовка 10 литров').quantity,10);assert.equal(parse('ротбанд 30').variant,null);assert.equal(parse('ротбанд 30').quantity,30);
});
test('new row command is atomic with done marker and same update is never repeated',async t=>{
  const f=fixture(t);await f.put({text:'/new'});const u=await f.put({text:'цемент 10 мешков'});assert.equal(f.s.one('SELECT source_update FROM lines').source_update,u.update_id);f.e.enqueue([u]);assert.equal(await f.e.step(),false);
});
test('positive numeric quantity is required and custom unit is preserved',async t=>{
  const f=fixture(t);await f.put({text:'/new'});await f.put({text:'цемент 10 мешков'});await f.put({text:'/qty 1 -4 кг'});assert.equal(JSON.parse(f.s.lines(1)[0].parsed).quantity,10);
  await f.put({text:'/qty 1 2,5 паллеты'});const p=JSON.parse(f.s.lines(1)[0].parsed);assert.equal(p.quantity,2.5);assert.equal(p.unit,'паллеты');
});
test('explicit retry has a fixed attempt limit and does not create new rows',async t=>{
  const f=fixture(t,{stt:async()=>{throw new Error('failed');}});await f.put({text:'/new'});await f.put(voice);for(let i=0;i<4;i++)await f.put({text:'/retry 1'});assert.equal(f.calls,4);assert.equal(f.s.lines(1).length,1);assert.equal(f.s.one('SELECT attempt FROM voice_jobs').attempt,3);
});
