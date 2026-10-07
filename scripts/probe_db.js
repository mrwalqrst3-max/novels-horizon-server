/* Find the shared pooler host (cluster index + region) for this Supabase project. */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const ref = 'orbvckygoczqcbddwtho';
const password = 'JpRkpYm8y1UmwbyF';
const regions = ['us-east-1', 'us-west-1', 'eu-west-1', 'eu-central-1', 'eu-north-1', 'eu-west-2', 'eu-west-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'sa-east-1', 'ca-central-1'];
const indices = [0, 1, 2, 3];

(async () => {
  for (const region of regions) {
    for (const idx of indices) {
      for (const port of [6543, 5432]) {
        const host = `aws-${idx}-${region}.pooler.supabase.com`;
        const c = new Client({
          host, port, user: `postgres.${ref}`, password, database: 'postgres',
          connectTimeout: 5000, ssl: { rejectUnauthorized: false },
        });
        try {
          await c.connect();
          const res = await c.query('SELECT current_user');
          console.log(`SUCCESS host=${host}:${port} user=${res.rows[0].current_user}`);
          await c.end();
          process.exit(0);
        } catch (e) {
          if (!/tenant\/user/.test(e.message)) {
            console.log(`auth/connect [${host}:${port}] -> ${e.message.slice(0, 120)}`);
          }
          try { await c.end(); } catch (_) {}
        }
      }
    }
  }
  console.log('NO_ENDPOINT_REACHABLE');
  process.exit(2);
})();
