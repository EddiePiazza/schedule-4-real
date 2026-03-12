'use strict'
/**
 * Tunnel Agent — connects to ALL available relays simultaneously and proxies
 * guest traffic to the local Nuxt server (localhost:3000).
 *
 * Maintains persistent WebSocket connections to every known relay, so the room
 * is reachable via any relay. If one relay goes down, others still work.
 *
 * Config (from .env or environment):
 *   TUNNEL_ENABLED    — set to "true" to activate
 *   API_PORT          — local Nuxt port (default 3000)
 */

const http = require('node:http')
const { randomBytes, createHmac } = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const WebSocket = require('ws')

// ── Load .env ──────────────────────────────────────────────────────
const envPath = path.join(__dirname, '../../.env')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.substring(0, eq)
    let val = trimmed.substring(eq + 1)
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

// ── Config ─────────────────────────────────────────────────────────
const ENABLED = process.env.TUNNEL_ENABLED === 'true'
const LOCAL_PORT = parseInt(process.env.API_PORT || '3000', 10)
const LOCAL_HOST = '127.0.0.1'
const KEY_FILE = path.join(__dirname, '../../data/room3d/tunnel-key.json')
const PEERS_FILE = path.join(__dirname, '../../data/relay/peers.json')
const RELAY_CONFIG_FILE = path.join(__dirname, '../../data/relay/relay-config.json')
const HEARTBEAT_INTERVAL = 20_000
const RECONNECT_BASE = 3000
const RECONNECT_MAX = 120_000
const PEER_REFRESH_INTERVAL = 300_000 // 5 minutes

if (!ENABLED) {
  console.log('[TUNNEL-AGENT] Disabled (TUNNEL_ENABLED != true). Exiting.')
  process.exit(0)
}

// ── Room key ────────────────────────────────────────────────────────
function loadOrCreateRoomKey() {
  try {
    const data = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8'))
    if (data.roomKey && /^[a-f0-9]{32}$/.test(data.roomKey)) return data.roomKey
  } catch {}

  const roomKey = randomBytes(16).toString('hex')
  const dir = path.dirname(KEY_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(KEY_FILE, JSON.stringify({ roomKey }, null, 2), { mode: 0o600 })
  console.log(`[TUNNEL-AGENT] Generated new room key: ${roomKey.substring(0, 8)}...`)
  return roomKey
}

const ROOM_KEY = loadOrCreateRoomKey()
let destroyed = false

// ── Relay URL discovery ─────────────────────────────────────────────
function getLocalRelayUrl() {
  try {
    if (fs.existsSync(RELAY_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(RELAY_CONFIG_FILE, 'utf-8'))
      if (cfg.enabled) return `ws://127.0.0.1:${cfg.port || 9443}`
    }
  } catch {}
  return null
}

function getRelayPublicUrl() {
  try {
    if (fs.existsSync(RELAY_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(RELAY_CONFIG_FILE, 'utf-8'))
      if (cfg.publicUrl) return cfg.publicUrl
    }
  } catch {}
  return null
}

/**
 * Check if two relay URLs point to the same relay (by hostname).
 */
function isSameRelay(url1, url2) {
  try {
    const toHttp = u => u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    const h1 = new URL(toHttp(url1)).hostname
    const h2 = new URL(toHttp(url2)).hostname
    return h1 === h2
  } catch { return false }
}

/**
 * Normalize a URL to have a valid WebSocket protocol.
 * Returns null if the URL is invalid.
 */
function normalizeWsUrl(url) {
  if (!url || typeof url !== 'string') return null
  let u = url.trim()
  // Add protocol if missing
  if (!u.match(/^wss?:\/\//)) {
    u = `wss://${u}`
  }
  // Validate
  try {
    new URL(u.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'))
    return u
  } catch {
    return null
  }
}

/**
 * Discover all relay URLs. Returns de-duplicated list by hostname.
 * For each relay, generates tunnel URL candidates (the peer URL might need
 * different paths for the /tunnel WebSocket endpoint).
 */
function discoverRelayUrls() {
  const byHost = new Map() // hostname → url (dedup by host)

  function addUrl(url) {
    const norm = normalizeWsUrl(url)
    if (!norm) return
    try {
      const h = new URL(norm.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')).hostname
      if (!byHost.has(h)) byHost.set(h, norm)
    } catch {}
  }

  // 1. Local relay (lowest latency) — if running, connects via loopback
  const localUrl = getLocalRelayUrl()
  let localPublicUrl = null
  if (localUrl) {
    addUrl(localUrl)
    // Remember the publicUrl so we skip it in peers (same relay, reached via loopback)
    localPublicUrl = getRelayPublicUrl()
  }

  // 2. Known peers from gossip (other relays — skip our own publicUrl)
  try {
    if (fs.existsSync(PEERS_FILE)) {
      const peers = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf-8'))
      if (Array.isArray(peers)) {
        for (const peer of peers) {
          if (!peer.url || (peer.failures || 0) >= 5) continue
          // Skip our own relay's publicUrl (already connected via loopback)
          if (localPublicUrl && isSameRelay(peer.url, localPublicUrl)) continue
          addUrl(peer.url)
        }
      }
    }
  } catch {}

  return Array.from(byHost.values())
}

/**
 * Generate tunnel URL candidates for a relay URL.
 * The relay might accept /tunnel at different paths depending on nginx config.
 * Returns array of URLs to try in order.
 */
function getTunnelCandidates(relayUrl) {
  const candidates = []
  try {
    const parsed = new URL(relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'))
    const proto = relayUrl.startsWith('ws://') ? 'ws:' : 'wss:'
    const origin = `${proto}//${parsed.host}`

    // 1. Root path first: origin + /tunnel — works on all relay versions
    candidates.push(origin + '/tunnel')

    // 2. Direct append: peer URL + /tunnel (e.g., wss://host/rooms/tunnel)
    const withPath = relayUrl.replace(/\/$/, '') + '/tunnel'
    if (withPath !== candidates[0]) {
      candidates.push(withPath)
    }

    // 3. Common relay path: origin + /relay/tunnel
    if (!relayUrl.includes('/relay')) {
      candidates.push(origin + '/relay/tunnel')
    }
  } catch {
    // Fallback: just append /tunnel
    candidates.push(relayUrl.replace(/\/$/, '') + '/tunnel')
  }
  return candidates
}

// ── Multi-relay connection manager ──────────────────────────────────
// relayUrl → { ws, heartbeatTimer, reconnectDelay, reconnectTimer, registered, localWsChannels }
const connections = new Map()

function getShortUrl(url) {
  return url.replace(/^wss?:\/\//, '')
}

/**
 * Ensure a connection exists for each known relay URL.
 * New relays get a fresh connection. Removed relays are cleaned up.
 */
function syncConnections() {
  const urls = discoverRelayUrls()

  if (urls.length === 0) {
    console.error('[TUNNEL-AGENT] No relay URLs available. Will retry in 30s...')
    setTimeout(syncConnections, 30000)
    return
  }

  // Start connections for new URLs
  for (const url of urls) {
    if (!connections.has(url)) {
      const conn = {
        url,
        ws: null,
        heartbeatTimer: null,
        reconnectDelay: RECONNECT_BASE,
        reconnectTimer: null,
        registered: false,
        localWsChannels: new Map(),
        tunnelAttempt: 0,
        workingTunnelUrl: null,
      }
      connections.set(url, conn)
      connectRelay(conn)
    }
  }

  // Remove relays that are no longer in the discovered list
  const urlSet = new Set(urls)
  for (const [url, conn] of connections) {
    if (!urlSet.has(url)) {
      console.log(`[TUNNEL-AGENT] Removing stale relay: ${getShortUrl(url)}`)
      disconnectRelay(conn)
      connections.delete(url)
    }
  }

  // Log status
  const connected = Array.from(connections.values()).filter(c => c.registered).length
  console.log(`[TUNNEL-AGENT] ${connections.size} relay(s), ${connected} connected: ${urls.map(getShortUrl).join(', ')}`)
}

function connectRelay(conn) {
  if (destroyed || !conn) return

  // If we previously found a working URL, use it directly
  let tunnelUrl
  if (conn.workingTunnelUrl) {
    tunnelUrl = conn.workingTunnelUrl
  } else {
    const candidates = getTunnelCandidates(conn.url)
    const candidateIdx = conn.tunnelAttempt % candidates.length
    tunnelUrl = candidates[candidateIdx]
    conn.tunnelAttempt++
  }

  console.log(`[TUNNEL-AGENT] Connecting to ${tunnelUrl}...`)

  let ws
  try {
    ws = new WebSocket(tunnelUrl, {
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    })
  } catch (err) {
    console.error(`[TUNNEL-AGENT] Invalid URL ${tunnelUrl}: ${err.message}`)
    scheduleReconnect(conn)
    return
  }
  conn.ws = ws

  // Challenge timeout — if no challenge received in 10s, the path is wrong
  let challengeReceived = false
  const challengeTimeout = setTimeout(() => {
    if (!challengeReceived && ws.readyState === WebSocket.OPEN) {
      console.log(`[TUNNEL-AGENT] No challenge from ${getShortUrl(conn.url)} — trying different path...`)
      ws.close(4000, 'no challenge')
    }
  }, 10000)

  ws.on('open', () => {
    console.log(`[TUNNEL-AGENT] Connected to ${getShortUrl(conn.url)}, waiting for challenge...`)
    conn.reconnectDelay = RECONNECT_BASE
    conn.pongReceived = true

    conn.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (!conn.pongReceived) {
        console.log(`[TUNNEL-AGENT] No pong from ${getShortUrl(conn.url)} — forcing reconnect`)
        ws.terminate()
        return
      }
      conn.pongReceived = false
      ws.ping()
    }, HEARTBEAT_INTERVAL)
  })

  ws.on('pong', () => { conn.pongReceived = true })

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryMessage(conn, Buffer.from(data))
    } else {
      const text = data.toString()
      try {
        const msg = JSON.parse(text)
        if (msg.type === 'challenge' && msg.nonce) {
          challengeReceived = true
          clearTimeout(challengeTimeout)
          // Remember working tunnel URL for this relay
          conn.workingTunnelUrl = tunnelUrl
          const hmac = createHmac('sha256', ROOM_KEY).update(msg.nonce).digest('hex')
          ws.send(JSON.stringify({ type: 'register', roomKey: ROOM_KEY, hmac }))
          console.log(`[TUNNEL-AGENT] Challenge from ${getShortUrl(conn.url)}, registering...`)
          return
        }
      } catch {}
      handleTextMessage(conn, text)
    }
  })

  ws.on('close', (code, reason) => {
    clearTimeout(challengeTimeout)
    const wasRegistered = conn.registered
    conn.registered = false
    cleanupConn(conn)

    if (reason?.toString() === 'replaced') {
      console.log(`[TUNNEL-AGENT] Replaced on ${getShortUrl(conn.url)} — reconnecting in ${conn.reconnectDelay}ms...`)
    } else if (wasRegistered) {
      console.log(`[TUNNEL-AGENT] Lost connection to ${getShortUrl(conn.url)} (${code}). Reconnecting in ${conn.reconnectDelay}ms...`)
    } else {
      // Don't spam logs for expected path-probing failures
      if (code !== 4000) {
        console.log(`[TUNNEL-AGENT] Disconnected from ${getShortUrl(conn.url)} (${code}: ${reason || ''}). Reconnecting...`)
      }
    }

    scheduleReconnect(conn)
  })

  ws.on('error', (err) => {
    clearTimeout(challengeTimeout)
    if (ws.readyState !== WebSocket.CLOSING && ws.readyState !== WebSocket.CLOSED) {
      console.error(`[TUNNEL-AGENT] Error on ${getShortUrl(conn.url)}: ${err.message}`)
    }
  })
}

function cleanupConn(conn) {
  if (conn.heartbeatTimer) { clearInterval(conn.heartbeatTimer); conn.heartbeatTimer = null }
  for (const [, localWs] of conn.localWsChannels) {
    try { localWs.close(1001, 'tunnel disconnected') } catch {}
  }
  conn.localWsChannels.clear()
  conn.ws = null
}

function disconnectRelay(conn) {
  if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null }
  // Close ws BEFORE cleanupConn (which nulls conn.ws)
  if (conn.ws) {
    try { conn.ws.close(1000, 'shutdown') } catch {}
  }
  cleanupConn(conn)
}

function scheduleReconnect(conn) {
  if (destroyed) return
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null
    conn.reconnectDelay = Math.min(conn.reconnectDelay * 1.5, RECONNECT_MAX)
    if (connections.has(conn.url)) connectRelay(conn)
  }, conn.reconnectDelay)
}

// ── Handle text messages from relay ────────────────────────────────
function handleTextMessage(conn, text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }

  switch (msg.type) {
    case 'registered':
      conn.registered = true
      conn.reconnectDelay = RECONNECT_BASE
      console.log(`[TUNNEL-AGENT] Registered on ${getShortUrl(conn.url)}`)
      break

    case 'http-request':
      handleHttpRequest(conn, msg)
      break

    case 'ws-open':
      handleWsOpen(conn, msg)
      break

    case 'ws-message':
      handleWsMessage(conn, msg)
      break

    case 'ws-close':
      handleWsClose(conn, msg)
      break
  }
}

// ── Handle binary messages from relay ──────────────────────────────
function handleBinaryMessage(conn, buf) {
  if (buf.length < 4) return
  const channelId = buf.readUInt32BE(0)
  const payload = buf.subarray(4)

  const localWs = conn.localWsChannels.get(channelId)
  if (localWs && localWs.readyState === WebSocket.OPEN) {
    localWs.send(payload, { binary: true })
  }
}

// ── HTTP request proxy ─────────────────────────────────────────────
function handleHttpRequest(conn, msg) {
  const { id, method, path: reqPath, headers, body } = msg

  const options = {
    hostname: LOCAL_HOST,
    port: LOCAL_PORT,
    path: reqPath,
    method: method || 'GET',
    headers: { ...headers },
  }
  options.headers['host'] = `${LOCAL_HOST}:${LOCAL_PORT}`

  const req = http.request(options, (res) => {
    sendToRelay(conn, JSON.stringify({
      type: 'http-response-head',
      id,
      status: res.statusCode,
      headers: filterResponseHeaders(res.headers),
    }))

    res.on('data', (chunk) => {
      const frame = Buffer.alloc(4 + chunk.length)
      frame.writeUInt32BE(id, 0)
      chunk.copy(frame, 4)
      sendBinaryToRelay(conn, frame)
    })

    res.on('end', () => {
      sendToRelay(conn, JSON.stringify({ type: 'http-response-end', id }))
    })

    res.on('error', () => {
      sendToRelay(conn, JSON.stringify({ type: 'http-response-end', id }))
    })
  })

  req.on('error', (err) => {
    console.error(`[TUNNEL-AGENT] Local request failed (${reqPath}): ${err.message}`)
    sendToRelay(conn, JSON.stringify({
      type: 'http-response-head',
      id,
      status: 502,
      headers: { 'content-type': 'text/plain' },
    }))
    const errBuf = Buffer.from('Local server error')
    const frame = Buffer.alloc(4 + errBuf.length)
    frame.writeUInt32BE(id, 0)
    errBuf.copy(frame, 4)
    sendBinaryToRelay(conn, frame)
    sendToRelay(conn, JSON.stringify({ type: 'http-response-end', id }))
  })

  req.setTimeout(120000, () => {
    req.destroy(new Error('timeout'))
  })

  if (body) {
    req.write(Buffer.from(body, 'base64'))
  }
  req.end()
}

function filterResponseHeaders(headers) {
  const filtered = {}
  for (const [k, v] of Object.entries(headers)) {
    if (['connection', 'keep-alive', 'transfer-encoding'].includes(k.toLowerCase())) continue
    filtered[k] = v
  }
  return filtered
}

// ── WebSocket channel proxy ────────────────────────────────────────
function handleWsOpen(conn, msg) {
  const { id, path: wsPath, headers } = msg

  const localUrl = `ws://${LOCAL_HOST}:${LOCAL_PORT}${wsPath}`
  const localWs = new WebSocket(localUrl, {
    headers: headers || {},
    perMessageDeflate: false,
  })

  conn.localWsChannels.set(id, localWs)

  localWs.on('message', (data, isBinary) => {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return
    try {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        const frame = Buffer.alloc(4 + buf.length)
        frame.writeUInt32BE(id, 0)
        buf.copy(frame, 4)
        sendBinaryToRelay(conn, frame)
      } else {
        sendToRelay(conn, JSON.stringify({
          type: 'ws-message',
          id,
          data: data.toString(),
          binary: false,
        }))
      }
    } catch {}
  })

  localWs.on('close', (code, reason) => {
    conn.localWsChannels.delete(id)
    sendToRelay(conn, JSON.stringify({
      type: 'ws-close',
      id,
      code,
      reason: reason?.toString() || '',
    }))
  })

  localWs.on('error', (err) => {
    console.error(`[TUNNEL-AGENT] Local WS error (channel ${id}): ${err.message}`)
    conn.localWsChannels.delete(id)
    sendToRelay(conn, JSON.stringify({
      type: 'ws-close',
      id,
      code: 1001,
      reason: 'local error',
    }))
  })
}

function handleWsMessage(conn, msg) {
  const localWs = conn.localWsChannels.get(msg.id)
  if (!localWs || localWs.readyState !== WebSocket.OPEN) return

  if (msg.binary) {
    localWs.send(Buffer.from(msg.data, 'base64'), { binary: true })
  } else {
    localWs.send(msg.data)
  }
}

function handleWsClose(conn, msg) {
  const localWs = conn.localWsChannels.get(msg.id)
  if (localWs) {
    try { localWs.close(msg.code || 1000, msg.reason || '') } catch {}
    conn.localWsChannels.delete(msg.id)
  }
}

// ── Send helpers ───────────────────────────────────────────────────
function sendToRelay(conn, text) {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
    try { conn.ws.send(text) } catch {}
  }
}

function sendBinaryToRelay(conn, buf) {
  if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
    try { conn.ws.send(buf) } catch {}
  }
}

// ── Startup ────────────────────────────────────────────────────────
console.log(`[TUNNEL-AGENT] Room key: ${ROOM_KEY.substring(0, 8)}...`)
console.log(`[TUNNEL-AGENT] Local server: http://${LOCAL_HOST}:${LOCAL_PORT}`)

// Initial sync + periodic refresh
syncConnections()
setInterval(syncConnections, PEER_REFRESH_INTERVAL)

// ── Graceful shutdown ──────────────────────────────────────────────
function shutdown() {
  console.log('[TUNNEL-AGENT] Shutting down...')
  destroyed = true
  for (const [, conn] of connections) {
    disconnectRelay(conn)
  }
  connections.clear()
  setTimeout(() => process.exit(0), 1000)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
