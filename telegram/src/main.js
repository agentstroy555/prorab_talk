import { config } from './config.js';
import { Store } from './store.js';
import { Telegram, Transcriber } from './clients.js';
import { Engine, VERSION } from './engine.js';
import { runService } from './runtime.js';
let store;
try{
  const c=config();
  store=new Store(c.dbPath,{recover:false});
  const telegram=new Telegram(c.token);
  // Read-only verification. Registration/changing webhooks is an explicit deployment step.
  await telegram.call('getMe');
  const webhook=await telegram.call('getWebhookInfo');
  if(c.mode==='polling'&&webhook.url)throw new Error('A webhook is active; remove it explicitly before polling');
  const engine=new Engine(store,c,{telegram,transcriber:new Transcriber(store,c)});
  await runService(engine,telegram,c,{onReady:()=>console.log(JSON.stringify({event:'service.ready',version:VERSION.version,build:VERSION.build,mode:c.mode}))});
}catch(error){
  const safe=error.code||'startup_or_runtime_error';
  console.error(JSON.stringify({event:'service.failed',code:safe}));
  console.error('Check environment, single-instance deployment and webhook mode. See docs/DEPLOYMENT.md.');
  process.exitCode=1;
}finally{store?.close();}
