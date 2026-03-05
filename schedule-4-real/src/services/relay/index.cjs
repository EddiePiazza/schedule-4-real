// ═══════════════════════════════════════════════════════════════════
// index.cjs — Relay + Tracker entry point (integrated into s4r)
// Starts HTTP server, 3 WS servers, gossip loop, cleanup timers
// ═══════════════════════════════════════════════════════════════════
'use strict'

const { createServer } = require('node:http')
const { createHmac, randomBytes: cryptoRandomBytes, timingSafeEqual } = require('node:crypto')
const { WebSocketServer } = require('ws')

const { loadConfig, loadIdentity, loadPeers, savePeers, SEED_NODES } = require('./config.cjs')
const { generateKxKeypair, generateSignKeypair, verify: cryptoVerify } = require('./crypto.cjs')
const { configure: configureRelay, setTrackerHandler, handlePacket, pushToCircuitById, rotateKeys, getRelayPublicKey } = require('./relay.cjs')
const { configure: configureCircuits, cleanupExpired: cleanupCircuits, activeCount } = require('./circuits.cjs')
const { cleanupPendingRendezvous } = require('./rendezvous.cjs')
const { startChaff, stopChaff } = require('./chaff.cjs')
const { configure: configureTracker, handleTrackerMessage, setCircuitPush, listPublicRooms, setFederatedRooms, roomCount, cleanupExpiredRooms } = require('./tracker.cjs')
const gossip = require('./gossip.cjs')
const {
  registerHost, resolveSession, createSession, getHostTunnel, getDefaultRoomKey,
  proxyHttpRequest, getNextReqId, proxyWebSocket,
  cleanupExpiredSessions, tunnelStats,
} = require('./tunnel-proxy.cjs')
const { createRateLimiter } = require('./rate-limit.cjs')
let joinPage = null
try { joinPage = require('./join-page.cjs') } catch { /* loaded when available */ }

// ── Rate limiters (per-IP) ──────────────────────────────────────────
const rl = {
  register:   createRateLimiter(30, 60_000),    // 30 registrations/min
  announce:   createRateLimiter(10, 60_000),     // 10 announcements/min
  query:      createRateLimiter(60, 60_000),     // 60 queries/min
  peers:      createRateLimiter(30, 60_000),     // 30 peer fetches/min
  general:    createRateLimiter(120, 60_000),    // 120 requests/min general
}

// ── Signature nonce cache (anti-replay for /peers challenge-response) ──
const usedSigs = new Map() // sigPrefix -> expiry timestamp
setInterval(() => {
  const now = Date.now()
  for (const [k, exp] of usedSigs) { if (exp < now) usedSigs.delete(k) }
}, 30_000)

// Only trust X-Forwarded-For from known reverse proxies (prevents rate limit bypass)
// Supports TRUSTED_PROXIES env var (comma-separated IPs) for custom deployments
const TRUSTED_PROXIES = new Set([
  '127.0.0.1', '::1', '::ffff:127.0.0.1',
  ...(process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean),
])

function getClientIp(req) {
  const remoteAddr = req.socket?.remoteAddress || '0.0.0.0'
  if (TRUSTED_PROXIES.has(remoteAddr)) {
    const xff = req.headers['x-forwarded-for']
    if (xff) return xff.split(',')[0].trim()
  }
  return remoteAddr
}

function rateLimited(res, ip, limiterName) {
  if (!rl[limiterName]) return false
  if (!rl[limiterName].check(ip)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
    res.end(JSON.stringify({ error: 'Rate limit exceeded' }))
    return true
  }
  return false
}

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
  // Wire tracker push → relay circuit encryption (for INTRODUCE_DATA etc.)
  setCircuitPush(pushToCircuitById)
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

  const clientIp = getClientIp(req)

  // CORS preflight — only allow GET endpoints from browsers
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.writeHead(204)
    res.end()
    return
  }

  // ── Public endpoints ──────────────────────────────────────────

  // Relay public key
  if (req.method === 'GET' && url === '/pk') {
    if (rateLimited(res, clientIp, 'general')) return
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'public, max-age=60')
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
    if (rateLimited(res, clientIp, 'query')) return
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
      relayPk: r.entryRelayPk || '',
      federated: !!r.federated,
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ rooms: result }))
    return
  }

  // ── Session creation via POST /rooms/session (for server-side relay proxies)
  // Avoids relying on Set-Cookie which gets stripped by nginx/Cloudflare proxy chains
  // Accepts: { inviteToken: "ROOMKEY.TOKEN" }
  // Returns: { ok: true, session: "hex64" } or { ok: false, error: "..." }
  if (req.method === 'POST' && (url === '/rooms/session' || url === '/api/session')) {
    if (rateLimited(res, clientIp, 'query')) return
    res.setHeader('Access-Control-Allow-Origin', '*')
    let body = ''
    req.on('data', (chunk) => { body += chunk; if (body.length > 1024) req.destroy() })
    req.on('end', () => {
      try {
        const { inviteToken } = JSON.parse(body)
        if (!inviteToken || typeof inviteToken !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Missing inviteToken' }))
          return
        }
        // Parse token same as /join/ path
        const match = inviteToken.match(/^([a-f0-9]{16,64})\.(.+)/)
        if (!match) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid token format' }))
          return
        }
        const roomKey = match[1]
        const tunnel = getHostTunnel(roomKey)
        if (!tunnel) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Room offline' }))
          return
        }
        const sessionId = createSession(roomKey)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, session: sessionId }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
      }
    })
    return
  }

  // Room registration via HTTP (for server-side auto-publishers)
  // Accepts: { roomId (hex), metadata (base64), entryRelay (url), private (bool) }
  if (req.method === 'POST' && (url === '/api/register' || url === '/register')) {
    if (rateLimited(res, clientIp, 'register')) return
    // No wildcard CORS — registration is server-to-server only
    if (!trackerEnabled) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Tracker not enabled' }))
      return
    }
    try {
      const body = await collectBody(req, 4096) // Tighter limit for registration
      const data = JSON.parse(body.toString('utf8'))
      if (!data.roomId || !data.metadata || !data.entryRelay) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Missing roomId, metadata, or entryRelay' }))
        return
      }
      // Validate roomId format
      if (typeof data.roomId !== 'string' || !/^[0-9a-f]{64}$/i.test(data.roomId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'roomId must be 64 hex chars (32 bytes)' }))
        return
      }
      const roomIdBuf = Buffer.from(data.roomId, 'hex')
      // Validate entryRelay: either a ws(s):// URL or a 64-hex-char Ed25519 signPk
      const isUrl = typeof data.entryRelay === 'string' && (data.entryRelay.startsWith('wss://') || data.entryRelay.startsWith('ws://')) && data.entryRelay.length <= 256
      const isPk = typeof data.entryRelay === 'string' && /^[0-9a-f]{64}$/i.test(data.entryRelay)
      if (!isUrl && !isPk) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'entryRelay must be a valid ws:// or wss:// URL or 64-hex-char signPk' }))
        return
      }
      // Validate metadata size (encrypted metadata shouldn't be huge)
      if (typeof data.metadata !== 'string' || data.metadata.length > 2048) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'metadata too large' }))
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
  // With valid Ed25519 challenge-response from another relay → full list with URLs
  // Without valid signature → public list, no URLs (browser/curl safe)
  if (req.method === 'GET' && url.startsWith('/peers')) {
    if (rateLimited(res, clientIp, 'peers')) return
    const parsedUrl = new URL(req.url, 'http://localhost')
    const ts = parsedUrl.searchParams.get('ts') || ''
    const pk = parsedUrl.searchParams.get('pk') || ''
    const sigHex = parsedUrl.searchParams.get('sig') || ''
    let isRelay = false

    if (ts && pk && sigHex && /^[0-9a-f]{64}$/i.test(pk) && /^[0-9a-f]{128}$/i.test(sigHex)) {
      const age = Math.abs(Date.now() - parseInt(ts, 10))
      const sigKey = sigHex.slice(0, 32) // First 16 bytes as cache key
      if (age < 30_000 && !usedSigs.has(sigKey)) { // 30s window + replay prevention
        const mySpk = signKeypair.publicKey.toString('hex')
        const msg = Buffer.from(`peers|${ts}|${pk}|${mySpk}`) // Target binding
        const sig = Buffer.from(sigHex, 'hex')
        const pubKey = Buffer.from(pk, 'hex')
        try {
          isRelay = cryptoVerify(sig, msg, pubKey)
            && gossip.getPeerList().some(p => p.signPk?.toLowerCase() === pk.toLowerCase())
          if (isRelay) usedSigs.set(sigKey, Date.now() + 30_000)
        } catch { isRelay = false }
      }
    }

    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cache-Control', 'public, max-age=30')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(isRelay ? gossip.getPeerList() : gossip.getPeerListPublic()))
    return
  }

  // Gossip: receive peer announcement
  if (req.method === 'POST' && url === '/peers/announce') {
    if (rateLimited(res, clientIp, 'announce')) return
    try {
      const body = await collectBody(req, 2048) // Announcements are small
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

  // Gossip: receive key revocation
  if (req.method === 'POST' && url === '/peers/revoke') {
    if (rateLimited(res, clientIp, 'announce')) return
    try {
      const body = await collectBody(req, 1024)
      const revocation = JSON.parse(body.toString('utf8'))
      if (gossip.processRevocation(revocation)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid revocation' }))
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Bad request' }))
    }
    return
  }

  // Stats — expose relay metrics for the /system dashboard
  if (req.method === 'GET' && (url === '/api/stats' || url === '/stats')) {
    if (rateLimited(res, clientIp, 'general')) return
    const ts = tunnelStats()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      trackerEnabled,
      peers: gossip.getPeerList().length,
      circuits: activeCount(),
      rooms: roomCount(),
      tunnelHosts: ts.hosts,
      tunnelSessions: ts.sessions,
    }))
    return
  }

  // ── Public rooms page: /join (no token) ─────────────────────────
  if (req.method === 'GET' && (url === '/join' || url === '/join/')) {
    if (rateLimited(res, clientIp, 'general')) return
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

    // If caller accepts JSON, return session directly (avoids cookie being stripped by proxies)
    const accept = (req.headers['accept'] || '').toLowerCase()
    if (accept.includes('application/json')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, session: sessionId }))
      return
    }

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

// Host tunnel registration (HMAC challenge-response)
wssTunnel.on('connection', (ws) => {
  let registered = false
  const challenge = cryptoRandomBytes(32).toString('hex')

  const timeout = setTimeout(() => {
    if (!registered) ws.close(4001, 'registration timeout')
  }, 10000)

  // Send challenge immediately
  ws.send(JSON.stringify({ type: 'challenge', nonce: challenge }))

  ws.on('message', (data) => {
    if (!registered) {
      clearTimeout(timeout)
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'register' && msg.roomKey && /^[a-f0-9]{16,64}$/.test(msg.roomKey)) {
          // Verify HMAC if provided (required for v1.72+, optional for older agents)
          if (msg.hmac) {
            const expected = createHmac('sha256', msg.roomKey).update(challenge).digest('hex')
            const expectedBuf = Buffer.from(expected, 'hex')
            const providedBuf = Buffer.from(msg.hmac, 'hex')
            if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
              ws.close(4004, 'HMAC verification failed')
              return
            }
          }
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

// ── WebSocket connection rate limiter ────────────────────────────────
const wsConnectLimiter = createRateLimiter(30, 60_000) // 30 WS connections/min per IP

// ── HTTP Upgrade handler (route WS by path) ─────────────────────────
server.on('upgrade', (req, socket, head) => {
  const url = req.url || '/'
  const wsIp = getClientIp(req)
  if (!wsConnectLimiter.check(wsIp)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
    socket.destroy()
    return
  }

  // Host tunnel
  if (url === '/tunnel') {
    wssTunnel.handleUpgrade(req, socket, head, (ws) => {
      wssTunnel.emit('connection', ws, req)
    })
    return
  }

  // Guest WebSocket paths (need session cookie, ?rk= query param, or single-host fallback)
  if (url.startsWith('/_room3d-ws') || url.startsWith('/_ws') || url.startsWith('/mqtt')) {
    let roomKey = resolveSession(req.headers.cookie)
    // Fallback: check ?rk=ROOMKEY query param (cross-origin WS connections can't send cookies)
    if (!roomKey) {
      const qIdx = url.indexOf('?')
      if (qIdx >= 0) {
        const params = new URLSearchParams(url.substring(qIdx))
        const rk = params.get('rk')
        if (rk && getHostTunnel(rk)) roomKey = rk
      }
    }
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

// ── Chaff traffic (conditional) ──────────────────────────────────────
// Only activates when 2+ circuits exist (real users) and only sends to
// direct peers (ws://) — never to Cloudflare-proxied URLs (wss://) which
// count each WebSocket frame as an HTTP request.
let chaffActive = false
setInterval(() => {
  const circuits = activeCount()
  if (circuits >= 2 && !chaffActive) {
    // Only chaff to direct (non-Cloudflare) peers
    const directPeers = gossip.getPeerList()
      .filter(p => p.url && p.url.startsWith('ws://'))
      .map(p => p.url)
    if (directPeers.length > 0) {
      startChaff(directPeers, cfg.packetSize || 512, cfg.chaffIntervalMs || 1000)
      chaffActive = true
      console.log(`[RELAY] Chaff started → ${directPeers.length} direct peers (${circuits} circuits)`)
    }
  } else if (circuits < 2 && chaffActive) {
    stopChaff()
    chaffActive = false
    console.log('[RELAY] Chaff stopped — fewer than 2 circuits')
  }
}, 30000)

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
