/**
 * Upstash Redis REST helper (no extra SDK; plain fetch) with an
 * in-memory fallback so the service still boots without Redis.
 */
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = Boolean(REDIS_URL && REDIS_TOKEN);

const memory = new Map();

async function cmd(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`redis ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.result;
}

function memKey(key) {
  const e = memory.get(key);
  if (!e || e.expiresAt < Date.now()) {
    memory.delete(key);
    return null;
  }
  return e;
}

/** Fixed-window rate limiter. Returns { allowed, remaining }. */
async function rateLimit(key, limit, windowSeconds) {
  if (hasRedis) {
    const k = `rl:${key}`;
    const count = Number(await cmd('INCR', k));
    if (count === 1) await cmd('EXPIRE', k, windowSeconds);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }
  const now = Date.now();
  const e = memKey(k0(key, now, windowSeconds));
  const value = (e ? e.value : 0) + 1;
  memory.set(k0(key, now, windowSeconds), {
    value,
    expiresAt: now + windowSeconds * 1000,
  });
  return { allowed: value <= limit, remaining: Math.max(0, limit - value) };
}

function k0(key, now, windowSeconds) {
  const window = Math.floor(now / (windowSeconds * 1000));
  return `rl:${key}:${window}`;
}

async function cacheGet(key) {
  if (hasRedis) {
    const v = await cmd('GET', `cache:${key}`);
    return v == null ? null : JSON.parse(v);
  }
  const e = memKey(`cache:${key}`);
  return e ? e.value : null;
}

async function cacheSet(key, value, ttlSeconds) {
  if (hasRedis) {
    await cmd('SET', `cache:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
    return;
  }
  memory.set(`cache:${key}`, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

async function queuePush(queue, payload) {
  if (hasRedis) await cmd('LPUSH', `q:${queue}`, JSON.stringify(payload));
  else {
    const arr = memory.get(`q:${queue}`) || [];
    arr.push(JSON.stringify(payload));
    memory.set(`q:${queue}`, arr);
  }
}

async function queuePop(queue) {
  if (hasRedis) return await cmd('RPOP', `q:${queue}`);
  const arr = memory.get(`q:${queue}`) || [];
  return arr.length ? arr.shift() : null;
}

module.exports = { hasRedis, rateLimit, cacheGet, cacheSet, queuePush, queuePop };
