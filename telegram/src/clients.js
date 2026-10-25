import { createHash } from 'node:crypto';
export class RemoteError extends Error {
  constructor(code, { status = 0, retryAfter = 0 } = {}) { super(code); this.code=code;this.status=status;this.retryAfter=retryAfter; }
}
export async function limitedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new RemoteError('file_too_large'); }
  const chunks=[];let size=0;
  if (!response.body) throw new RemoteError('empty_file');
  const reader=response.body.getReader();
  try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new RemoteError('file_too_large');chunks.push(value);} }
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
export class Telegram {
  constructor(token, { fetcher=fetch,signal }={}) {this.token=token;this.fetcher=fetcher;this.signal=signal;}
  async call(method,payload={},timeoutMs=45000) {
    let response;
    try {
      const file=payload._document;
      let body,headers;
      if(file){body=new FormData();for(const [key,value] of Object.entries(payload)){if(key==='_document')continue;body.append(key,typeof value==='object'?JSON.stringify(value):String(value));}body.append('document',new Blob([file.content],{type:file.mime}),file.name);}
      else {headers={'Content-Type':'application/json'};body=JSON.stringify(payload);}
      response=await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',headers,body,signal:this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),redirect:'error'});
      const d=JSON.parse((await limitedBody(response,2_000_000)).toString());
      if(!response.ok||!d.ok)throw new RemoteError('telegram_api',{status:d.error_code||response.status,retryAfter:Number(d.parameters?.retry_after)||0});
      return d.result;
    }catch(e){if(e instanceof RemoteError)throw e;throw new RemoteError('telegram_transport');}
  }
  async download(voice,maxBytes) {
    const info=await this.call('getFile',{file_id:voice.file_id});
    if(info.file_size>maxBytes)throw new RemoteError('file_too_large');
    const filePath=info.file_path;
    if(typeof filePath!=='string'||!/^[A-Za-z0-9_./-]+$/.test(filePath)||filePath.includes('..')||filePath.startsWith('/'))throw new RemoteError('invalid_file_path');
    let response;
    try{response=await this.fetcher(`https://api.telegram.org/file/bot${this.token}/${filePath}`,{signal:this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),redirect:'error'});
      if(!response.ok)throw new RemoteError('telegram_download',{status:response.status});
      const bytes=await limitedBody(response,maxBytes);
      if(bytes.length<4||bytes.subarray(0,4).toString()!=='OggS')throw new RemoteError('invalid_ogg');
      return bytes;
    }catch(e){if(e instanceof RemoteError)throw e;throw new RemoteError('telegram_download');}
  }
}
export const STT_PROMPT='Стройматериалы: наименования, размеры, количества и единицы измерения. Добавляй точки и запятые.';
export class Transcriber {
  constructor(store,c,{fetcher=fetch,now=Date.now,signal}={}){this.store=store;this.c=c;this.fetcher=fetcher;this.now=now;this.signal=signal;}
  async transcribe(bytes,seconds,attemptKey){
    const key=createHash('sha256').update(bytes).update(JSON.stringify(['groq','whisper-large-v3-turbo','ru',STT_PROMPT,0])).digest('hex');
    const cached=this.store.one('SELECT text FROM stt_cache WHERE key=?',key);
    if(cached)return cached.text;
    this.store.reserve(attemptKey,seconds,this.c,this.now());
    try{
      const body=new FormData();body.append('file',new Blob([bytes],{type:'audio/ogg'}),'voice.ogg');
      for(const [k,v] of Object.entries({model:'whisper-large-v3-turbo',language:'ru',prompt:STT_PROMPT,temperature:'0',response_format:'json'}))body.append(k,v);
      const response=await this.fetcher('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',body,headers:{Authorization:`Bearer ${this.c.groqKey}`},signal:this.signal?AbortSignal.any([this.signal,AbortSignal.timeout(this.c.requestTimeoutMs)]):AbortSignal.timeout(this.c.requestTimeoutMs),redirect:'error'});
      if(!response.ok){
        const retryAfter=Math.max(1,Math.min(86400,Number(response.headers.get('retry-after'))||60));
        if(response.status===429)this.store.set('groq_cooldown',this.now()+retryAfter*1000);
        await response.body?.cancel();
        throw new RemoteError(response.status===429?'groq_rate_limit':'groq_error',{status:response.status,retryAfter});
      }
      const d=JSON.parse((await limitedBody(response,1_000_000)).toString());
      if(typeof d.text!=='string'||d.text.trim().length>12000)throw new RemoteError('invalid_transcript');
      const text=d.text.trim();
      this.store.tx(()=>{this.store.run('INSERT OR REPLACE INTO stt_cache VALUES(?,?)',key,text);this.store.run("UPDATE stt_attempts SET status='complete' WHERE key=?",attemptKey);});
      return text;
    }catch(e){
      this.store.run("UPDATE stt_attempts SET status='failed_or_uncertain' WHERE key=?",attemptKey);
      if(e instanceof RemoteError)throw e;throw new RemoteError('groq_transport');
    }
  }
}
