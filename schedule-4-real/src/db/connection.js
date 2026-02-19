import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// QuestDB connection via PostgreSQL wire protocol
const pool = new Pool({
  host: process.env.QUESTDB_HOST || '127.0.0.1',
  port: parseInt(process.env.QUESTDB_PG_PORT) || 8812,
  user: process.env.QUESTDB_USER || 'spider',
  password: process.env.QUESTDB_PASSWORD || 'spider123',
  database: process.env.QUESTDB_DATABASE || 'qdb',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[QuestDB] Unexpected error on idle client', err);
});

export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 100) {
      console.log(`[QuestDB] Slow query (${duration}ms): ${text.substring(0, 50)}...`);
    }
    return res;
  } catch (err) {
    console.error('[QuestDB] Query error:', err.message);
    throw err;
  }
}

export async function getClient() {
  return await pool.connect();
}

export async function healthCheck() {
  try {
    const res = await query('SELECT 1');
    return res.rows.length > 0;
  } catch (err) {
    return false;
  }
}

export default pool;
