/* eslint-disable no-console */
/**
 * Novels Horizon - applies SQL migrations, then seeds the DEVELOPER master account.
 * Reads ../../.env (DEVELOPER_EMAIL, DEVELOPER_PASSWORD, DATABASE_URL).
 * Run: node scripts/apply_and_seed.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const { DATABASE_URL, DEVELOPER_EMAIL, DEVELOPER_PASSWORD } = process.env;

if (!DATABASE_URL) { console.error('Missing DATABASE_URL in .env'); process.exit(1); }
if (!DEVELOPER_EMAIL || !DEVELOPER_PASSWORD) {
  console.error('Missing DEVELOPER_EMAIL / DEVELOPER_PASSWORD in .env');
  process.exit(1);
}

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'supabase', 'migrations');

function clientConfig() {
  // Direct connection (DATABASE_URL) is IPv6-only on this project; the shared
  // pooler is IPv4 and reachable from this machine.
  if (process.env.POOLER_HOST) {
    return {
      host: process.env.POOLER_HOST,
      port: Number(process.env.POOLER_PORT || 6543),
      user: process.env.POOLER_USER || 'postgres',
      password: (new URL(DATABASE_URL)).password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    };
  }
  return { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } };
}

async function applyMigrations(client) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    try {
      await client.query(sql);
      console.log('OK');
    } catch (err) {
      console.log('FAILED');
      console.error(err.message);
      throw err;
    }
  }
}

async function seedDeveloper(client) {
  const email = DEVELOPER_EMAIL.trim();
  const username = (email.split('@')[0] || 'developer').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30) || 'developer';
  const hash = bcrypt.hashSync(DEVELOPER_PASSWORD, 10);
  const meta = JSON.stringify({ username, role: 'DEVELOPER' });

  const existing = await client.query('SELECT id FROM auth.users WHERE lower(email) = lower($1)', [email]);
  let userId;

  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
    await client.query(
      'UPDATE auth.users SET encrypted_password = $1, email_confirmed_at = now(), raw_user_meta_data = $2, updated_at = now() WHERE id = $3',
      [hash, meta, userId]
    );
    console.log(`Updated existing auth user ${userId}`);
  } else {
    const inserted = await client.query(
      `INSERT INTO auth.users
         (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
               $1, $2, now(),
               '{"provider":"email","providers":["email"]}', $3::jsonb, now(), now())
       RETURNING id`,
      [email, hash, meta]
    );
    userId = inserted.rows[0].id;
    console.log(`Created auth user ${userId}`);
  }

  await client.query(
    `INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, lower($2),
             jsonb_build_object('sub', $3::text, 'email', $2, 'email_verified', true, 'phone_verified', false),
             'email', now(), now(), now())
     ON CONFLICT DO NOTHING`,
    [userId, email, String(userId)]
  );

  // handle_new_user trigger normally creates this row; force DEVELOPER privileges.
  await client.query(
    `INSERT INTO public.profiles (id, username, role, is_banned, created_at, updated_at)
     VALUES ($1, $2, 'DEVELOPER', false, now(), now())
     ON CONFLICT (id) DO UPDATE SET role = 'DEVELOPER', is_banned = false, updated_at = now()`,
    [userId, username]
  );

  await client.query(
    `INSERT INTO public.system_logs (admin_id, action, target_id, details)
     VALUES ($1, 'SEED_DEVELOPER_ACCOUNT', $1, '{"source":"apply_and_seed.js"}'::jsonb)`,
    [userId]
  );

  console.log('---------------------------------------------');
  console.log(' DEVELOPER account seeded successfully');
  console.log(`   email:   ${email}`);
  console.log(`   user id: ${userId}`);
  console.log('   role:    DEVELOPER (full RLS bypass via is_developer())');
  console.log('---------------------------------------------');
}

(async () => {
  const client = new Client(clientConfig());
  try {
    await client.connect();
    await applyMigrations(client);
    await seedDeveloper(client);
    console.log('DONE');
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    client.end().catch(() => {});
  }
})();
