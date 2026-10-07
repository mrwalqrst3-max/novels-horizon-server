/**
 * Background TTS worker.
 *
 * Jobs arrive on the `tts` queue as { chapterId, novelId, text, voice }.
 * Rendering is delegated to an external command (TTS_COMMAND) so the
 * engine can be swapped (edge-tts, piper, Google Cloud TTS...) without
 * touching this service. The produced file is uploaded to the `audio`
 * bucket through the Supabase Storage REST API using the service key.
 *
 * Example:
 *   TTS_COMMAND="edge-tts --voice ar-SA-HamedNeural --text {text} --write-media {out}"
 */
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { queuePop } = require('../redis');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TTS_COMMAND = process.env.TTS_COMMAND || '';
const POLL_MS = Number(process.env.TTS_POLL_MS || 4000);

function runCommand(template, ctx) {
  const rendered = template
    .replace('{text}', ctx.textPath)
    .replace('{out}', ctx.outPath)
    .replace('{voice}', ctx.voice || 'ar-SA-HamedNeural');
  const parts = rendered.split(/\s+/);
  const bin = parts[0];
  const args = parts.slice(1);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err}`))
    );
  });
}

async function uploadToStorage(localPath, storagePath, contentType) {
  const bytes = await fs.readFile(localPath);
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/audio/${storagePath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        apikey: SERVICE_KEY,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: bytes,
    }
  );
  if (!res.ok) throw new Error(`storage upload ${res.status}: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/audio/${storagePath}`;
}

async function processJob(job) {
  if (!TTS_COMMAND) {
    console.log(`[tts] skipped (no TTS_COMMAND): chapter=${job.chapterId}`);
    return { status: 'skipped' };
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nh-tts-'));
  const textPath = path.join(tmpDir, 'input.txt');
  const outPath = path.join(tmpDir, 'output.mp3');
  try {
    await fs.writeFile(textPath, job.text || '', 'utf8');
    await runCommand(TTS_COMMAND, { ...job, textPath, outPath });
    const url = await uploadToStorage(
      outPath,
      `${job.novelId}/${job.chapterId}.mp3`,
      'audio/mpeg'
    );
    console.log(`[tts] done chapter=${job.chapterId} -> ${url}`);
    return { status: 'done', url };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function loop() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.warn('[tts] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing - worker idle');
  }
  for (;;) {
    try {
      const raw = await queuePop('tts');
      if (raw) {
        await processJob(JSON.parse(raw));
        continue;
      }
    } catch (e) {
      console.error('[tts] job error:', e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

module.exports = { processJob, loop };
