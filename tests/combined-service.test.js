import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startCombined,serviceConfig} from '../src/service.js';
import {Telegram,Transcriber} from '../telegram/src/clients.js';
import {Store} from '../telegram/src/store.js';

function database(){return {closed:false,healthy:true,async initDb(c){assert.equal(c.length,1000);},async healthcheck(){if(!this.healthy)throw new Error('db unavailable');},async savePurchaseRequest(items){return {id:7,items};},async closeDb(){this.closed=true;}};}
async function start(t,{enabled=false,mode='webhook',telegram,db=database(),transcriber}={}){
  const dir=mkdtempSync(path.join(tmpdir(),'combined-'));
  const env={PORT:'0',TELEGRAM_ENABLED:String(enabled),TELEGRAM_BOT_TOKEN:'123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY',GROQ_API_KEY:'mock',BOT_MODE:mode,WEBHOOK_SECRET:'x'.repeat(24),DB_PATH:path.join(dir,'bot.sqlite')};
  const api=telegram||{call:async method=>method==='getWebhookInfo'?{url:''}:{message_id:100}};
  let running,controls;
  const started=new Promise((resolve,reject)=>{running=startCombined({env,db,telegram:api,transcriber,onReady:c=>{controls=c;resolve(c);}});running.catch(reject);});
  await started;
  t.after(async()=>{controls.stop();try{await running;assert.equal(db.closed,true);}finally{rmSync(dir,{recursive:true,force:true});}});
  return {...controls,url:`http://127.0.0.1:${controls.server.address().port}`,env,dir,db};
}
async function until(check){const deadline=Date.now()+3000;while(!check()){if(Date.now()>deadline)throw new Error('worker did not finish');await new Promise(r=>setTimeout(r,10));}}

test('combined config is opt-in, validates secrets, requires absolute storage before bot startup',()=>{
  assert.equal(serviceConfig({}).telegram,null);
  assert.throws(()=>serviceConfig({TELEGRAM_ENABLED:'yes'}));
  assert.throws(()=>serviceConfig({TELEGRAM_ENABLED:'true'}));
  const base={TELEGRAM_ENABLED:'true',TELEGRAM_BOT_TOKEN:'123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY',GROQ_API_KEY:'mock'};
  assert.throws(()=>serviceConfig(base),/absolute DB_PATH/);
  assert.throws(()=>serviceConfig({...base,DB_PATH:'./var/test.sqlite'}),/absolute DB_PATH/);
});
test('existing web runs without bot credentials, serves UI/catalog/match/requests on one port',async t=>{
  const s=await start(t);
  assert.match(await (await fetch(s.url)).text(),/Прораб/);
  const health=await (await fetch(s.url+'/api/health')).json();assert.equal(health.ok,true);assert.deepEqual(health.telegram,{enabled:false});
  assert.equal((await (await fetch(s.url+'/api/families')).json()).length,329);
  const match=await (await fetch(s.url+'/api/match',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'цемент 12 мешков'})})).json();assert.equal(match.quantity,12);
  const saved=await fetch(s.url+'/api/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({items:[{text:'цемент'}]})});assert.equal(saved.status,201);
  assert.equal((await fetch(s.url+'/telegram/webhook',{method:'POST'})).status,404);
  assert.equal(existsSync(s.env.DB_PATH),false);
});
test('one listener serves web and authenticated webhook; voice splits locally; health includes both stores',async t=>{
  let stt=0;const methods=[];const tg={call:async method=>{methods.push(method);return method==='getWebhookInfo'?{url:'https://example.test/telegram/webhook'}:{message_id:101};},download:async()=>Buffer.from('OggS-mock')};
  const s=await start(t,{enabled:true,telegram:tg,transcriber:{transcribe:async()=>{stt++;return 'цемент 12 мешков; кирпич 20 штук';}}});
  assert.equal((await fetch(s.url)).status,200);
  const post=async update=>fetch(s.url+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':s.env.WEBHOOK_SECRET},body:JSON.stringify(update)});
  assert.equal((await fetch(s.url+'/telegram/webhook',{method:'POST',body:'{}'})).status,403);
  const update=(id,content)=>({update_id:id,message:{message_id:id,from:{id:987654321},chat:{id:987654321,type:'private'},...content}});
  assert.equal((await post(update(1,{text:'/new Test'}))).status,200);
  await until(()=>s.engine.s.one('SELECT count(*) AS n FROM drafts').n===1);
  const voice=update(2,{voice:{file_id:'mock',duration:4}});
  assert.equal((await post(voice)).status,200);await until(()=>s.engine.s.lines(1).length===2);
  await post(voice);assert.equal(stt,1);
  await post({update_id:3,callback_query:{id:'public-callback',from:{id:987654321},message:{message_id:101,chat:{id:987654321,type:'private'}},data:'r:1:1:family'}});
  await until(()=>methods.includes('answerCallbackQuery'));
  const health=await (await fetch(s.url+'/api/health')).json();assert.deepEqual(health.telegram,{enabled:true,ready:true});
  assert.equal((await fetch(s.url+'/health')).status,200);
  assert.equal((await fetch(s.url+'/api/catalog?limit=3')).status,200);
  s.db.healthy=false;assert.equal((await fetch(s.url+'/api/health')).status,503);
});
test('polling mode reserves webhook route and keeps normal web routes available',async t=>{
  let polls=0;const tg={call:async method=>{
    if(method==='getUpdates'){polls++;await new Promise(r=>setTimeout(r,20));return [];}
    return method==='getWebhookInfo'?{url:''}:{message_id:1};
  }};
  const s=await start(t,{enabled:true,mode:'polling',telegram:tg});
  assert.equal((await fetch(s.url+'/telegram/webhook',{method:'POST',body:'{}'})).status,404);
  assert.equal((await fetch(s.url+'/telegram/webhook?x=1')).status,404);
  assert.equal((await fetch(s.url+'/api/match',{method:'POST',headers:{'content-type':'application/json'},body:'{"text":"цемент 12 мешков"}'})).status,200);
  assert.ok(polls>0);
});
test('startup rejects an active webhook in polling mode, closes PostgreSQL and never changes webhook',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'combined-fail-')),db=database(),methods=[];
  try{
    await assert.rejects(startCombined({env:{PORT:'0',TELEGRAM_ENABLED:'true',TELEGRAM_BOT_TOKEN:'123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY',GROQ_API_KEY:'mock',DB_PATH:path.join(dir,'db.sqlite')},db,telegram:{call:async method=>{methods.push(method);return method==='getWebhookInfo'?{url:'https://example.test/active'}:{};}}}),/Webhook is active/);
    assert.deepEqual(methods,['getMe','getWebhookInfo']);assert.equal(db.closed,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('shutdown aborts Telegram transport and records uncertain Groq attempt without automatic retry',async()=>{
  const abort=new AbortController(),s=new Store();
  const fetcher=async(_url,{signal})=>new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error('aborted'));else signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
  const tg=new Telegram('fake',{fetcher,signal:abort.signal});
  const transcriber=new Transcriber(s,{rpm:10,rpd:100,audioPerDay:1000,requestTimeoutMs:45000,groqKey:'fake'},{fetcher,signal:abort.signal});
  const call=tg.call('getUpdates'),stt=transcriber.transcribe(Buffer.from('OggS'),3,'shutdown');
  abort.abort();await assert.rejects(call,e=>e.code==='telegram_transport');await assert.rejects(stt,e=>e.code==='groq_transport');
  assert.equal(s.one('SELECT status FROM stt_attempts').status,'failed_or_uncertain');s.close();
});
test('release metadata is consistent for web, bot and visible version; catalog is shared',()=>{
  const read=p=>JSON.parse(readFileSync(new URL('../'+p,import.meta.url)));
  for(const p of ['app-version.json','public/app-version.json','telegram/app-version.json']){assert.equal(read(p).version,'0.3.7');assert.equal(read(p).build,15);}
  assert.equal(read('package.json').version,'0.3.7');assert.equal(read('telegram/package.json').version,'0.3.7');
  assert.equal(existsSync(new URL('../telegram/src/bot-token.js',import.meta.url)),true);
});

test('production entrypoint exits cleanly on missing database config rather than deadlocking on circular imports',async()=>{
  const {execFile}=await import('node:child_process');
  const result=await new Promise(resolve=>execFile(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,DATABASE_URL:'',TELEGRAM_ENABLED:'false'},timeout:5000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
  assert.equal(result.error?.code,1);
  assert.match(result.stderr,/Service startup\/runtime failed/);
  assert.doesNotMatch(result.stderr,/unsettled top-level await/);
});

test('Render automatically uses PostgreSQL and webhook without a disk or an enable flag',()=>{
  const env={RENDER:'true',RENDER_EXTERNAL_URL:'https://prorab-talk.onrender.com',DATABASE_URL:'postgresql://localhost/test',TELEGRAM_BOT_TOKEN:'123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY',GROQ_API_KEY:'mock',BOT_MODE:'polling',DB_PATH:'/var/data/old.sqlite'};
  const a=serviceConfig(env).telegram,b=serviceConfig(env).telegram;
  assert.equal(a.storage,'postgres');assert.equal(a.mode,'webhook');
  assert.equal(a.webhookUrl,'https://prorab-talk.onrender.com/telegram/webhook');
  assert.match(a.secret,/^[a-f0-9]{64}$/);assert.equal(a.secret,b.secret);
  assert.equal(serviceConfig({...env,TELEGRAM_ENABLED:'false'}).telegram.mode,'webhook');
  assert.throws(()=>serviceConfig({...env,DATABASE_URL:''}),/DATABASE_URL/);
});

test('Render starts with the embedded token despite a legacy disable flag and preserves pending updates',async()=>{
  const db=database(),methods=[],s=new Store();let controls;
  const env={PORT:'0',RENDER:'true',RENDER_EXTERNAL_URL:'https://example.onrender.com',DATABASE_URL:'postgresql://unused/mock',GROQ_API_KEY:'mock',TELEGRAM_ENABLED:'false'};
  const tg={call:async(method,payload)=>{methods.push({method,payload});return method==='getWebhookInfo'?{url:''}:true;}};
  await startCombined({env,db,telegram:tg,storeFactory:async()=>s,onReady:c=>{controls=c;c.stop();}});
  assert.ok(controls);assert.equal(db.closed,true);
  const registration=methods.find(x=>x.method==='setWebhook');
  assert.equal(registration.payload.url,'https://example.onrender.com/telegram/webhook');
  assert.equal(registration.payload.drop_pending_updates,false);assert.equal(registration.payload.max_connections,1);
  assert.deepEqual(registration.payload.allowed_updates,['message','callback_query']);
  assert.equal(methods.some(x=>x.method==='getUpdates'),false);
});

test('failed automatic registration closes the server and preserves durable queued data',async()=>{
  const db=database(),s=new Store();let port;
  const env={PORT:'0',RENDER:'true',RENDER_EXTERNAL_URL:'https://example.onrender.com',DATABASE_URL:'postgresql://unused/mock',TELEGRAM_BOT_TOKEN:'123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY',GROQ_API_KEY:'mock'};
  const tg={call:async method=>{if(method==='setWebhook')throw new Error('registration failed');return method==='getWebhookInfo'?{url:''}:true;}};
  await assert.rejects(startCombined({env,db,telegram:tg,storeFactory:async()=>s,onReady:c=>{port=c.server.address().port;}}),/registration failed/);
  assert.equal(port,undefined);assert.equal(db.closed,true);
});

test('webhook never acknowledges an update before its durable enqueue finishes',async()=>{
  const {makeServer}=await import('../telegram/src/runtime.js');
  let release;const committed=new Promise(r=>{release=r;});
  const server=makeServer({enqueue:async()=>committed},{mode:'webhook',secret:'z'.repeat(24)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    let responded=false;
    const request=fetch(`http://127.0.0.1:${server.address().port}/telegram/webhook`,{method:'POST',headers:{'x-telegram-bot-api-secret-token':'z'.repeat(24)},body:JSON.stringify({update_id:1})}).then(r=>{responded=true;return r;});
    await new Promise(r=>setTimeout(r,25));assert.equal(responded,false);
    release();assert.equal((await request).status,200);
  }finally{release();await new Promise(r=>server.close(r));}
});

test('webhook database failure returns 503 so Telegram can redeliver the update',async()=>{
  const {makeServer}=await import('../telegram/src/runtime.js');
  const server=makeServer({enqueue:async()=>{throw new Error('database unavailable');}},{mode:'webhook',secret:'z'.repeat(24)});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const r=await fetch(`http://127.0.0.1:${server.address().port}/telegram/webhook`,{method:'POST',headers:{'x-telegram-bot-api-secret-token':'z'.repeat(24)},body:'{"update_id":1}'});assert.equal(r.status,503);}
  finally{await new Promise(r=>server.close(r));}
});
