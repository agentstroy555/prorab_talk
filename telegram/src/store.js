import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(path = ':memory:', { recover = true } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS drafts (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_draft ON drafts(user_id,chat_id) WHERE status='draft';
      CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id),
        position INTEGER NOT NULL, raw_text TEXT NOT NULL DEFAULT '', parsed TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending', source_update INTEGER UNIQUE, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS source_parts (update_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, line_id INTEGER NOT NULL REFERENCES lines(id), PRIMARY KEY(update_id,ordinal));
      CREATE TABLE IF NOT EXISTS voice_jobs (id INTEGER PRIMARY KEY, line_id INTEGER NOT NULL REFERENCES lines(id),
        voice TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        transcript TEXT, attempt INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS stt_attempts (key TEXT PRIMARY KEY, status TEXT NOT NULL,
        seconds REAL NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS stt_cache (key TEXT PRIMARY KEY, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, update_id INTEGER NOT NULL, seq INTEGER NOT NULL,
        method TEXT NOT NULL, payload TEXT NOT NULL, line_id INTEGER, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, message_id INTEGER,
        UNIQUE(update_id,seq));
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(status,id);
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,next_at,id);
      CREATE INDEX IF NOT EXISTS usage_time ON stt_attempts(created_at);`);
    this.run('INSERT OR IGNORE INTO source_parts(update_id,ordinal,line_id) SELECT source_update,0,id FROM lines WHERE source_update IS NOT NULL');
    this.set('schema_version','2');
    if(recover)this.db.exec("UPDATE inbox SET status='pending' WHERE status='processing'; UPDATE outbox SET status='uncertain' WHERE status='sending';");
  }
  q(sql, ...params) { return this.db.prepare(sql).all(...params); }
  one(sql, ...params) { return this.db.prepare(sql).get(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key, fallback = '') { return this.one('SELECT value FROM kv WHERE key=?', key)?.value ?? fallback; }
  set(key, value) { this.run('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)); }
  active(user, chat) { return this.one("SELECT * FROM drafts WHERE user_id=? AND chat_id=? AND status='draft'", String(user), String(chat)); }
  lines(draftId) { return this.q("SELECT * FROM lines WHERE draft_id=? AND status!='deleted' ORDER BY position,id", draftId); }
  line(draftId, id) { return this.one("SELECT * FROM lines WHERE draft_id=? AND id=? AND status!='deleted'", draftId, id); }
  enqueue(updates, maxPending, allowed) {
    return this.tx(() => {
      let pending = this.one("SELECT count(*) AS n FROM inbox WHERE status!='done'").n + this.one("SELECT count(*) AS n FROM outbox WHERE status IN ('pending','sending')").n;
      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new Error('Invalid update');
        const m = update.message || update.callback_query?.message;
        const user = update.message?.from || update.callback_query?.from;
        // Private employee conversation only; groups and other update kinds never reach processing.
        if (m?.chat?.type !== 'private' || !user || user.is_bot || !allowed.has(String(user.id))) continue;
        if (this.one('SELECT 1 FROM inbox WHERE id=?', update.update_id)) continue;
        if (pending >= maxPending) throw new Error('Inbox full');
        this.run('INSERT INTO inbox(id,payload) VALUES(?,?)', update.update_id, JSON.stringify(update)); pending++;
      }
      if (updates.length) this.set('offset', updates.at(-1).update_id + 1);
    });
  }
  emit(updateId, effects) {
    effects.forEach((e, seq) => this.run('INSERT OR IGNORE INTO outbox(update_id,seq,method,payload,line_id) VALUES(?,?,?,?,?)',
      updateId, seq, e.method || 'sendMessage', JSON.stringify(e.payload), e.lineId ?? null));
    this.run("UPDATE inbox SET status='done' WHERE id=?", updateId);
  }
  reserve(key, seconds, c, now = Date.now()) {
    return this.tx(() => {
      const old = this.one('SELECT * FROM stt_attempts WHERE key=?', key);
      if (old) throw new Error('uncertain');
      if (Number(this.get('groq_cooldown', 0)) > now) throw new Error('cooldown');
      const minute = this.one('SELECT count(*) AS n FROM stt_attempts WHERE created_at>?', now - 60000).n;
      const day = Math.floor(now / 86400000) * 86400000;
      const usage = this.one('SELECT count(*) AS n,coalesce(sum(seconds),0) AS seconds FROM stt_attempts WHERE created_at>=?', day);
      if (minute >= c.rpm || usage.n >= c.rpd || usage.seconds + seconds > c.audioPerDay) throw new Error('budget');
      this.run('INSERT INTO stt_attempts VALUES(?,?,?,?)', key, 'started', seconds, now);
    });
  }
  close() { this.db.close(); }
}
