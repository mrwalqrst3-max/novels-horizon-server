/**
 * Novels Horizon backend API (Render).
 * Heavy/background jobs: TTS queue, media handling, webhooks, rate-limited
 * endpoints, cached public reads (Upstash Redis when configured).
 */
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const redis = require('./redis');
const ttsWorker = require('./ttsWorker');

const app = express();
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Rate limiting: 120 req / min / IP on /api (Upstash-backed when available)
// ---------------------------------------------------------------------------
app.use('/api', async (req, res, next) => {
  try {
    const ip = req.ip || 'unknown';
    const { allowed, remaining } = await redis.rateLimit(ip, 120, 60);
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (!allowed) return res.status(429).json({ error: 'rate limit exceeded' });
    next();
  } catch (_) {
    next();
  }
});

function requireServiceKey(req, res, next) {
  const key = req.headers['x-service-key'] || req.headers.authorization?.replace('Bearer ', '');
  if (SERVICE_KEY && key === SERVICE_KEY) return next();
  if (!SERVICE_KEY) return next();
  res.status(401).json({ error: 'invalid service key' });
}

function verifyWebhookSignature(req, res, next) {
  if (!WEBHOOK_SECRET) return next();
  const sig = req.headers['x-webhook-signature'];
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (sig && sig === expected) return next();
  res.status(401).json({ error: 'invalid signature' });
}

async function supabaseFetch(path, options = {}) {
  const key = SERVICE_KEY || ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------------------
// Health / ops
// ---------------------------------------------------------------------------
app.get('/health', async (_req, res) => {
  let redisState = 'disabled';
  if (redis.hasRedis) {
    try {
      await redis.cacheGet('health-probe');
      redisState = 'connected';
    } catch (_) {
      redisState = 'error';
    }
  }
  res.json({
    status: 'ok',
    service: 'novels-horizon-api',
    uptime: Math.round(process.uptime()),
    redis: redisState,
    ttsWorker: Boolean(process.env.TTS_COMMAND),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Cached public reads
// ---------------------------------------------------------------------------
app.get('/api/announcements', async (_req, res) => {
  try {
    const cached = await redis.cacheGet('announcements');
    if (cached) return res.json(cached);
    const rows = await supabaseFetch(
      'announcements?is_active=true&order=created_at.desc&limit=10'
    );
    await redis.cacheSet('announcements', rows, 30);
    res.json(rows);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/featured', async (_req, res) => {
  try {
    const cached = await redis.cacheGet('featured');
    if (cached) return res.json(cached);
    const rows = await supabaseFetch(
      'novels?select=id,title,cover_url,category,rating_avg,views_count'
        + '&is_published=true&is_featured=true&order=rating_avg.desc&limit=10'
    );
    await redis.cacheSet('featured', rows, 60);
    res.json(rows);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// TTS queue
// ---------------------------------------------------------------------------
app.post('/api/tts/queue', verifyWebhookSignature, async (req, res) => {
  const { chapterId, novelId, text, voice } = req.body || {};
  if (!chapterId || !novelId || !text) {
    return res.status(400).json({ error: 'chapterId, novelId and text are required' });
  }
  const jobId = crypto.randomUUID();
  await redis.queuePush('tts', { jobId, chapterId, novelId, text, voice });
  res.status(202).json({ jobId, status: 'queued' });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
app.post('/webhooks/chapter-published', verifyWebhookSignature, async (req, res) => {
  const { chapterId, novelId, content, language } = req.body || {};
  if (!chapterId || !novelId) {
    return res.status(400).json({ error: 'chapterId and novelId are required' });
  }
  const jobId = crypto.randomUUID();
  await redis.queuePush('tts', {
    jobId,
    chapterId,
    novelId,
    text: content || '',
    voice: language === 'ar' ? 'ar-SA-HamedNeural' : undefined,
    trigger: 'chapter-published',
  });
  res.status(202).json({ jobId, status: 'queued' });
});

// ---------------------------------------------------------------------------
// Media handling: strip metadata (watermark/EXIF) by re-encoding PNG/JPEG.
// ---------------------------------------------------------------------------
app.post('/api/media/clean', requireServiceKey, async (req, res) => {
  const { storagePath, bucket = 'covers' } = req.body || {};
  if (!storagePath) return res.status(400).json({ error: 'storagePath required' });
  try {
    const key = SERVICE_KEY;
    const objRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${bucket}/${storagePath}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!objRes.ok) throw new Error(`download failed: ${objRes.status}`);
    const inputType = objRes.headers.get('content-type') || 'image/png';
    const inputBuffer = Buffer.from(await objRes.arrayBuffer());
    const cleaned = await cleanImageMetadata(inputBuffer, inputType);
    const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${storagePath}`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': inputType,
        'x-upsert': 'true',
      },
      body: cleaned,
    });
    if (!upRes.ok) throw new Error(`upload failed: ${upRes.status}`);
    res.json({ status: 'cleaned', bytes: cleaned.length });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * Strips EXIF/XMP chunks from PNG (iTXt/tEXt/zTXt) and JPEG (APP1/APP13).
 * Pure-JS implementation - no native dependencies.
 */
async function cleanImageMetadata(buffer, contentType) {
  if (contentType.includes('png')) {
    const out = [];
    let offset = 8; // skip PNG signature
    out.push(buffer.subarray(0, 8));
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      const chunkStart = offset;
      const chunkEnd = offset + 12 + length;
      const isTextMeta = ['tEXt', 'zTXt', 'iTXt'].includes(type);
      if (!isTextMeta) out.push(buffer.subarray(chunkStart, chunkEnd));
      offset = chunkEnd;
      if (type === 'IEND') {
        out.push(buffer.subarray(chunkStart, chunkEnd));
        break;
      }
    }
    return Buffer.concat(out);
  }
  if (contentType.includes('jpeg') || contentType.includes('jpg')) {
    const out = [buffer.subarray(0, 2)]; // SOI
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker >= 0xd8 && marker <= 0xd9) {
        offset += 2;
        continue;
      }
      const size = buffer.readUInt16BE(offset + 2);
      const isExif = marker === 0xe1; // APP1
      const isIptc = marker === 0xed; // APP13
      if (!isExif && !isIptc) {
        out.push(buffer.subarray(offset, offset + 2 + size));
      }
      offset += 2 + size;
      if (marker === 0xda) {
        out.push(buffer.subarray(offset));
        break;
      }
    }
    return Buffer.concat(out);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Admin: broadcast an announcement (service key protected)
// ---------------------------------------------------------------------------
app.post('/api/broadcast', requireServiceKey, async (req, res) => {
  const { title, body, adminId } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  try {
    await supabaseFetch('announcements', {
      method: 'POST',
      body: JSON.stringify({ title, body, is_active: true, created_by: adminId || null }),
    });
    await redis.cacheSet('announcements', null, 1).catch(() => {});
    res.status(201).json({ status: 'broadcast' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`Novels Horizon API listening on :${PORT}`);
  ttsWorker.loop();
});
