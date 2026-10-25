import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { config } from '../src/config.js';
import { splitPositions } from '../src/splitter.js';
const cases=[
 ['one complete position','ротбанд 30 кг 12 мешков',1],
 ['sentences with different materials','Ротбанд 30 кг 12 мешков. Саморезы 100 штук.',2],
 ['conjunction and three materials','цемент 20 мешков и песок 5 мешков и дюбель гвозди 50 штук',3],
 ['no punctuation between two orders','ротбанд 30 кг 12 мешков саморезы 100 штук',2],
 ['decimal size and count','саморезы 3,5х25 100 штук',1],
 ['size with spaces','саморезы 3.5 x 25 мм, 100 штук',1],
 ['package followed by count','ротбанд, штукатурка гипсовая, 30 кг, 12 мешков',1],
 ['same material twice with distinct quantities','цемент 20 мешков, цемент 5 мешков',2],
 ['three arbitrary text rows','новая деталь 3 штуки\nредкий материал 2 листа\nдругая позиция',3],
 ['numbered list','1. Цемент 20 мешков\n2) Песок 5 мешков',2],
 ['spoken explicit marker','ротбанд 30 кг 12 мешков следующая строка новый материал 2 штуки',2],
 ['unknown material after complete sentence','Цемент 20 мешков. Спецдеталь 3 штуки.',2],
 ['descriptive commas','грунтовка 10 литров, белая, для стен',1],
 ['quantity without product is continuation','ротбанд 30 кг. 12 мешков.',1],
 ['delivery instructions are not a product','цемент 20 мешков. Доставить завтра в 8.',1],
 ['list of known names without quantities','цемент, песок',2],
 ['semicolons','цемент 20 мешков; песок 5 мешков',2]
];
for(const [name,text,count] of cases)test(name,()=>assert.equal(splitPositions(text).length,count));
test('bounds reject whole message without truncating tail',()=>{
 assert.throws(()=>splitPositions(''),/message_length/);
 assert.throws(()=>splitPositions(Array(51).fill('деталь 1 штука').join('\n')),/message_length/);
 assert.throws(()=>splitPositions('а'.repeat(2001)),/message_length/);
});
function fixture(t,transcript='цемент 20 мешков и песок 5 мешков'){
 const s=new Store();t.after(()=>s.close());let id=0,calls=0;const e=new Engine(s,config({ALLOWED_USER_IDS:'1'},{requireSecrets:false}),{telegram:{download:async()=>Buffer.from('OggS')},transcriber:{transcribe:async()=>{calls++;return typeof transcript==='function'?transcript(calls):transcript;}}});
 const put=async(content)=>{const u={update_id:++id,message:{message_id:id,from:{id:1},chat:{id:1,type:'private'},...content}};e.enqueue([u]);await e.step();return u;};
 return {s,e,put,get calls(){return calls;}};
}
test('multi-line text is atomic, ordered and duplicate safe with per-part provenance',async t=>{
 const f=fixture(t);await f.put({text:'/new'});const u=await f.put({text:'цемент 20 мешков\nпесок 5 мешков\nдюбель гвозди 50 штук'});
 assert.equal(f.s.lines(1).length,3);assert.deepEqual(f.s.lines(1).map(x=>x.position),[1,2,3]);assert.equal(f.s.q('SELECT * FROM source_parts WHERE update_id=?',u.update_id).length,3);
 f.e.enqueue([u]);assert.equal(await f.e.step(),false);assert.equal(f.s.lines(1).length,3);assert.equal(f.calls,0);
});
test('voice list has one STT operation; each row parses its own quantity',async t=>{
 const f=fixture(t);await f.put({text:'/new'});await f.put({voice:{file_id:'x',duration:10}});
 assert.equal(f.calls,1);assert.deepEqual(f.s.lines(1).map(x=>JSON.parse(x.parsed).quantity),[20,5]);
});
test('manual split preserves first ID, inserts before later lines and can be merged back',async t=>{
 const f=fixture(t);await f.put({text:'/new'});await f.put({text:'сложная позиция'});await f.put({text:'гвозди 100 штук'});
 await f.put({text:'/split 1 цемент 20 мешков\nпесок 5 мешков'});
 const lines=f.s.lines(1);assert.deepEqual(lines.map(x=>x.id),[1,3,2]);assert.deepEqual(lines.map(x=>x.position),[1,2,3]);
 await f.put({text:'/merge 1 3'});assert.equal(f.s.lines(1).length,2);
});
test('reply clarification remains scoped to its target even if spoken text is a list',async t=>{
 const f=fixture(t);await f.put({text:'/new'});await f.put({text:'Исходный материал'});f.s.run('UPDATE outbox SET message_id=777 WHERE line_id=1');
 await f.put({voice:{file_id:'x',duration:10},reply_to_message:{message_id:777}});assert.equal(f.s.lines(1).length,1);assert.match(f.s.lines(1)[0].raw_text,/цемент 20 мешков и песок/);
});
test('over-capacity text batch leaves existing draft untouched',async t=>{
 const f=fixture(t);await f.put({text:'/new'});for(let i=0;i<199;i++)f.s.run("INSERT INTO lines(draft_id,position,raw_text,status) VALUES(1,?,?,'ready')",i+1,'материал');
 await f.put({text:'цемент 20 мешков\nпесок 5 мешков'});assert.equal(f.s.lines(1).length,199);assert.equal(f.s.q('SELECT * FROM source_parts').length,0);
});
test('failed multi-line STT retry creates rows only once',async t=>{
 const f=fixture(t,n=>{if(n===1)throw new Error('network');return 'цемент 20 мешков и песок 5 мешков';});await f.put({text:'/new'});
 const original=await f.put({voice:{file_id:'x',duration:10}});assert.equal(f.s.lines(1)[0].status,'failed');
 await f.put({text:'/retry 1'});assert.equal(f.s.lines(1).length,2);assert.equal(f.calls,2);
 f.e.enqueue([original]);assert.equal(await f.e.step(),false);assert.equal(f.s.lines(1).length,2);
});

test('unknown catalog products still split at explicit sentence boundaries with quantities',()=>{assert.equal(splitPositions('Спецдеталь 3 штуки. Неизвестная втулка 2 штуки.').length,2);});
test('glued units and polite list introduction are handled',()=>{assert.equal(splitPositions('Нужны цемент 20мешков и песок 5мешков').length,2);});
