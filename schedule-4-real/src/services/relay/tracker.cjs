// ═══════════════════════════════════════════════════════════════════
// tracker.cjs — Room tracker for the onion network
// In-memory Maps for runtime, QuestDB persistence via tracker-db.cjs
// ═══════════════════════════════════════════════════════════════════
'use strict'

const trackerDb = require('./tracker-db.cjs')

// ── Message types ────────────────────────────────────────────────
const MSG_REGISTER     = 0x40
const MSG_QUERY        = 0x41
const MSG_RESPONSE     = 0x42
const MSG_HEARTBEAT    = 0x43
const MSG_INTRODUCE    = 0x44
const MSG_INTRO_DATA   = 0x45

// ── Configuration ────────────────────────────────────────────────
let roomTtlMs = 120000
let maxRooms  = 50000

// ── Data structures ──────────────────────────────────────────────
// roomId (hex) → { metadata: Buffer, entryRelay: string, isPrivate: boolean, createdAt: number, expiresAt: number }
const rooms = new Map()
// roomId (hex) → { ws, circuitId } for INTRODUCE routing
const circuitSessions = new Map()
// roomId (hex) → { metadata: Buffer, entryRelay: string, sourceRelay: string, expiresAt: number }
// Rooms fetched from peer trackers — never re-shared to prevent loops
const federatedRooms = new Map()

let cleanupTimer = null

// ── Configuration ────────────────────────────────────────────────
function configure(opts) {
  if (opts.roomTtlMs) roomTtlMs = opts.roomTtlMs
  if (opts.maxRooms) maxRooms = opts.maxRooms

  // Start cleanup interval if not already running
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => {
      cleanupExpiredRooms()
    }, 30000)
    if (cleanupTimer.unref) cleanupTimer.unref()
  }

  // Initialize DB and load persisted rooms (async, non-blocking)
  trackerDb.initDb().then(ok => {
    if (!ok) return
    return trackerDb.loadRooms()
  }).then(loaded => {
    if (!loaded) return
    // Merge into existing Maps (don't overwrite fresh registrations)
    for (const entry of loaded.local) {
      if (!rooms.has(entry.roomId)) {
        rooms.set(entry.roomId, {
          metadata: Buffer.from(entry.metadata64, 'base64'),
          entryRelay: entry.entryRelay,
          isPrivate: entry.isPrivate,
          createdAt: Date.now(),
          expiresAt: entry.expiresAt,
        })
      }
    }
    for (const entry of loaded.federated) {
      if (!federatedRooms.has(entry.roomId) && !rooms.has(entry.roomId)) {
        federatedRooms.set(entry.roomId, {
          metadata: Buffer.from(entry.metadata64, 'base64'),
          entryRelay: entry.entryRelay,
          sourceRelay: entry.sourceRelay,
          expiresAt: entry.expiresAt,
        })
      }
    }
    console.log(`[TRACKER] DB restored: ${loaded.local.length} local + ${loaded.federated.length} federated rooms`)
  }).catch(err => {
    console.error(`[TRACKER] DB init error: ${err.message}`)
  })
}

// ── Main message handler ─────────────────────────────────────────
// data: Buffer (after 4-byte circuitId prefix is stripped by relay)
// ws: WebSocket of the circuit's inbound connection
// circuitId: 4-byte circuit identifier
// Returns Buffer response or null
function handleTrackerMessage(data, ws, circuitId) {
  if (!data || data.length < 1) return null
  const type = data[0]

  switch (type) {
    case MSG_REGISTER:  return handleRegister(data, ws, circuitId)
    case MSG_QUERY:     return handleQuery(data)
    case MSG_HEARTBEAT: return handleHeartbeat(data)
    case MSG_INTRODUCE: return handleIntroduce(data)
    default:            return null
  }
}

// ── REGISTER (0x40) ──────────────────────────────────────────────
// Layout: type(1) + flags(1) + roomId(32) + relayLen(2 BE) + relay(utf8) + metadata(rest)
function handleRegister(data, ws, circuitId) {
  // Minimum: type(1) + flags(1) + roomId(32) + relayLen(2) = 36
  if (data.length < 36) return null

  const flags = data[1]
  const isPrivate = (flags & 0x01) !== 0
  const roomId = data.subarray(2, 34).toString('hex')
  const relayLen = data.readUInt16BE(34)

  if (data.length < 36 + relayLen) return null
  const entryRelay = data.subarray(36, 36 + relayLen).toString('utf8')
  const metadata = Buffer.from(data.subarray(36 + relayLen))

  // Enforce room limit (allow re-registration of existing room)
  if (!rooms.has(roomId) && rooms.size >= maxRooms) {
    return Buffer.from([MSG_RESPONSE, 0x00])
  }

  const now = Date.now()
  const expiresAt = now + roomTtlMs

  rooms.set(roomId, {
    metadata,
    entryRelay,
    isPrivate,
    createdAt: rooms.has(roomId) ? rooms.get(roomId).createdAt : now,
    expiresAt,
  })

  // Store circuit session for INTRODUCE routing
  circuitSessions.set(roomId, { ws, circuitId })

  // Persist to DB (fire-and-forget)
  trackerDb.persistRoom(roomId, metadata.toString('base64'), entryRelay, isPrivate, false, '', expiresAt)

  console.log(`[TRACKER] Room registered: ${roomId.slice(0, 16)}... relay=${entryRelay} private=${isPrivate} total=${rooms.size}`)
  return Buffer.from([MSG_RESPONSE, 0x01])
}

// ── QUERY (0x41) ─────────────────────────────────────────────────
// Layout: type(1) + cursor(4 BE) + count(2 BE)
function handleQuery(data) {
  if (data.length < 7) return null

  const cursor = data.readUInt32BE(1)
  let count = data.readUInt16BE(5)
  if (count > 100) count = 100

  // Collect public rooms (local + federated) for cursor-based pagination
  const now = Date.now()
  const publicRooms = []
  for (const [roomId, room] of rooms) {
    if (room.isPrivate) continue
    if (room.expiresAt <= now) continue
    publicRooms.push({ roomId, ...room })
  }
  // Include federated rooms from peer trackers
  for (const [roomId, room] of federatedRooms) {
    if (room.expiresAt <= now) continue
    if (rooms.has(roomId)) continue // local takes priority
    publicRooms.push({ roomId, metadata: room.metadata, entryRelay: room.entryRelay })
  }

  // Cursor is an index offset into the public rooms list
  const start = Math.min(cursor, publicRooms.length)
  const slice = publicRooms.slice(start, start + count)
  const nextCursor = start + slice.length

  // Build response: type(1) + nextCursor(4 BE) + roomCount(2 BE) + entries
  const entries = []
  let totalEntrySize = 0

  for (const entry of slice) {
    const roomIdBuf = Buffer.from(entry.roomId, 'hex') // 32 bytes
    const relayBuf = Buffer.from(entry.entryRelay, 'utf8')
    const relayLenBuf = Buffer.alloc(2)
    relayLenBuf.writeUInt16BE(relayBuf.length, 0)
    const metaLenBuf = Buffer.alloc(2)
    metaLenBuf.writeUInt16BE(entry.metadata.length, 0)

    const entryBuf = Buffer.concat([roomIdBuf, relayLenBuf, relayBuf, metaLenBuf, entry.metadata])
    entries.push(entryBuf)
    totalEntrySize += entryBuf.length
  }

  const header = Buffer.alloc(7)
  header[0] = MSG_RESPONSE
  header.writeUInt32BE(nextCursor, 1)
  header.writeUInt16BE(slice.length, 5)

  return Buffer.concat([header, ...entries], 7 + totalEntrySize)
}

// ── HEARTBEAT (0x43) ─────────────────────────────────────────────
// Layout: type(1) + roomId(32)
function handleHeartbeat(data) {
  if (data.length < 33) return null

  const roomId = data.subarray(1, 33).toString('hex')
  const room = rooms.get(roomId)

  if (!room) {
    return Buffer.from([MSG_RESPONSE, 0x00])
  }

  // Reset TTL
  const expiresAt = Date.now() + roomTtlMs
  room.expiresAt = expiresAt
  console.log(`[TRACKER] Heartbeat: ${roomId.slice(0, 16)}... TTL renewed`)

  // Persist updated TTL to DB (fire-and-forget)
  trackerDb.persistRoom(roomId, room.metadata.toString('base64'), room.entryRelay, room.isPrivate, false, '', expiresAt)

  return Buffer.from([MSG_RESPONSE, 0x01])
}

// ── INTRODUCE (0x44) ─────────────────────────────────────────────
// Layout: type(1) + roomId(32) + cookie(20) + relayUrlLen(2 BE) + relayUrl(utf8)
function handleIntroduce(data) {
  // Minimum: type(1) + roomId(32) + cookie(20) + relayUrlLen(2) = 55
  if (data.length < 55) return null

  const roomId = data.subarray(1, 33).toString('hex')
  const cookie = data.subarray(33, 53)
  const relayUrlLen = data.readUInt16BE(53)

  if (data.length < 55 + relayUrlLen) return null
  const relayUrl = data.subarray(55, 55 + relayUrlLen)

  // Look up host's circuit session
  const session = circuitSessions.get(roomId)
  if (!session || !session.ws || session.ws.readyState !== 1) {
    // Host is offline — clean up stale session
    if (session) circuitSessions.delete(roomId)
    return Buffer.from([MSG_RESPONSE, 0x00])
  }

  // Build INTRODUCE_DATA (0x45) to forward to host's circuit
  // Layout: circuitId(4) + type(1) + cookie(20) + relayUrlLen(2 BE) + relayUrl
  const relayUrlLenBuf = Buffer.alloc(2)
  relayUrlLenBuf.writeUInt16BE(relayUrlLen, 0)

  const introData = Buffer.concat([
    session.circuitId,
    Buffer.from([MSG_INTRO_DATA]),
    cookie,
    relayUrlLenBuf,
    relayUrl,
  ])

  try {
    session.ws.send(introData)
    return Buffer.from([MSG_RESPONSE, 0x01])
  } catch {
    circuitSessions.delete(roomId)
    return Buffer.from([MSG_RESPONSE, 0x00])
  }
}

// ── Push helper ──────────────────────────────────────────────────
// Returns { ws, circuitId } for sending push messages to a room's host
function pushToCircuit(roomId) {
  const session = circuitSessions.get(roomId)
  if (!session || !session.ws || session.ws.readyState !== 1) return null
  return { ws: session.ws, circuitId: session.circuitId }
}

// ── Federated rooms (from peer trackers) ─────────────────────────

/**
 * Replace federated rooms from a specific peer tracker.
 * @param {string} sourceRelay - URL of the peer tracker
 * @param {Array<{roomId: string, metadata: string, entryRelay: string}>} peerRooms
 *   metadata is base64-encoded encrypted blob
 */
function setFederatedRooms(sourceRelay, peerRooms) {
  if (!Array.isArray(peerRooms)) return

  // Remove old entries from this source
  for (const [roomId, room] of federatedRooms) {
    if (room.sourceRelay === sourceRelay) {
      federatedRooms.delete(roomId)
    }
  }

  const now = Date.now()
  const ttl = roomTtlMs * 1.5 // Federated rooms get slightly longer TTL

  for (const pr of peerRooms) {
    if (!pr.roomId || !pr.metadata || !pr.entryRelay) continue
    // Skip rooms we already have locally (local takes priority)
    if (rooms.has(pr.roomId)) continue

    const expiresAt = now + ttl

    try {
      federatedRooms.set(pr.roomId, {
        metadata: Buffer.from(pr.metadata, 'base64'),
        entryRelay: pr.entryRelay,
        sourceRelay,
        expiresAt,
      })

      // Persist federated room to DB
      trackerDb.persistRoom(pr.roomId, pr.metadata, pr.entryRelay, false, true, sourceRelay, expiresAt)
    } catch { /* skip malformed entries */ }
  }
}

// ── List public rooms (for HTTP /rooms endpoint) ─────────────────
function listPublicRooms() {
  const now = Date.now()
  const result = []

  // Local rooms
  for (const [roomId, room] of rooms) {
    if (room.isPrivate) continue
    if (room.expiresAt <= now) continue
    result.push({
      roomId,
      metadata: room.metadata,
      entryRelay: room.entryRelay,
      federated: false,
    })
  }

  // Federated rooms from peer trackers
  for (const [roomId, room] of federatedRooms) {
    if (room.expiresAt <= now) continue
    // Skip if we already have it locally
    if (rooms.has(roomId)) continue
    result.push({
      roomId,
      metadata: room.metadata,
      entryRelay: room.entryRelay,
      federated: true,
    })
  }

  return result
}

// ── Stats ────────────────────────────────────────────────────────
function roomCount() {
  const now = Date.now()
  let count = 0
  for (const room of rooms.values()) {
    if (room.expiresAt > now) count++
  }
  for (const [roomId, room] of federatedRooms) {
    if (room.expiresAt > now && !rooms.has(roomId)) count++
  }
  return count
}

// ── Cleanup ──────────────────────────────────────────────────────
function cleanupExpiredRooms() {
  const now = Date.now()

  // Remove expired rooms
  for (const [roomId, room] of rooms) {
    if (room.expiresAt <= now) {
      rooms.delete(roomId)
      circuitSessions.delete(roomId)
    }
  }

  // Remove expired federated rooms
  for (const [roomId, room] of federatedRooms) {
    if (room.expiresAt <= now) {
      federatedRooms.delete(roomId)
    }
  }

  // Remove circuit sessions with closed WebSockets
  for (const [roomId, session] of circuitSessions) {
    if (!session.ws || session.ws.readyState > 1) {
      circuitSessions.delete(roomId)
    }
  }
}

module.exports = {
  configure,
  handleTrackerMessage,
  pushToCircuit,
  listPublicRooms,
  setFederatedRooms,
  roomCount,
  cleanupExpiredRooms,
}
