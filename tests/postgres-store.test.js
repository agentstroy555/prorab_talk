import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {PostgresStore} from '../telegram/src/postgres-store.js';
import {Engine} from '../telegram/src/engine.js';
import {config} from '../telegram/src/config.js';
import {claimLease,deliverOne} from '../telegram/src/runtime.js';
import {Transcriber} from '../telegram/src/clients.js';

// CI uses a real PostgreSQL service. An injected local PostgreSQL test driver is
// supported for environments without a server binary; never use production URLs.
const factory=process.env.POSTGRES_TEST_FACTORY?await import(pathToFileURL(process.env.POSTGRES_TEST_FACTORY)):null;
const enabled=!!(process.env.TEST_DATABASE_URL||factory);
const options={skip:!enabled};
after(async()=>{await factory?.shutdown?.();});
async function store(t,{reset=true,autoClose=true}={}){
  const s=new PostgresStore(factory?{pool:await factory.createPool()}:{connectionString:process.env.TEST_DATABASE_URL});
  if(reset)await s.pool.query('DROP SCHEMA IF EXISTS telegram CASCADE');
  await s.init();if(autoClose)t.after(()=>s.close());return s;
}
const cfg=()=>config({},{requireSecrets:false});
const update=(id,text,user=1)=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},text}});
async function put(e,id,text,user=1){await e.enqueue([update(id,text,user)]);assert.equal(await e.step(),true);}

test('PostgreSQL runs estimates, split/merge, JSON reply lookup, isolation, finish and export',options,async t=>{
  const s=await store(t),e=new Engine(s,cfg());
  await put(e,1,'/new Test');await put(e,2,'цемент 12 мешков; кирпич 20 штук');
  assert.equal((await s.lines(1)).length,2);
  await s.run('UPDATE outbox SET message_id=123 WHERE line_id=?',1);
  await e.enqueue([{update_id:3,message:{from:{id:1},chat:{id:1,type:'private'},text:'ещё пять мешков',reply_to_message:{message_id:123}}}]);await e.step();
  assert.match((await s.line(1,1)).raw_text,/ещё пять/);
  await put(e,4,'/qty 1 15 мешок');assert.equal(JSON.parse((await s.line(1,1)).parsed).quantity,15);
  await put(e,5,'/new Private',2);await put(e,6,'/edit 1 украдено',2);
  assert.doesNotMatch((await s.line(1,1)).raw_text,/украдено/);
  await put(e,7,'/merge 1 2');assert.equal((await s.lines(1)).length,1);
  await put(e,8,'/split 1 цемент 3 мешка; кирпич 4 штуки');assert.equal((await s.lines(1)).length,2);
  await put(e,9,'/finish');assert.equal((await s.one('SELECT status FROM drafts WHERE id=?',1)).status,'finished');
  assert.equal((await s.q("SELECT * FROM outbox WHERE method='sendDocument'")).length,2);
});

test('PostgreSQL restarts preserve drafts, STT reservations, cache and deduplication',options,async t=>{
  let s=await store(t),calls=0;
  const transcript=async()=>{calls++;return 'цемент 3 мешка; кирпич 4 штуки';};
  const tg={download:async()=>Buffer.from('OggSbytes')};
  let e=new Engine(s,cfg(),{telegram:tg,transcriber:{transcribe:transcript}});
  await put(e,1,'/new Test');
  const voice={update_id:2,message:{from:{id:1},chat:{id:1,type:'private'},voice:{file_id:'x',duration:3}}};
  await e.enqueue([voice]);await e.step();assert.equal(calls,1);
  await s.reserve('uncertain:0',3,cfg());
  await s.close();s=await store(t,{reset:false});e=new Engine(s,cfg(),{telegram:tg,transcriber:{transcribe:transcript}});
  await e.enqueue([voice]);assert.equal(await e.step(),false);assert.equal(calls,1);assert.equal((await s.lines(1)).length,2);
  await assert.rejects(s.reserve('uncertain:0',3,cfg()),/uncertain/);
  assert.equal((await s.active(1,1)).title,'Test');
});

test('PostgreSQL async transaction rolls back all line changes and completion effects',options,async t=>{
  const s=await store(t),e=new Engine(s,cfg());await put(e,1,'/new Test');
  await assert.rejects(s.tx(async()=>{await s.run("INSERT INTO lines(draft_id,position,raw_text) VALUES(1,1,'temporary')");await s.emit(123,[{payload:{chat_id:1,text:'must rollback'}}]);throw new Error('abort');}),/abort/);
  assert.equal((await s.lines(1)).length,0);assert.equal((await s.q('SELECT * FROM outbox WHERE update_id=?',123)).length,0);
});

test('PostgreSQL concurrent admission deduplicates updates and reserves STT budget atomically',options,async t=>{
  const a=await store(t),b=await store(t,{reset:false}),u=update(1,'/new');
  await Promise.all([a.enqueue([u],10),b.enqueue([u],10)]);
  assert.equal((await a.one('SELECT count(*) AS n FROM inbox')).n,1);
  const c={...cfg(),rpm:1};
  const r=await Promise.allSettled([a.reserve('a',3,c,100000),b.reserve('b',3,c,100000)]);
  assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.filter(x=>x.status==='rejected').length,1);
  assert.equal((await a.one('SELECT count(*) AS n FROM stt_attempts')).n,1);
});

test('PostgreSQL batch overflow rolls back its entire inbox batch and offset',options,async t=>{
  const s=await store(t);await assert.rejects(s.enqueue([update(1,'/new'),update(2,'цемент')],1),/Inbox full/);
  assert.equal((await s.q('SELECT * FROM inbox')).length,0);assert.equal(await s.get('offset','0'),'0');
});

test('PostgreSQL recovery keeps uncertain sends and leases block overlapping workers',options,async t=>{
  const a=await store(t),b=await store(t,{reset:false});
  assert.equal(await claimLease(a,'old',1000),true);assert.equal(await claimLease(b,'new',1001),false);
  assert.equal(await claimLease(b,'new',61001),true);
  await a.tx(()=>a.emit(1,[{payload:{chat_id:1,text:'saved'}}]));
  await a.run("UPDATE outbox SET status='sending'");await b.recover();
  assert.equal((await b.one('SELECT status FROM outbox')).status,'uncertain');
  assert.equal(await deliverOne(b,{call:async()=>{throw new Error('must not send');}}),false);
});

test('PostgreSQL Groq result cache and reservation are durable before any subsequent request',options,async t=>{
  const s=await store(t);let calls=0;
  const transcriber=new Transcriber(s,cfg(),{fetcher:async()=>{calls++;return new Response('{"text":"цемент 3 мешка"}');}});
  assert.equal(await transcriber.transcribe(Buffer.from('OggSbytes'),3,'a'),'цемент 3 мешка');
  assert.equal(await transcriber.transcribe(Buffer.from('OggSbytes'),3,'b'),'цемент 3 мешка');
  assert.equal(calls,1);assert.equal((await s.one('SELECT count(*) AS n FROM stt_attempts')).n,1);
  assert.equal((await s.one('SELECT status FROM stt_attempts WHERE key=?','a')).status,'complete');
});

test('combined HTTP webhook uses PostgreSQL without any local disk and processes a voice list',options,async t=>{
  const {startCombined,serviceConfig}=await import('../src/service.js');
  const s=await store(t,{autoClose:false});let controls,stt=0;const methods=[];
  const env={PORT:'0',RENDER:'true',RENDER_EXTERNAL_URL:'https://example.onrender.com',DATABASE_URL:process.env.TEST_DATABASE_URL||'postgresql://unused/local-test',TELEGRAM_BOT_TOKEN:'123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY',GROQ_API_KEY:'mock',DB_PATH:'/not-mounted/ignored.sqlite',BOT_MODE:'polling'};
  const tg={call:async(method,payload)=>{methods.push({method,payload});return method==='getWebhookInfo'?{url:''}:{message_id:111};},download:async()=>Buffer.from('OggS-fixture')};
  const db={initDb:async()=>{},healthcheck:async()=>true,closeDb:async()=>{}};
  let running;
  await new Promise((resolve,reject)=>{running=startCombined({env,db,telegram:tg,transcriber:{transcribe:async()=>{stt++;return 'цемент 12 мешков; кирпич 20 штук';}},storeFactory:async()=>s,onReady:c=>{controls=c;resolve();}});running.catch(reject);});
  t.after(async()=>{controls.stop();await running;});
  const url=`http://127.0.0.1:${controls.server.address().port}`;
  const post=u=>fetch(url+'/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':serviceConfig(env).telegram.secret},body:JSON.stringify(u)});
  async function until(check){const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)throw new Error('worker timeout');await new Promise(r=>setTimeout(r,10));}}
  assert.equal((await post(update(1,'/new Test'))).status,200);
  await until(async()=>!!await s.active(1,1));
  const voice={update_id:2,message:{from:{id:1},chat:{id:1,type:'private'},voice:{file_id:'mock',duration:3}}};
  assert.equal((await post(voice)).status,200);
  await until(async()=>(await s.lines(1)).length===2);
  assert.equal((await post(voice)).status,200);assert.equal(stt,1);
  const health=await (await fetch(url+'/api/health')).json();assert.equal(health.ok,true);assert.equal(health.telegram.ready,true);
  assert.ok(methods.some(x=>x.method==='setWebhook'));assert.ok(methods.every(x=>x.method!=='getUpdates'));
});

test('rolling deployment standby accepts webhook before obtaining worker leadership',options,async t=>{
  const {runService}=await import('../telegram/src/runtime.js');
  const a=await store(t,{autoClose:false}),b=await store(t,{reset:false,autoClose:false});
  const c={...cfg(),mode:'webhook',secret:'z'.repeat(24),port:0};
  const tg={call:async()=>({message_id:1})};
  const controls=[],runs=[];
  t.after(async()=>{for(const x of controls)x.stop();await Promise.allSettled(runs);await a.close();await b.close();});
  async function start(s){await new Promise((resolve,reject)=>{const r=runService(new Engine(s,c),tg,c,{onReady:x=>{controls.push(x);resolve();}});runs.push(r);r.catch(reject);});return controls.at(-1);}
  const old=await start(a),next=await start(b);
  assert.equal(next.isReady(),true);
  const url=`http://127.0.0.1:${next.server.address().port}`;
  const post=u=>fetch(url+'/telegram/webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':c.secret},body:JSON.stringify(u)});
  assert.equal((await post(update(1,'/new Rolling'))).status,200);
  async function until(check){const deadline=Date.now()+15000;while(!await check()){if(Date.now()>deadline)throw new Error('handover timed out');await new Promise(r=>setTimeout(r,25));}}
  await until(async()=>!!await a.active(1,1));old.stop();await runs[0];
  assert.equal((await post(update(2,'цемент 3 мешка'))).status,200);
  await until(async()=>(await b.lines(1)).length===1);
  assert.equal((await b.one('SELECT count(*) AS n FROM drafts')).n,1);
});
