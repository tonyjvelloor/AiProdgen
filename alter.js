require('dotenv').config();
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.SUPABASE_URL });
client.connect().then(() => client.query('ALTER TABLE outputs ADD COLUMN IF NOT EXISTS type TEXT;'))
  .then(() => console.log('success'))
  .catch(e => console.error(e))
  .finally(() => client.end());
