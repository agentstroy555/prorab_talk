import { Store } from '../src/store.js';
import { config } from '../src/config.js';
import { Engine } from '../src/engine.js';
const s=new Store(),c=config({},{requireSecrets:false});
const engine=new Engine(s,c,{telegram:{download:async()=>Buffer.from('OggS-demo')},transcriber:{transcribe:async()=>'ротбанд 30 кг 12 мешков'}});
let id=0;
for(const content of [{text:'/new Объект Север'},{voice:{file_id:'fixture',duration:4}},{text:'/qty 1 15 мешок'},{text:'/finish'}]){
  engine.enqueue([{update_id:++id,message:{message_id:id,from:{id:1},chat:{id:1,type:'private'},...content}}]);await engine.step();
}
for(const e of s.q('SELECT * FROM outbox ORDER BY id')){const p=JSON.parse(e.payload);console.log(p.text||'[FILE] '+p._document.name);}
console.log('DEMO ONLY: Telegram and STT are mocks, no external API calls.');s.close();
