import {botToken} from './bot-token.js';
export function config(env = process.env, { requireSecrets = true } = {}) {
  const integer = (name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid configuration: ${name}`);
    return value;
  };
  const c = {
    token: botToken(env), groqKey: env.GROQ_API_KEY || '',
    mode: env.BOT_MODE || 'polling', secret: env.WEBHOOK_SECRET || '',
    port: integer('PORT', 3000, 0, 65535), dbPath: env.DB_PATH || './var/agent-stroy.sqlite',
    maxVoiceSeconds: integer('MAX_VOICE_SECONDS', 120, 1, 1200),
    maxVoiceBytes: integer('MAX_VOICE_BYTES', 15000000, 1024, 20000000),
    maxPending: integer('MAX_PENDING_UPDATES', 500, 10, 5000),
    rpm: integer('STT_REQUESTS_PER_MINUTE', 15, 1, 300),
    rpd: integer('STT_REQUESTS_PER_DAY', 300), audioPerDay: integer('STT_AUDIO_SECONDS_PER_DAY', 7200),
    requestTimeoutMs: 45000
  };
  if (!['polling', 'webhook'].includes(c.mode)) throw new Error('BOT_MODE must be polling or webhook');
  if (requireSecrets && (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(c.token) || !c.groqKey)) {
    throw new Error('Set a valid Telegram token and GROQ_API_KEY');
  }
  if (requireSecrets && c.mode === 'webhook' && !/^[A-Za-z0-9_-]{24,256}$/.test(c.secret)) throw new Error('Set a random WEBHOOK_SECRET (24–256 characters)');
  return c;
}
