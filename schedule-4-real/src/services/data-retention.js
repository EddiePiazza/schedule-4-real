/**
 * Data Retention Service
 * Automatically cleans up data older than configured retention period
 */

import { query } from '../db/connection.js';
import dotenv from 'dotenv';

dotenv.config();

const RETENTION_DAYS = parseInt(process.env.DATA_RETENTION_DAYS) || 90;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // Every 24 hours

const TABLES = [
  'sensors_environment',
  'sensors_soil',
  'outlet_states',
  'light_states',
  'system_status',
  'operation_logs'
];

let cleanupInterval = null;

/**
 * Delete old partitions from a table
 */
async function cleanupTable(tableName) {
  try {
    // QuestDB: Drop partitions older than retention period
    // Using ALTER TABLE ... DROP PARTITION WHERE
    const result = await query(`
      SELECT count() as cnt
      FROM ${tableName}
      WHERE timestamp < dateadd('d', -${RETENTION_DAYS}, now())
    `);

    const oldRows = result.rows[0]?.cnt || 0;

    if (oldRows > 0) {
      // Delete old data
      await query(`
        DELETE FROM ${tableName}
        WHERE timestamp < dateadd('d', -${RETENTION_DAYS}, now())
      `);
      console.log(`[Retention] Cleaned ${oldRows} rows from ${tableName}`);
    }

    return oldRows;
  } catch (err) {
    // Table might not exist or be empty
    if (!err.message.includes('does not exist')) {
      console.error(`[Retention] Error cleaning ${tableName}:`, err.message);
    }
    return 0;
  }
}

/**
 * Run cleanup on all tables
 */
export async function runCleanup() {
  console.log('[Retention] Starting data cleanup...');
  console.log(`[Retention] Removing data older than ${RETENTION_DAYS} days`);

  let totalCleaned = 0;

  for (const table of TABLES) {
    const cleaned = await cleanupTable(table);
    totalCleaned += cleaned;
  }

  console.log(`[Retention] Cleanup complete. Total rows removed: ${totalCleaned}`);
  return totalCleaned;
}

/**
 * Get table statistics
 */
export async function getTableStats() {
  const stats = [];

  for (const table of TABLES) {
    try {
      const countResult = await query(`SELECT count() as cnt FROM ${table}`);
      const oldestResult = await query(`SELECT min(timestamp) as oldest FROM ${table}`);
      const newestResult = await query(`SELECT max(timestamp) as newest FROM ${table}`);

      stats.push({
        table,
        rowCount: countResult.rows[0]?.cnt || 0,
        oldest: oldestResult.rows[0]?.oldest || null,
        newest: newestResult.rows[0]?.newest || null
      });
    } catch (err) {
      stats.push({
        table,
        error: err.message
      });
    }
  }

  return stats;
}

/**
 * Start automatic cleanup interval
 */
export function startAutoCleanup() {
  console.log(`[Retention] Auto-cleanup enabled (every ${CLEANUP_INTERVAL_MS / 1000 / 60 / 60} hours)`);

  // Run immediately on start
  runCleanup().catch(console.error);

  // Schedule periodic cleanup
  cleanupInterval = setInterval(() => {
    runCleanup().catch(console.error);
  }, CLEANUP_INTERVAL_MS);

  return cleanupInterval;
}

/**
 * Stop automatic cleanup
 */
export function stopAutoCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('[Retention] Auto-cleanup stopped');
  }
}

export default { runCleanup, getTableStats, startAutoCleanup, stopAutoCleanup };

// When run by PM2 or directly, auto-start
const isPM2 = typeof process.env.pm_id !== 'undefined';
const isDirectRun = process.argv[1]?.includes('data-retention');

if (isPM2 || isDirectRun) {
  startAutoCleanup();
  process.on('SIGINT', () => {
    stopAutoCleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopAutoCleanup();
    process.exit(0);
  });
}
