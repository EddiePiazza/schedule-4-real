// ═══════════════════════════════════════════════════════════════════
// tracker-db.cjs — QuestDB persistence for tracker rooms
// Uses HTTP REST API (port 9000) — zero npm dependencies
// Graceful fallback: if QuestDB unavailable, caller uses in-memory Maps
// ═══════════════════════════════════════════════════════════════════
'use strict'

const http = require('node:http')

// ── Configuration ────────────────────────────────────────────────
const QUESTDB_HOST = process.env.QUESTDB_HTTP_HOST || '127.0.0.1'
const QUESTDB_PORT = parseInt(process.env.QUESTDB_HTTP_PORT || '9000', 10)

let available = false

// ── SQL escaping ─────────────────────────────────────────────────
function esc(s) {
  return (s || '').replace(/'/g, "''")
}

// ── HTTP helper: execute SQL on QuestDB REST API ─────────────────
function execSql(sql, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const body = `query=${encodeURIComponent(sql)}`
    const req = http.request({
      hostname: QUESTDB_HOST,
      port: QUESTDB_PORT,
      path: '/exec',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          const json = JSON.parse(raw)
          if (json.error) {
            reject(new Error(json.error))
            return
          }
          resolve(json)
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

// ── Initialize DB ────────────────────────────────────────────────
// Creates tracker_rooms table if it doesn't exist.
// Returns true if QuestDB is available, false otherwise.
async function initDb() {
  try {
    await execSql(`
      CREATE TABLE IF NOT EXISTS tracker_rooms (
        timestamp TIMESTAMP,
        room_id SYMBOL,
        metadata STRING,
        entry_relay STRING,
        is_private BOOLEAN,
        federated BOOLEAN,
        source_relay STRING,
        expires_at LONG
      ) TIMESTAMP(timestamp) PARTITION BY DAY
    `, 10000)
    available = true
    console.log('[TRACKER-DB] QuestDB connected, tracker_rooms table ready')
    return true
  } catch (err) {
    available = false
    console.warn(`[TRACKER-DB] QuestDB unavailable (${err.message}), using in-memory fallback`)
    return false
  }
}

// ── Persist room (fire-and-forget) ───────────────────────────────
// Inserts a new row into QuestDB. LATEST BY room_id always returns
// the most recent row, so this effectively "upserts" the room state.
function persistRoom(roomId, metadata64, entryRelay, isPrivate, federated, sourceRelay, expiresAtMs) {
  if (!available) return

  const sql = `INSERT INTO tracker_rooms VALUES(now(), '${esc(roomId)}', '${esc(metadata64)}', '${esc(entryRelay)}', ${isPrivate ? 'true' : 'false'}, ${federated ? 'true' : 'false'}, '${esc(sourceRelay || '')}', ${Math.floor(expiresAtMs)})`

  execSql(sql).catch(err => {
    console.error(`[TRACKER-DB] Persist failed for ${roomId.slice(0, 16)}...: ${err.message}`)
  })
}

// ── Load active rooms from DB ────────────────────────────────────
// Returns { local: [...], federated: [...] } with room data from DB.
// Each entry: { roomId, metadata64, entryRelay, isPrivate, sourceRelay, expiresAt }
async function loadRooms() {
  if (!available) return { local: [], federated: [] }

  try {
    const nowMs = Date.now()
    const result = await execSql(
      `SELECT room_id, metadata, entry_relay, is_private, federated, source_relay, expires_at FROM tracker_rooms LATEST BY room_id WHERE expires_at > ${nowMs}`,
      10000
    )

    if (!result.dataset) return { local: [], federated: [] }

    const local = []
    const federated = []

    for (const row of result.dataset) {
      const entry = {
        roomId: row[0],
        metadata64: row[1],
        entryRelay: row[2],
        isPrivate: row[3],
        sourceRelay: row[5],
        expiresAt: row[6],
      }
      if (row[4]) {
        federated.push(entry)
      } else {
        local.push(entry)
      }
    }

    console.log(`[TRACKER-DB] Loaded ${local.length} local + ${federated.length} federated rooms from DB`)
    return { local, federated }
  } catch (err) {
    console.error(`[TRACKER-DB] Load failed: ${err.message}`)
    return { local: [], federated: [] }
  }
}

// ── Status ───────────────────────────────────────────────────────
function isAvailable() {
  return available
}

module.exports = {
  initDb,
  persistRoom,
  loadRooms,
  isAvailable,
}
