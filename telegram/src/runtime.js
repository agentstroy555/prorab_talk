import http from 'node:http';
import { privateUserContext } from './updates.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function claimLease(s,owner,now=Date.now()){
  return s.tx(()=>{
    const lease=JSON.parse(s.get('runtime_lease','null'));
    if(lease&&lease.owner!==owner&&lease.until>now)return false;
    s.set('runtime_lease',JSON.stringify({owner,until:now+60000}));return true;
  });
}
export async function deliverOne(s,telegram,now=Date.now()){
  const e=s.one("SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 1",now);if(!e)return false;
  s.run("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=?",e.id);
  try{
    const result=await telegram.call(e.method,JSON.parse(e.payload));
    s.run("UPDATE outbox SET status='delivered',message_id=? WHERE id=?",result?.message_id??null,e.id);
  }catch(error){
    // A 429 is known not to have sent the message; an unknown network result is not safe to replay.
    const retry=error.status===429&&e.attempts<5;
    s.run('UPDATE outbox SET status=?,next_at=? WHERE id=?',retry?'pending':error.status?'failed':'uncertain',now+Math.max(1,error.retryAfter||5)*1000,e.id);
    console.error(JSON.stringify({event:'delivery.failed',outboxId:e.id,status:error.status||0,retry}));
  }
  return true;
}
export function makeServer(engine,c,{ready=()=>true,requestHandler}={}){
  return http.createServer(async(req,res)=>{
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(!requestHandler&&req.url==='/health'&&req.method==='GET'){reply(ready()?200:503,{ok:ready()});return;}
    if(req.url?.split('?')[0]!=='/telegram/webhook'){if(requestHandler){requestHandler(req,res);return;}reply(404,{ok:false});return;}
    if(req.url!=='/telegram/webhook'||req.method!=='POST'||c.mode!=='webhook'){reply(404,{ok:false});return;}
    const sent=Buffer.from(String(req.headers['x-telegram-bot-api-secret-token']||'')),expected=Buffer.from(c.secret);
    if(!expected.length||sent.length!==expected.length||!timingSafeEqual(sent,expected)){reply(403,{ok:false});return;}
    if(!ready()){reply(503,{ok:false});return;}
    try{
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>256000){reply(413,{ok:false});return;}chunks.push(chunk);}
      const update=JSON.parse(Buffer.concat(chunks).toString());
      engine.enqueue([update]);reply(200,{ok:true});
      if(update.callback_query&&privateUserContext(update))void engine.telegram?.call?.('answerCallbackQuery',{callback_query_id:update.callback_query.id},3000).catch(()=>{});
    }catch(error){reply(error.message==='Inbox full'?503:400,{ok:false});}
  });
}
export async function runService(engine,telegram,c,{onReady=()=>{},onStopping=()=>{},requestHandler}={}){
  const s=engine.s,owner=randomUUID();
  // Same-disk lease; run only one replica. A crashed instance's lease expires within 60 seconds.
  const started=Date.now();
  while(!claimLease(s,owner)){if(Date.now()-started>65000)throw new Error('Another service instance owns this database');await sleep(1000);}
  s.db.exec("UPDATE inbox SET status='pending' WHERE status='processing';UPDATE outbox SET status='uncertain' WHERE status='sending';");
  let stopping=false,leaseOk=true;
  const server=makeServer(engine,c,{ready:()=>leaseOk&&!stopping,requestHandler});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(c.port,'0.0.0.0',resolve);});
  const heartbeat=setInterval(()=>{try{leaseOk=claimLease(s,owner);if(!leaseOk)stopping=true;}catch{leaseOk=false;stopping=true;}},10000);
  let outboundActive=false;
  const outgoing=(async()=>{while(!stopping){outboundActive=await deliverOne(s,telegram);await sleep(outboundActive?1100:150);}})();
  const worker=(async()=>{while(!stopping){if(!await engine.step())await sleep(100);}})();
  const poller=(async()=>{
    if(c.mode!=='polling')return;
    while(!stopping){
      try{
        const n=s.one("SELECT count(*) AS n FROM inbox WHERE status!='done'").n+s.one("SELECT count(*) AS n FROM outbox WHERE status IN ('pending','sending')").n;
        if(n>=c.maxPending){await sleep(1000);continue;}
        const updates=await telegram.call('getUpdates',{offset:Number(s.get('offset','0')),limit:Math.min(100,c.maxPending-n),timeout:25,allowed_updates:['message','callback_query']},35000);
        if(!Array.isArray(updates))throw new Error('Bad updates');
        engine.enqueue(updates.sort((a,b)=>a.update_id-b.update_id));
        for(const u of updates){if(u.callback_query&&privateUserContext(u))void telegram.call('answerCallbackQuery',{callback_query_id:u.callback_query.id},3000).catch(()=>{});}
      }catch(e){if(stopping)break;console.error(JSON.stringify({event:'poll.failed',status:e.status||0}));await sleep(Math.max(2,Math.min(60,e.retryAfter||3))*1000);}
    }
  })();
  const stop=()=>{stopping=true;onStopping();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{onReady({server,stop,isReady:()=>leaseOk&&!stopping});await Promise.all([worker,poller,outgoing]);}
  finally{
    stopping=true;onStopping();clearInterval(heartbeat);
    await Promise.allSettled([worker,poller,outgoing]);process.off('SIGTERM',stop);process.off('SIGINT',stop);
    await new Promise(r=>server.close(r));
    s.tx(()=>{const lease=JSON.parse(s.get('runtime_lease','null'));if(lease?.owner===owner)s.set('runtime_lease','null');});
  }
}
