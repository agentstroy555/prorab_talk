import http from 'node:http';
import path from 'node:path';
import * as database from './db.js';
import {createApp,catalog} from '../server.js';
import {config} from '../telegram/src/config.js';
import {Store} from '../telegram/src/store.js';
import {Telegram,Transcriber} from '../telegram/src/clients.js';
import {Engine,VERSION} from '../telegram/src/engine.js';
import {runService} from '../telegram/src/runtime.js';

export function serviceConfig(env=process.env){
  const flag=env.TELEGRAM_ENABLED||'false';
  if(!['true','false'].includes(flag))throw new Error('TELEGRAM_ENABLED must be true or false');
  const port=Number(env.PORT||3000);
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('Invalid PORT');
  if(flag==='false')return {port,telegram:null};
  const telegram=config(env);
  if(!env.DB_PATH||!path.isAbsolute(env.DB_PATH))throw new Error('Set an absolute DB_PATH on a persistent disk before enabling Telegram');
  return {port,telegram};
}

// One process and one listener. Injection is used only for local integration tests.
export async function startCombined({env=process.env,db=database,telegram,transcriber,onReady=()=>{}}={}){
  const c=serviceConfig(env),abort=new AbortController();
  let store,ready=()=>false,stopping=false;
  const botStatus=()=>({enabled:!!c.telegram,...(c.telegram?{ready:!stopping&&ready()}:{} )});
  const app=createApp({db,botStatus});
  try{
    await db.initDb(catalog);
    if(c.telegram){
      store=new Store(c.telegram.dbPath,{recover:false});
      telegram??=new Telegram(c.telegram.token,{signal:abort.signal});
      await telegram.call('getMe');
      const webhook=await telegram.call('getWebhookInfo');
      if(c.telegram.mode==='polling'&&webhook.url)throw new Error('Webhook is active; remove it explicitly before polling');
      const engine=new Engine(store,c.telegram,{telegram,transcriber:transcriber??new Transcriber(store,c.telegram,{signal:abort.signal})});
      await runService(engine,telegram,c.telegram,{
        requestHandler:app,
        onStopping:()=>{stopping=true;abort.abort();},
        onReady:({server,stop,isReady})=>{
          ready=isReady;
          console.log(JSON.stringify({event:'service.ready',version:VERSION.version,build:VERSION.build,web:true,telegram:c.telegram.mode}));
          onReady({server,stop,engine});
        }
      });
    }else{
      const server=http.createServer(app);
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.port,'0.0.0.0',resolve);});
      await new Promise((resolve,reject)=>{
        const stop=()=>{stopping=true;server.close(error=>error?reject(error):resolve());};
        process.once('SIGTERM',stop);process.once('SIGINT',stop);
        server.once('close',()=>{process.off('SIGTERM',stop);process.off('SIGINT',stop);});
        console.log(JSON.stringify({event:'service.ready',version:VERSION.version,build:VERSION.build,web:true,telegram:false}));
        try{onReady({server,stop});}catch(error){stop();reject(error);}
      });
    }
  }finally{
    abort.abort();store?.close();await db.closeDb();
  }
}
