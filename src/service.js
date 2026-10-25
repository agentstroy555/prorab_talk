import http from 'node:http';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import * as database from './db.js';
import {createApp,catalog} from '../server.js';
import {config} from '../telegram/src/config.js';
import {botToken} from '../telegram/src/bot-token.js';
import {Store} from '../telegram/src/store.js';
import {PostgresStore} from '../telegram/src/postgres-store.js';
import {Telegram,Transcriber} from '../telegram/src/clients.js';
import {Engine,VERSION} from '../telegram/src/engine.js';
import {runService} from '../telegram/src/runtime.js';

export function serviceConfig(env=process.env){
  const render=env.RENDER==='true';
  const token=botToken(env);
  const flag=env.TELEGRAM_ENABLED;
  if(flag!==undefined&&!['true','false'].includes(flag))throw new Error('TELEGRAM_ENABLED must be true or false');
  const port=Number(env.PORT||3000);
  if(!Number.isSafeInteger(port)||port<0||port>65535)throw new Error('Invalid PORT');
  // Render is the owner's production bot: legacy opt-out flags must not leave it web-only.
  const enabled=render||(flag===undefined?!!env.TELEGRAM_BOT_TOKEN:flag==='true');
  if(!enabled)return {port,telegram:null};
  const origin=env.RENDER_EXTERNAL_URL||env.BOT_PUBLIC_URL||'';
  const mode=render?'webhook':env.BOT_MODE||(origin?'webhook':'polling');
  const secret=env.WEBHOOK_SECRET||createHmac('sha256',token).update('parabtalk-webhook-v1').digest('hex');
  const telegram=config({...env,TELEGRAM_BOT_TOKEN:token,BOT_MODE:mode,WEBHOOK_SECRET:secret});
  telegram.storage=render||env.DATABASE_URL?'postgres':'sqlite';
  if(telegram.storage==='postgres'&&!env.DATABASE_URL)throw new Error('Set DATABASE_URL for Telegram PostgreSQL storage');
  if(telegram.storage==='sqlite'&&(!env.DB_PATH||!path.isAbsolute(env.DB_PATH)))throw new Error('Set an absolute DB_PATH for local SQLite storage, or use DATABASE_URL');
  if(mode==='webhook'&&origin){
    const url=new URL(origin);
    if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Set an HTTPS origin in BOT_PUBLIC_URL');
    telegram.webhookUrl=new URL('/telegram/webhook',url).href;
  }
  if(render&&!telegram.webhookUrl)throw new Error('Render must supply RENDER_EXTERNAL_URL for automatic webhook setup');
  return {port,telegram};
}

// One process and one listener. Injection is used only for local integration tests.
export async function startCombined({env=process.env,db=database,telegram,transcriber,onReady=()=>{},storeFactory}={}){
  const c=serviceConfig(env),abort=new AbortController();
  let store,ready=()=>false,stopping=false;
  const botStatus=()=>({enabled:!!c.telegram,...(c.telegram?{ready:!stopping&&ready()}:{} )});
  const app=createApp({db,botStatus});
  try{
    await db.initDb(catalog);
    if(c.telegram){
      if(storeFactory)store=await storeFactory(c.telegram);
      else if(c.telegram.storage==='postgres'){
        store=new PostgresStore({connectionString:env.DATABASE_URL,ssl:env.PGSSL==='true'?{rejectUnauthorized:false}:undefined});
        await store.init();
      }else store=new Store(c.telegram.dbPath,{recover:false});
      telegram??=new Telegram(c.telegram.token,{signal:abort.signal});
      await telegram.call('getMe');
      const webhook=await telegram.call('getWebhookInfo');
      if(c.telegram.mode==='polling'&&webhook.url)throw new Error('Webhook is active; remove it explicitly before polling');
      const engine=new Engine(store,c.telegram,{telegram,transcriber:transcriber??new Transcriber(store,c.telegram,{signal:abort.signal})});
      await runService(engine,telegram,c.telegram,{
        requestHandler:app,
        onStopping:()=>{stopping=true;abort.abort();},
        onReady:async({server,stop,isReady})=>{
          if(c.telegram.webhookUrl)await telegram.call('setWebhook',{
            url:c.telegram.webhookUrl,secret_token:c.telegram.secret,
            allowed_updates:['message','callback_query'],max_connections:1,drop_pending_updates:false
          });
          ready=isReady;
          console.log(JSON.stringify({event:'service.ready',version:VERSION.version,build:VERSION.build,web:true,telegram:c.telegram.mode,storage:c.telegram.storage}));
          await onReady({server,stop,engine});
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
    abort.abort();await store?.close();await db.closeDb();
  }
}
