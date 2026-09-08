require('dotenv').config();
const { Client } = require('pg');

// SUPABASE_URL is the REST endpoint (https://...). node-postgres needs a
// Postgres connection string (postgresql://...), which Supabase exposes under
// Project Settings -> Database -> Connection string.
const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set SUPABASE_DB_URL to the postgresql:// connection string from Supabase → Project Settings → Database.');
  process.exit(1);
}

const client = new Client({ connectionString });
client.connect()
  .then(() => client.query('ALTER TABLE outputs ADD COLUMN IF NOT EXISTS type TEXT;'))
  .then(() => console.log('success'))
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => client.end());
