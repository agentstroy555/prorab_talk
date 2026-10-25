import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { config } from '../src/config.js';
import {DEFAULT_BOT_TOKEN} from '../src/bot-token.js';
import { Engine } from '../src/engine.js';
import { Telegram, Transcriber, RemoteError, limitedBody } from '../src/clients.js';
import { deliverOne, claimLease, makeServer, runService } from '../src/runtime.js';
import { exportDraft } from '../src/export.js';
const c=()=>config({},{requireSecrets:false});
const update=(id,text='/new')=>({update_id:id,message:{message_id:id,from:{id:1},chat:{id:1,type:'private'},text}});
function store(t){const s=new Store();t.after(()=>s.close());return s;}
function path(t){const dir=mkdtempSync(resolve('test/.tmp-'));t.after(()=>rmSync(dir,{force:true,recursive:true}));return dir+'/data.sqlite';}
test('configuration requires API secrets and validates numeric bounds',()=>{
  assert.throws(()=>config({}));assert.throws(()=>config({STT_REQUESTS_PER_MINUTE:'0'},{requireSecrets:false}));
});
test('inbox and draft survive restart; done updates remain deduplicated',async t=>{
  const file=path(t);let s=new Store(file);let e=new Engine(s,c());e.enqueue([update(1),update(2,'цемент 12 мешков')]);await e.step();s.close();
  s=new Store(file);t.after(()=>s.close());e=new Engine(s,c());await e.step();assert.equal(s.lines(1)[0].raw_text,'цемент 12 мешков');e.enqueue([update(2,'OTHER')]);assert.equal(await e.step(),false);assert.equal(s.lines(1).length,1);
});
test('inbox overflow rolls back entire batch and offset',t=>{
  const s=store(t);assert.throws(()=>s.enqueue([update(1),update(2)],1));assert.equal(s.q('SELECT * FROM inbox').length,0);assert.equal(s.get('offset','0'),'0');
});
test('STT budget reservations persist, include failures and block ambiguous same attempt',t=>{
  const s=store(t),cfg={...c(),rpm:1};s.reserve('a',3,cfg,100000);assert.throws(()=>s.reserve('a',3,cfg,100001),/uncertain/);assert.throws(()=>s.reserve('b',3,cfg,100001),/budget/);s.reserve('b',3,cfg,161000);assert.equal(s.q('SELECT * FROM stt_attempts').length,2);
});
test('STT daily seconds and cooldown limit before any request',t=>{
  const s=store(t),cfg={...c(),audioPerDay:5};s.reserve('a',4,cfg,100000);assert.throws(()=>s.reserve('b',4,cfg,161000),/budget/);s.set('groq_cooldown',200000);assert.throws(()=>s.reserve('c',1,cfg,199999),/cooldown/);
});
test('Groq receives OGG and Russian model; content cache avoids a second external call',async t=>{
  const s=store(t);let calls=0;const stt=new Transcriber(s,c(),{fetcher:async(url,options)=>{
    calls++;assert.match(url,/api.groq.com/);assert.equal(options.body.get('language'),'ru');assert.equal(options.body.get('model'),'whisper-large-v3-turbo');assert.equal(options.body.get('file').name,'voice.ogg');assert.equal(options.body.get('file').type,'audio/ogg');assert.ok(options.signal);
    return new Response(JSON.stringify({text:'цемент 5 мешков'}));}});
  assert.equal(await stt.transcribe(Buffer.from('OggSbytes'),3,'a'),'цемент 5 мешков');await stt.transcribe(Buffer.from('OggSbytes'),3,'b');assert.equal(calls,1);assert.equal(s.q('SELECT * FROM stt_attempts').length,1);
});
test('upstream 429 sets shared cooldown; no automatic STT retry',async t=>{
  const s=store(t);let calls=0;const stt=new Transcriber(s,c(),{now:()=>100000,fetcher:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});}});
  await assert.rejects(stt.transcribe(Buffer.from('OggS1'),3,'a'),e=>e.code==='groq_rate_limit');await assert.rejects(stt.transcribe(Buffer.from('OggS2'),3,'b'),/cooldown/);assert.equal(calls,1);assert.equal(s.get('groq_cooldown'),'220000');
});
test('interrupted STT is not silently replayed after process restart',async t=>{
  const file=path(t);let s=new Store(file);s.reserve('1:0',3,c());s.close();s=new Store(file);t.after(()=>s.close());let calls=0;
  const stt=new Transcriber(s,c(),{fetcher:async()=>{calls++;return new Response('{"text":"x"}');}});
  await assert.rejects(stt.transcribe(Buffer.from('OggS'),3,'1:0'),/uncertain/);assert.equal(calls,0);
});
test('recorded transcript recovers voice job without another download or STT',async t=>{
  const s=store(t),e=new Engine(s,c(),{telegram:{download:async()=>{throw new Error('must not download');}}});
  e.enqueue([update(1)]);await e.step();
  const v={update_id:2,message:{from:{id:1},chat:{id:1,type:'private'},voice:{file_id:'x',duration:3}}};e.enqueue([v]);
  s.run('INSERT INTO lines(draft_id,position,source_update) VALUES(1,1,2)');s.run("INSERT INTO voice_jobs(id,line_id,voice,kind,transcript) VALUES(2,1,?,'new',?)",JSON.stringify(v.message.voice),'цемент 5 мешков');await e.step();assert.equal(s.lines(1)[0].raw_text,'цемент 5 мешков');
});
test('unknown Telegram send result is marked uncertain, not resent automatically',async t=>{
  const s=store(t);s.tx(()=>s.emit(1,[{payload:{chat_id:1,text:'saved'}}]));let sends=0;const tg={call:async()=>{sends++;throw new RemoteError('telegram_transport');}};
  await deliverOne(s,tg);assert.equal(await deliverOne(s,tg),false);assert.equal(sends,1);assert.equal(s.one('SELECT status FROM outbox').status,'uncertain');
});
test('known Telegram 429 retries only after Retry-After and preserves reply mapping',async t=>{
  const s=store(t);s.tx(()=>s.emit(1,[{lineId:12,payload:{chat_id:1,text:'line'}}]));let sends=0;const tg={call:async()=>{if(++sends===1)throw new RemoteError('rate',{status:429,retryAfter:2});return {message_id:123};}};
  await deliverOne(s,tg,1000);assert.equal(await deliverOne(s,tg,2000),false);await deliverOne(s,tg,3000);assert.equal(s.one('SELECT message_id FROM outbox').message_id,123);
});
test('sending-state crash recovery does not resend unknown delivery',t=>{
  const file=path(t);let s=new Store(file);s.tx(()=>s.emit(1,[{payload:{chat_id:1,text:'x'}}]));s.run("UPDATE outbox SET status='sending'");s.close();s=new Store(file);assert.equal(s.one('SELECT status FROM outbox').status,'uncertain');s.close();
});
test('download has size/container/path guards; errors do not expose Telegram token',async()=>{
  const token='123:FAKE_SECRET_FOR_TEST_ONLY';let calls=0;const tg=new Telegram(token,{fetcher:async(url)=>{calls++;if(url.includes('/getFile'))return new Response('{"ok":true,"result":{"file_path":"voice/file.oga","file_size":8}}');return new Response('notaudio');}});
  await assert.rejects(tg.download({file_id:'x'},100),e=>e.code==='invalid_ogg'&&!e.message.includes(token));assert.equal(calls,2);
  const broken=new Telegram(token,{fetcher:async()=>{throw new Error(`network failure https://host/bot${token}/`);}});await assert.rejects(broken.call('getMe'),e=>!e.message.includes(token));
});
test('oversized streamed body is rejected, regardless of supplied size metadata',async()=>{
  await assert.rejects(limitedBody(new Response('1234567890'),4),e=>e.code==='file_too_large');
});
test('CSV fields prevent spreadsheet formula injection; JSON preserves exact original text',()=>{
  const e=exportDraft({id:1},[{id:2,raw_text:'=HYPERLINK("x")',parsed:'{}',status:'ready'}],{});assert.ok(e.csv.includes("'=HYPERLINK"));assert.equal(JSON.parse(e.json).items[0].text,'=HYPERLINK("x")');
});
test('single instance lease prevents competing workers from recovering same database',async t=>{
  const s=store(t);assert.equal(await claimLease(s,'A',1000),true);assert.equal(await claimLease(s,'B',1001),false);assert.equal(await claimLease(s,'B',61001),true);
});
test('webhook authenticates before durable enqueue and deduplicates retries over HTTP',async t=>{
  const s=store(t),cfg={...c(),mode:'webhook',secret:'a'.repeat(24)},e=new Engine(s,cfg),server=makeServer(e,cfg);
  await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}/telegram/webhook`,body=JSON.stringify(update(1));
  assert.equal((await fetch(url,{method:'POST',body})).status,403);
  const headers={'x-telegram-bot-api-secret-token':cfg.secret};for(let i=0;i<2;i++)assert.equal((await fetch(url,{method:'POST',body,headers})).status,200);
  assert.equal(s.q('SELECT * FROM inbox').length,1);assert.equal((await fetch(url.replace('/telegram/webhook','/health'))).status,200);
});
test('service starts and gracefully stops with no token and fake adapters in webhook test mode',async t=>{
  const s=store(t),cfg={...c(),mode:'webhook',secret:'a'.repeat(24),port:0},e=new Engine(s,cfg);
  let health;
  await runService(e,{call:async()=>({message_id:1})},cfg,{onReady:({server,stop})=>{health=server.address().port;setTimeout(stop,10);}});
  assert.ok(health>0);assert.equal(s.get('runtime_lease'),'null');
});
test('download preflight blocks oversized file and unsafe file paths before fetching bytes',async()=>{
  let count=0;const tg=new Telegram('fake',{fetcher:async()=>{count++;return new Response('{"ok":true,"result":{"file_path":"../secret","file_size":8}}');}});
  await assert.rejects(tg.download({file_id:'x'},100),e=>e.code==='invalid_file_path');assert.equal(count,1);
  const large=new Telegram('fake',{fetcher:async()=>new Response('{"ok":true,"result":{"file_path":"voice/file.oga","file_size":999}}')});
  await assert.rejects(large.download({file_id:'x'},100),e=>e.code==='file_too_large');
});
test('outbox backlog applies ingress backpressure instead of growing indefinitely',t=>{
  const s=store(t);s.tx(()=>s.emit(10,[{payload:{chat_id:1,text:'a'}},{payload:{chat_id:1,text:'b'}}]));
  assert.throws(()=>s.enqueue([update(1)],2),/Inbox full/);assert.equal(s.q('SELECT * FROM inbox').length,0);
});
test('interrupted explicit retry resumes same attempt key, rather than authorizing another STT',async t=>{
  const file=path(t);let s=new Store(file),e=new Engine(s,c());e.enqueue([update(1)]);await e.step();
  s.run('INSERT INTO lines(draft_id,position,source_update,status) VALUES(1,1,2,?)','failed');
  s.run("INSERT INTO voice_jobs(id,line_id,voice,kind,status,attempt) VALUES(2,1,?,'new','pending',1)",JSON.stringify({file_id:'x',duration:3}));
  e.enqueue([update(3,'/retry 1')]);s.run("UPDATE inbox SET status='processing' WHERE id=3");s.set('retry:3',2);s.reserve('2:1',3,c());s.close();
  s=new Store(file);t.after(()=>s.close());let calls=0;
  e=new Engine(s,c(),{telegram:{download:async()=>Buffer.from('OggS-retry')},transcriber:new Transcriber(s,c(),{fetcher:async()=>{calls++;return new Response('{"text":"x"}');}})});
  await e.step();assert.equal(calls,0);assert.equal(s.one('SELECT attempt FROM voice_jobs').attempt,1);assert.equal(s.one('SELECT error FROM voice_jobs').error,'uncertain');
});
test('schema v1 upgrade preserves existing rows and backfills message provenance',t=>{
  const file=path(t);let s=new Store(file);
  s.run("INSERT INTO drafts(user_id,chat_id,title) VALUES('1','1','Legacy')");
  s.run("INSERT INTO lines(draft_id,position,raw_text,status,source_update) VALUES(1,1,'цемент 10 мешков','ready',77)");
  s.db.exec('DROP TABLE source_parts');s.set('schema_version','1');s.close();
  s=new Store(file);assert.equal(s.get('schema_version'),'2');assert.equal(s.lines(1)[0].raw_text,'цемент 10 мешков');assert.equal(s.one('SELECT line_id FROM source_parts WHERE update_id=77').line_id,1);s.close();
});
test('owner-authorized embedded token is the default and an environment token can override it',()=>{
  const base={GROQ_API_KEY:'mock-key'};
  assert.ok(config(base).token===DEFAULT_BOT_TOKEN);
  const replacement='123456:TEST_OVERRIDE_FOR_LOCAL_TEST_ONLY';
  assert.equal(config({...base,TELEGRAM_BOT_TOKEN:replacement}).token,replacement);
});

test('public config starts with API credentials only and ignores obsolete allowlist settings',()=>{
  const env={TELEGRAM_BOT_TOKEN:'123456:FAKE_TOKEN_FOR_LOCAL_TESTS_ONLY',GROQ_API_KEY:'mock'};
  assert.equal(config(env).mode,'polling');
  assert.equal(config({...env,ALLOWED_USER_IDS:'1'}).allowed,undefined);
});
test('public ingress accepts any valid private user but rejects missing, invalid or mismatched identities',t=>{
  const s=store(t);
  const privateUpdate=(id,user,chat=user)=>({update_id:id,message:{from:{id:user},chat:{id:chat,type:'private'},text:'/new'}});
  s.enqueue([privateUpdate(1,987654321),privateUpdate(2,123456789),privateUpdate(3,0),privateUpdate(4,undefined),privateUpdate(5,99,98),privateUpdate(6,'99')],10);
  assert.deepEqual(s.q('SELECT id FROM inbox ORDER BY id').map(x=>x.id),[1,2]);
});
