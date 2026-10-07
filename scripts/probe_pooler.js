/* Brute-force the Supabase shared pooler host (region x cluster index) for this project. */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const ref = 'orbvckygoczqcbddwtho';
const password = 'JpRkpYm8y1UmwbyF';
const regions = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-south-1', 'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'sa-east-1', 'ca-central-1', 'me-south-1', 'af-south-1',
];
const indexes = [0, 1, 2, 3];

async function attempt(host, port) {
  const c = new Client({
    host, port, user: `postgres.${ref}`, password, database: 'postgres',
    connectTimeout: 5000, ssl: { rejectUnauthorized: false },
  });
  try {
    await c.connect();
    const r = await c.query('SELECT current_database(), version()');
    console.log(`SUCCESS ${host}:${port} db=${r.rows[0].current_database}`);
    await c.end();
    return true;
  } catch (e) {
    const m = e.message || '';
    if (m.includes('tenant/user not found')) return false; // host alive, wrong cluster
    if (m.includes('ETIMEDOUT') || m.includes('ENOTFOUND')) return false;
    // password/auth errors mean we found the right tenant
    if (m.includes('password') || m.includes('auth') || m.includes('role')) {
      console.log(`TENANT_FOUND ${host}:${port} -> ${m}`);
      return 'tenant';
    }
    console.log(`other [${host}:${port}] ${m}`);
    return false;
  } finally {
    try { await c.end(); } catch (_) {}
  }
}

(async () => {
  for (const idx of indexes) {
    for (const region of regions) {
      const host = `aws-${idx}-${region}.pooler.supabase.com`;
      const res = await attempt(host, 6543);
      if (res === true || res === 'tenant') { console.log(`USE_HOST=${host} PORT=6543`); process.exit(0); }
    }
    console.log(`--- index aws-${idx} exhausted ---`);
  }
  console.log('NOT_FOUND');
  process.exit(2);
})();
