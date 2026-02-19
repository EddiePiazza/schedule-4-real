// ═══════════════════════════════════════════════════════════════════
// index.cjs — Relay + Tracker entry point (integrated into s4r)
// Starts HTTP server, 3 WS servers, gossip loop, cleanup timers
// ═══════════════════════════════════════════════════════════════════
'use strict'

const { createServer } = require('node:http')
const { WebSocketServer } = require('ws')

const { loadConfig, loadIdentity, loadPeers, savePeers, SEED_NODES } = require('./config.cjs')
const { generateKxKeypair, generateSignKeypair } = require('./crypto.cjs')
const { configure: configureRelay, setTrackerHandler, handlePacket, rotateKeys, getRelayPublicKey } = require('./relay.cjs')
const { configure: configureCircuits, cleanupExpired: cleanupCircuits, activeCount } = require('./circuits.cjs')
const { cleanupPendingRendezvous } = require('./rendezvous.cjs')
const { startChaff, stopChaff } = require('./chaff.cjs')
const { configure: configureTracker, handleTrackerMessage, listPublicRooms, setFederatedRooms, roomCount, cleanupExpiredRooms } = require('./tracker.cjs')
const gossip = require('./gossip.cjs')
const {
  registerHost, resolveSession, createSession, getHostTunnel, getDefaultRoomKey,
  proxyHttpRequest, getNextReqId, proxyWebSocket,
  cleanupExpiredSessions, tunnelStats,
} = require('./tunnel-proxy.cjs')
let joinPage = null
try { joinPage = require('./join-page.cjs') } catch { /* loaded when available */ }

// ── Load configuration ──────────────────────────────────────────────
const cfg = loadConfig()
const identity = loadIdentity()
const trackerEnabled = cfg.trackerEnabled === true // default false (privacy first)

// Configure sub-modules
const kxKeypair = generateKxKeypair(identity.kxSeed)
const signKeypair = generateSignKeypair(identity.signSeed)

configureRelay({
  keySeed: identity.kxSeed,
  packetSize: cfg.packetSize || 512,
  maxJitter: cfg.maxJitterMs || 3,
  trackerInternalPort: null, // tracker is co-hosted, we'll wire it directly
  trackerUrl: null,
})

configureCircuits({
  maxCircuits: cfg.maxCircuits || 10000,
  sessionTtl: cfg.sessionTtlMs || 300000,
})

if (trackerEnabled) {
  configureTracker({
    roomTtlMs: cfg.roomTtlMs || 120000,
    maxRooms: cfg.maxRooms || 50000,
  })
  // Wire relay → tracker directly (no WS roundtrip for co-hosted tracker)
  setTrackerHandler((data, ws, circuitIdBuf) => {
    return handleTrackerMessage(data, ws, circuitIdBuf)
  })
}

gossip.configure({
  url: cfg.publicUrl || '',
  kxPublicKey: kxKeypair.publicKey.toString('hex'),
  signPublicKey: signKeypair.publicKey.toString('hex'),
  signSecretKey: signKeypair.secretKey,
  // Room federation: when gossip fetches rooms from a peer tracker,
  // merge them into our local tracker as federated rooms
  onFederatedRooms: trackerEnabled ? (sourceRelay, rooms) => {
    setFederatedRooms(sourceRelay, rooms)
  } : null,
})

// ── Collect request body ────────────────────────────────────────────
function collectBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) { req.destroy(); reject(new Error('body too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ── Parse room key from /join/ROOMKEY.TOKEN ─────────────────────────
function parseJoinPath(url) {
  const match = url.match(/^\/join\/([a-f0-9]{16,64})\.(.+)/)
  if (!match) return null
  return { roomKey: match[1], token: match[2] }
}

// ── HTTP server ─────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = req.url || '/'

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.writeHead(204)
    res.end()
    return
  }

  // ── Public endpoints ──────────────────────────────────────────

  // Relay public key
  if (req.method === 'GET' && url === '/pk') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      publicKey: getRelayPublicKey().toString('hex'),
      signPublicKey: signKeypair.publicKey.toString('hex'),
    }))
    return
  }

  // Public rooms list (only when tracker is enabled)
  // Metadata is encrypted — returned as base64 for client decryption and peer federation
  if (req.method === 'GET' && (url === '/' || url === '/api/rooms' || url === '/rooms')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (!trackerEnabled) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ rooms: [], trackerEnabled: false }))
      return
    }
    const publicRooms = listPublicRooms()
    const result = publicRooms.map(r => ({
      id: r.roomId,
      metadata: r.metadata.toString('base64'),
      relay: r.entryRelay,
      federated: !!r.federated,
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ rooms: result }))
    return
  }

  // Room registration via HTTP (for server-side auto-publishers)
  // Accepts: { roomId (hex), metadata (base64), entryRelay (url), private (bool) }
  if (req.method === 'POST' && (url === '/api/register' || url === '/register')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (!trackerEnabled) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Tracker not enabled' }))
      return
    }
    try {
      const body = await collectBody(req, 8192)
      const data = JSON.parse(body.toString('utf8'))
      if (!data.roomId || !data.metadata || !data.entryRelay) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Missing roomId, metadata, or entryRelay' }))
        return
      }
      const roomIdBuf = Buffer.from(data.roomId, 'hex')
      if (roomIdBuf.length !== 32) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'roomId must be 64 hex chars (32 bytes)' }))
        return
      }
      const metadataBuf = Buffer.from(data.metadata, 'base64')
      const entryRelayBuf = Buffer.from(data.entryRelay, 'utf8')
      const isPrivate = data.private === true

      // Build register payload matching the onion protocol format
      const payload = Buffer.alloc(1 + 1 + 32 + 2 + entryRelayBuf.length + metadataBuf.length)
      payload[0] = 0x40 // TRACKER_REGISTER
      payload[1] = isPrivate ? 0x01 : 0x00
      roomIdBuf.copy(payload, 2)
      payload.writeUInt16BE(entryRelayBuf.length, 34)
      entryRelayBuf.copy(payload, 36)
      metadataBuf.copy(payload, 36 + entryRelayBuf.length)

      const result = handleTrackerMessage(payload, null, null)
      const success = result && result.length >= 2 && result[1] === 0x01
      res.writeHead(success ? 200 : 503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: success }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Invalid request' }))
    }
    return
  }

  // Gossip: peer list
  if (req.method === 'GET' && url === '/peers') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(gossip.getPeerList()))
    return
  }

  // Gossip: receive peer announcement
  if (req.method === 'POST' && url === '/peers/announce') {
    try {
      const body = await collectBody(req, 4096)
      const announcement = JSON.parse(body.toString('utf8'))
      if (gossip.verifyAnnouncement(announcement)) {
        gossip.mergePeers([announcement])
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid signature' }))
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad request' }))
    }
    return
  }

  // Stats (internal, no sensitive data)
  if (req.method === 'GET' && (url === '/api/stats' || url === '/stats')) {
    const ts = tunnelStats()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      circuits: activeCount(),
      rooms: trackerEnabled ? roomCount() : 0,
      tunnelHosts: ts.hosts,
      tunnelSessions: ts.sessions,
      peers: gossip.getPeerList().length,
      trackerEnabled,
    }))
    return
  }

  // ── Public rooms page: /join (no token) ─────────────────────────
  if (req.method === 'GET' && (url === '/join' || url === '/join/')) {
    if (!trackerEnabled || !joinPage) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body style="background:#111;color:#888;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>No public rooms available</p></body></html>')
      return
    }
    try {
      const html = await joinPage.renderJoinPage(listPublicRooms, cfg.publicUrl || '')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    } catch (err) {
      console.error('[RELAY] Join page render error:', err.message)
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal error')
    }
    return
  }

  // ── Join route: /join/ROOMKEY.TOKEN ──────────────────────────────
  const joinInfo = parseJoinPath(url)
  if (joinInfo) {
    const tunnel = getHostTunnel(joinInfo.roomKey)
    if (!tunnel) {
      res.writeHead(503, { 'Content-Type': 'text/html' })
      res.end('<h1>Room Offline</h1><p>The host is not currently connected. Try again later.</p>')
      return
    }

    // Create session, set cookie
    const sessionId = createSession(joinInfo.roomKey)
    const secure = (req.headers['x-forwarded-proto'] === 'https' || (cfg.publicUrl || '').startsWith('wss')) ? '; Secure' : ''
    res.setHeader('Set-Cookie', `__sfr=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure}`)

    // Proxy the initial request to host
    const hostPath = `/join/${joinInfo.roomKey}.${joinInfo.token}`
    const reqId = getNextReqId(tunnel)
    const headers = { ...req.headers }
    delete headers['host']
    headers['x-forwarded-host'] = req.headers.host || ''

    proxyHttpRequest(tunnel, reqId, 'GET', hostPath, headers, null, res)
    return
  }

  // ── Session-based proxy ──────────────────────────────────────────
  // Block /index.html — relay should not serve the host's main app
  if (url === '/index.html') {
    res.writeHead(404)
    res.end()
    return
  }

  let roomKey = resolveSession(req.headers.cookie)
  // Fallback: if no session but exactly one host is tunneled, use it
  if (!roomKey) roomKey = getDefaultRoomKey()
  if (roomKey) {
    const tunnel = getHostTunnel(roomKey)
    if (!tunnel) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end('Host disconnected')
      return
    }

    const reqId = getNextReqId(tunnel)
    const headers = { ...req.headers }
    delete headers['host']
    headers['x-forwarded-host'] = req.headers.host || ''

    let body = null
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await collectBody(req)
      } catch {
        res.writeHead(413, { 'Content-Type': 'text/plain' })
        res.end('Request too large')
        return
      }
    }

    proxyHttpRequest(tunnel, reqId, req.method, url, headers, body, res)
    return
  }

  // No session, no join — 404
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found')
})

// ── WebSocket servers (noServer mode for path-based routing) ────────
const wssCircuit = new WebSocketServer({
  noServer: true,
  maxPayload: (cfg.packetSize || 512) * 2,
  perMessageDeflate: false,
  clientTracking: false,
})

const wssTunnel = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024 * 1024, // 64 MB for GLB files etc.
  perMessageDeflate: false,
  clientTracking: false,
})

const wssGuest = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024, // 1 MB
  perMessageDeflate: false,
  clientTracking: false,
})

// Circuit-level WebSocket (onion relay)
wssCircuit.on('connection', (ws) => {
  ws.on('message', (data) => {
    handlePacket(Buffer.from(data), ws)
  })
  ws.on('error', () => {})
})

// Host tunnel registration
wssTunnel.on('connection', (ws) => {
  let registered = false

  const timeout = setTimeout(() => {
    if (!registered) ws.close(4001, 'registration timeout')
  }, 10000)

  ws.on('message', (data) => {
    if (!registered) {
      clearTimeout(timeout)
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'register' && msg.roomKey && /^[a-f0-9]{16,64}$/.test(msg.roomKey)) {
          registered = true
          registerHost(ws, msg.roomKey)
          ws.send(JSON.stringify({ type: 'registered', roomKey: msg.roomKey }))
        } else {
          ws.close(4002, 'invalid registration')
        }
      } catch {
        ws.close(4003, 'bad message')
      }
      return
    }
  })

  ws.on('error', () => {})
})

// Guest WebSocket proxy
wssGuest.on('connection', (ws, req) => {
  // roomKey may be attached by the upgrade handler (single-host fallback)
  const roomKey = req._roomKey || resolveSession(req.headers.cookie)
  if (!roomKey) {
    ws.close(4010, 'no session')
    return
  }

  const tunnel = getHostTunnel(roomKey)
  if (!tunnel) {
    ws.close(4011, 'host offline')
    return
  }

  proxyWebSocket(tunnel, ws, req.url, req.headers)
})

// ── HTTP Upgrade handler (route WS by path) ─────────────────────────
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/'

  // Host tunnel
  if (url === '/tunnel') {
    wssTunnel.handleUpgrade(req, socket, head, (ws) => {
      wssTunnel.emit('connection', ws, req)
    })
    return
  }

  // Guest WebSocket paths (need session cookie or single-host fallback)
  if (url.startsWith('/_room3d-ws') || url.startsWith('/_ws') || url.startsWith('/mqtt')) {
    let roomKey = resolveSession(req.headers.cookie)
    // Fallback: if no session but exactly one host is tunneled, use it
    if (!roomKey) roomKey = getDefaultRoomKey()
    if (roomKey && getHostTunnel(roomKey)) {
      req._roomKey = roomKey // pass to wssGuest handler
      wssGuest.handleUpgrade(req, socket, head, (ws) => {
        wssGuest.emit('connection', ws, req)
      })
      return
    }
    // No host available — close cleanly instead of falling to circuit handler
    socket.destroy()
    return
  }

  // Default: circuit-level relay WS
  wssCircuit.handleUpgrade(req, socket, head, (ws) => {
    wssCircuit.emit('connection', ws, req)
  })
})

// ── Start server ────────────────────────────────────────────────────
const port = cfg.port || 9443
server.listen(port, () => {
  const pk = getRelayPublicKey().toString('hex')
  console.log(`[RELAY] Listening on port ${port}`)
  console.log(`[RELAY] Public Key: ${pk}`)
  console.log(`[RELAY] Sign Key:  ${signKeypair.publicKey.toString('hex')}`)
  if (cfg.publicUrl) console.log(`[RELAY] Public URL: ${cfg.publicUrl}`)
  console.log(`[RELAY] HTTP tunnel proxy active`)
  if (trackerEnabled) {
    console.log(`[RELAY] Tracker active (rooms TTL: ${cfg.roomTtlMs || 120000}ms)`)
  } else {
    console.log(`[RELAY] Tracker disabled (relay-only mode)`)
  }
})

// ── Start gossip protocol ───────────────────────────────────────────
gossip.start()

// Initial fetch from all seed nodes
for (const seed of SEED_NODES) {
  if (seed.url && seed.url !== cfg.publicUrl) {
    gossip.fetchPeersFrom(seed.url).catch(() => {})
  }
}

// ── Cleanup every 30s ───────────────────────────────────────────────
setInterval(() => {
  cleanupCircuits()
  cleanupPendingRendezvous()
  cleanupExpiredSessions()
  cleanupExpiredRooms()
}, 30000)

// ── Key rotation ────────────────────────────────────────────────────
setInterval(() => {
  rotateKeys()
  console.log(`[RELAY] Keys rotated. New PK: ${getRelayPublicKey().toString('hex')}`)
}, cfg.keyRotationIntervalMs || 3600000)

// ── Metrics every 60s ───────────────────────────────────────────────
setInterval(() => {
  const ts = tunnelStats()
  const peers = gossip.getPeerList().length
  console.log(`[RELAY] Circuits: ${activeCount()} | Rooms: ${roomCount()} | Peers: ${peers} | Tunnel: ${ts.hosts}h/${ts.sessions}s`)
}, 60000)

// ── Chaff traffic to known peers ────────────────────────────────────
// Start chaff to active peers (refreshed periodically)
let chaffStarted = false
function refreshChaff() {
  const activePeers = gossip.getActivePeers()
    .filter(p => p.url !== cfg.publicUrl)
    .map(p => p.url)
  if (activePeers.length > 0) {
    startChaff(activePeers, cfg.packetSize || 512, cfg.chaffIntervalMs || 100)
    if (!chaffStarted) {
      console.log(`[RELAY] Chaff started to ${activePeers.length} peers`)
      chaffStarted = true
    }
  }
}

// Refresh chaff targets every 5min
setTimeout(refreshChaff, 10000) // initial delay for gossip to populate
setInterval(refreshChaff, 300000)

// ── Safety net ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[RELAY] Uncaught exception (non-fatal):', err.message)
})

// ── Graceful shutdown ───────────────────────────────────────────────
function shutdown() {
  console.log('[RELAY] Shutting down...')
  gossip.stop()
  stopChaff()
  savePeers(gossip.getPeerList())
  server.close(() => process.exit(0))
  // Force exit after 5s if server.close() hangs
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
