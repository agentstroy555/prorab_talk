import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { privateUserContext } from './updates.js';

const TABLES='kv|inbox|drafts|lines|source_parts|voice_jobs|stt_attempts|stt_cache|outbox';
// The engine uses a small, fixed SQL vocabulary shared with the local SQLite adapter.
// Qualify every table: a pooled Neon connection cannot rely on session search_path.
export function postgresSQL(sql) {
  let n=0;
  sql=sql.replace(/json_extract\(payload,'\$\.chat_id'\)/g,"(payload::jsonb->>'chat_id')::bigint");
  const ignore=/^INSERT OR IGNORE /i.test(sql),replace=/^INSERT OR REPLACE INTO stt_cache /i.test(sql);
  sql=sql.replace(/^INSERT OR (?:IGNORE|REPLACE) /i,'INSERT ');
  sql=sql.replace(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+(${TABLES})\\b`,'gi'), '$1 telegram.$2');
  sql=sql.replace(/\?/g,()=>`$${++n}`);
  if(ignore)sql+=' ON CONFLICT DO NOTHING';
  if(replace)sql+=' ON CONFLICT(key) DO UPDATE SET text=excluded.text';
  if(/^INSERT INTO telegram\.(?:drafts|lines|outbox|inbox|voice_jobs)\b/i.test(sql))sql+=' RETURNING id';
  return sql;
}
const types={getTypeParser(oid,format){
  if(oid===20)return value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new Error('Unsafe database integer');return n;};
  return pg.types.getTypeParser(oid,format);
}};
export class PostgresStore {
  constructor({connectionString,ssl,pool}={}) {
    this.pool=pool||new pg.Pool({connectionString,ssl,max:4,connectionTimeoutMillis:15000,idleTimeoutMillis:10000,statement_timeout:30000,types});
    this.context=new AsyncLocalStorage();
    this.pool.on?.('error',()=>console.error(JSON.stringify({event:'telegram.database.connection_error'})));
  }
  async init() {
    await this.tx(()=>this.query(`CREATE SCHEMA IF NOT EXISTS telegram;
      CREATE TABLE IF NOT EXISTS telegram.kv (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram.inbox (id BIGINT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS telegram.drafts (id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,chat_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_draft ON telegram.drafts(user_id,chat_id) WHERE status='draft';
      CREATE TABLE IF NOT EXISTS telegram.lines (id BIGSERIAL PRIMARY KEY,draft_id BIGINT NOT NULL REFERENCES telegram.drafts(id),position INTEGER NOT NULL,raw_text TEXT NOT NULL DEFAULT '',parsed TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending',source_update BIGINT UNIQUE,revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS telegram.source_parts (update_id BIGINT NOT NULL,ordinal INTEGER NOT NULL,line_id BIGINT NOT NULL REFERENCES telegram.lines(id),PRIMARY KEY(update_id,ordinal));
      CREATE TABLE IF NOT EXISTS telegram.voice_jobs (id BIGINT PRIMARY KEY,line_id BIGINT NOT NULL REFERENCES telegram.lines(id),voice TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',transcript TEXT,attempt INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS telegram.stt_attempts (key TEXT PRIMARY KEY,status TEXT NOT NULL,seconds DOUBLE PRECISION NOT NULL,created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram.stt_cache (key TEXT PRIMARY KEY,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram.outbox (id BIGSERIAL PRIMARY KEY,update_id BIGINT NOT NULL,seq INTEGER NOT NULL,method TEXT NOT NULL,payload TEXT NOT NULL,line_id BIGINT,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at BIGINT NOT NULL DEFAULT 0,message_id BIGINT,UNIQUE(update_id,seq));
      CREATE INDEX IF NOT EXISTS inbox_pending ON telegram.inbox(status,id);
      CREATE INDEX IF NOT EXISTS outbox_pending ON telegram.outbox(status,next_at,id);
      CREATE INDEX IF NOT EXISTS usage_time ON telegram.stt_attempts(created_at);`));
    await this.set('schema_version','2');
    return this;
  }
  async query(sql,params=[]) {return (this.context.getStore()||this.pool).query({text:postgresSQL(sql),values:params,types});}
  async q(sql,...params) {return (await this.query(sql,params)).rows;}
  async one(sql,...params) {return (await this.q(sql,...params))[0];}
  async run(sql,...params) {const r=await this.query(sql,params);return {changes:r.rowCount,lastInsertRowid:r.rows?.[0]?.id??0};}
  async tx(fn) {
    if(this.context.getStore())return fn();
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Transaction-scoped lock works through Neon/PgBouncer and serializes budget,
      // queue admission and draft mutations across overlapping Render deployments.
      await client.query('SELECT pg_advisory_xact_lock(1876813,1)');
      const result=await this.context.run(client,fn);
      await client.query('COMMIT');return result;
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally {client.release();}
  }
  async get(key,fallback='') {return (await this.one('SELECT value FROM kv WHERE key=?',key))?.value??fallback;}
  async set(key,value) {await this.run('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(value));}
  active(user,chat) {return this.one("SELECT * FROM drafts WHERE user_id=? AND chat_id=? AND status='draft'",String(user),String(chat));}
  lines(id) {return this.q("SELECT * FROM lines WHERE draft_id=? AND status!='deleted' ORDER BY position,id",id);}
  line(draft,id) {return this.one("SELECT * FROM lines WHERE draft_id=? AND id=? AND status!='deleted'",draft,id);}
  enqueue(updates,maxPending) {return this.tx(async()=>{
    let pending=(await this.one("SELECT count(*) AS n FROM inbox WHERE status!='done'")).n+(await this.one("SELECT count(*) AS n FROM outbox WHERE status IN ('pending','sending')")).n;
    for(const update of updates) {
      if(!Number.isSafeInteger(update?.update_id)||update.update_id<0)throw new Error('Invalid update');
      if(!privateUserContext(update))continue;
      if(await this.one('SELECT 1 FROM inbox WHERE id=?',update.update_id))continue;
      if(pending>=maxPending)throw new Error('Inbox full');
      await this.run('INSERT INTO inbox(id,payload) VALUES(?,?)',update.update_id,JSON.stringify(update));pending++;
    }
    if(updates.length)await this.set('offset',updates.at(-1).update_id+1);
  });}
  async emit(update,effects) {
    for(const [seq,e] of effects.entries())await this.run('INSERT OR IGNORE INTO outbox(update_id,seq,method,payload,line_id) VALUES(?,?,?,?,?)',update,seq,e.method||'sendMessage',JSON.stringify(e.payload),e.lineId??null);
    await this.run("UPDATE inbox SET status='done' WHERE id=?",update);
  }
  reserve(key,seconds,c,now=Date.now()) {return this.tx(async()=>{
    if(await this.one('SELECT 1 FROM stt_attempts WHERE key=?',key))throw new Error('uncertain');
    if(Number(await this.get('groq_cooldown',0))>now)throw new Error('cooldown');
    const minute=(await this.one('SELECT count(*) AS n FROM stt_attempts WHERE created_at>?',now-60000)).n;
    const usage=await this.one('SELECT count(*) AS n,coalesce(sum(seconds),0) AS seconds FROM stt_attempts WHERE created_at>=?',Math.floor(now/86400000)*86400000);
    if(minute>=c.rpm||usage.n>=c.rpd||usage.seconds+seconds>c.audioPerDay)throw new Error('budget');
    await this.run('INSERT INTO stt_attempts VALUES(?,?,?,?)',key,'started',seconds,now);
  });}
  claimInbox() {return this.tx(async()=>{const e=await this.one("SELECT * FROM inbox WHERE status='pending' ORDER BY id LIMIT 1");if(e)await this.run("UPDATE inbox SET status='processing' WHERE id=?",e.id);return e;});}
  claimOutbox(now) {return this.tx(async()=>{const e=await this.one("SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 1",now);if(e)await this.run("UPDATE outbox SET status='sending',attempts=attempts+1 WHERE id=?",e.id);return e;});}
  async recover() {await this.tx(async()=>{await this.run("UPDATE inbox SET status='pending' WHERE status='processing'");await this.run("UPDATE outbox SET status='uncertain' WHERE status='sending'");});}
  async close() {if(!this.closed){this.closed=true;await this.pool.end();}}
}
