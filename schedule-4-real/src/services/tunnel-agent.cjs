'use strict'
/**
 * Tunnel Agent — connects to an onion relay and proxies guest traffic
 * to the local Nuxt server (localhost:3000).
 *
 * The relay acts as a transparent reverse proxy. This agent maintains
 * a persistent WebSocket to the relay and handles:
 * - HTTP request/response forwarding (JSON text frames)
 * - WebSocket channel bridging (multiplayer, voice, MQTT)
 * - Binary data streaming (GLB models, images)
 *
 * Config (from .env or environment):
 *   TUNNEL_RELAY_URL  — e.g. wss://r2.imaset.com
 *   TUNNEL_ENABLED    — set to "true" to activate
 *   API_PORT          — local Nuxt port (default 3000)
 */

const http = require('node:http')
const { randomBytes } = require('node:crypto')
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
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = val
  }
}

// ── Config ─────────────────────────────────────────────────────────
const PRIMARY_RELAY_URL = process.env.TUNNEL_RELAY_URL || ''
const ENABLED = process.env.TUNNEL_ENABLED === 'true'
const LOCAL_PORT = parseInt(process.env.API_PORT || '3000', 10)
const LOCAL_HOST = '127.0.0.1'
const KEY_FILE = path.join(__dirname, '../../data/room3d/tunnel-key.json')
const PEERS_FILE = path.join(__dirname, '../../data/relay/peers.json')
const RELAY_CONFIG_FILE = path.join(__dirname, '../../data/relay/relay-config.json')
const HEARTBEAT_INTERVAL = 30_000
const RECONNECT_BASE = 2000
const RECONNECT_MAX = 60_000
const RELAY_ROTATE_INTERVAL = 4 * 60 * 60 * 1000 // Rotate relay every 4 hours

if (!ENABLED) {
  console.log('[TUNNEL-AGENT] Disabled (TUNNEL_ENABLED != true). Exiting.')
  process.exit(0)
}

// ── Multi-relay URL management ────────────────────────────────────
let relayUrls = []  // Ordered list of relay URLs to try
let currentRelayIdx = 0

function getLocalRelayUrl() {
  try {
    if (fs.existsSync(RELAY_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(RELAY_CONFIG_FILE, 'utf-8'))
      if (cfg.enabled) {
        return `ws://127.0.0.1:${cfg.port || 9443}`
      }
    }
  } catch {}
  return null
}

function loadRelayUrls() {
  const urls = new Set()

  // 1. Local relay first (lowest latency, most trusted)
  const localUrl = getLocalRelayUrl()
  if (localUrl) urls.add(localUrl)

  // 2. Primary from .env
  if (PRIMARY_RELAY_URL) urls.add(PRIMARY_RELAY_URL)

  // 3. Known peers from gossip
  try {
    if (fs.existsSync(PEERS_FILE)) {
      const peers = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf-8'))
      if (Array.isArray(peers)) {
        // Shuffle peers for load distribution
        const shuffled = peers.filter(p => p.url && p.failures < 3).sort(() => Math.random() - 0.5)
        for (const peer of shuffled) {
          urls.add(peer.url)
        }
      }
    }
  } catch {}

  relayUrls = Array.from(urls)
  if (relayUrls.length > 0) {
    console.log(`[TUNNEL-AGENT] ${relayUrls.length} relay(s) available: ${relayUrls.map(u => u.replace(/^wss?:\/\//, '')).join(', ')}`)
  }
}

function getCurrentRelayUrl() {
  if (relayUrls.length === 0) return null
  return relayUrls[currentRelayIdx % relayUrls.length]
}

function advanceToNextRelay() {
  if (relayUrls.length <= 1) return
  currentRelayIdx = (currentRelayIdx + 1) % relayUrls.length
  console.log(`[TUNNEL-AGENT] Switching to relay: ${getCurrentRelayUrl()}`)
}

// Load initial relay list
loadRelayUrls()

// Refresh peer list every 5 minutes
setInterval(loadRelayUrls, 300_000)

// Rotate relay every 4 hours for diversity
setInterval(() => {
  if (relayUrls.length > 1) {
    advanceToNextRelay()
    // Trigger reconnect to new relay
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[TUNNEL-AGENT] Rotating to a different relay...')
      ws.close(1000, 'relay rotation')
    }
  }
}, RELAY_ROTATE_INTERVAL)

if (relayUrls.length === 0) {
  console.error('[TUNNEL-AGENT] No relay URLs available (TUNNEL_RELAY_URL not set, no local relay, no peers). Exiting.')
  process.exit(1)
}

// ── Room key management ────────────────────────────────────────────
function loadOrCreateRoomKey() {
  try {
    const data = JSON.parse(fs.readFileSync(KEY_FILE, 'utf-8'))
    if (data.roomKey && /^[a-f0-9]{32}$/.test(data.roomKey)) {
      return data.roomKey
    }
  } catch {}

  // Generate new room key
  const roomKey = randomBytes(16).toString('hex')
  const dir = path.dirname(KEY_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(KEY_FILE, JSON.stringify({ roomKey }, null, 2))
  console.log(`[TUNNEL-AGENT] Generated new room key: ${roomKey.substring(0, 8)}...`)
  return roomKey
}

const ROOM_KEY = loadOrCreateRoomKey()
console.log(`[TUNNEL-AGENT] Room key: ${ROOM_KEY.substring(0, 8)}...`)
console.log(`[TUNNEL-AGENT] Primary relay: ${PRIMARY_RELAY_URL || '(none)'}`)
console.log(`[TUNNEL-AGENT] Local server: http://${LOCAL_HOST}:${LOCAL_PORT}`)

// ── Active WebSocket channels (guest WS connections proxied through tunnel) ──
// channelId → WebSocket to local server
const localWsChannels = new Map()

// ── Relay connection ───────────────────────────────────────────────
let ws = null
let reconnectDelay = RECONNECT_BASE
let heartbeatTimer = null
let destroyed = false

function connect() {
  if (destroyed) return

  const relayUrl = getCurrentRelayUrl()
  if (!relayUrl) {
    console.error('[TUNNEL-AGENT] No relay available. Retrying in 30s...')
    setTimeout(() => { loadRelayUrls(); connect() }, 30000)
    return
  }

  const tunnelUrl = `${relayUrl}/tunnel`
  console.log(`[TUNNEL-AGENT] Connecting to ${tunnelUrl}...`)

  ws = new WebSocket(tunnelUrl, {
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
  })

  ws.on('open', () => {
    console.log('[TUNNEL-AGENT] Connected to relay, registering...')
    reconnectDelay = RECONNECT_BASE

    // Send registration
    ws.send(JSON.stringify({ type: 'register', roomKey: ROOM_KEY }))

    // Start heartbeat
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    }, HEARTBEAT_INTERVAL)
  })

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryMessage(Buffer.from(data))
    } else {
      handleTextMessage(data.toString())
    }
  })

  ws.on('close', (code, reason) => {
    console.log(`[TUNNEL-AGENT] Disconnected (${code}: ${reason || 'no reason'}). Reconnecting in ${reconnectDelay}ms...`)
    cleanup()
    scheduleReconnect()
  })

  ws.on('error', (err) => {
    console.error(`[TUNNEL-AGENT] Connection error: ${err.message}`)
  })
}

function cleanup() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  // Close all local WS channels
  for (const [id, localWs] of localWsChannels) {
    try { localWs.close(1001, 'tunnel disconnected') } catch {}
  }
  localWsChannels.clear()
  ws = null
}

function scheduleReconnect() {
  if (destroyed) return
  // On disconnect, try the next relay (failover)
  advanceToNextRelay()
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX)
    // Refresh peer list in case new relays appeared
    loadRelayUrls()
    connect()
  }, reconnectDelay)
}

// ── Handle text messages from relay ────────────────────────────────
function handleTextMessage(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }

  switch (msg.type) {
    case 'registered':
      console.log(`[TUNNEL-AGENT] Registered with relay. Room key: ${msg.roomKey?.substring(0, 8)}...`)
      break

    case 'http-request':
      handleHttpRequest(msg)
      break

    case 'ws-open':
      handleWsOpen(msg)
      break

    case 'ws-message':
      handleWsMessage(msg)
      break

    case 'ws-close':
      handleWsClose(msg)
      break
  }
}

// ── Handle binary messages from relay ──────────────────────────────
function handleBinaryMessage(buf) {
  if (buf.length < 4) return
  const channelId = buf.readUInt32BE(0)
  const payload = buf.subarray(4)

  // Forward to local WS channel
  const localWs = localWsChannels.get(channelId)
  if (localWs && localWs.readyState === WebSocket.OPEN) {
    localWs.send(payload, { binary: true })
  }
}

// ── HTTP request proxy (streaming) ────────────────────────────────
function handleHttpRequest(msg) {
  const { id, method, path: reqPath, headers, body } = msg

  const options = {
    hostname: LOCAL_HOST,
    port: LOCAL_PORT,
    path: reqPath,
    method: method || 'GET',
    headers: { ...headers },
  }

  // Set correct host header for local server
  options.headers['host'] = `${LOCAL_HOST}:${LOCAL_PORT}`

  const req = http.request(options, (res) => {
    // Send headers immediately
    sendToRelay(JSON.stringify({
      type: 'http-response-head',
      id,
      status: res.statusCode,
      headers: filterResponseHeaders(res.headers),
    }))

    // Stream body as binary chunks: [4-byte uint32 id][payload]
    res.on('data', (chunk) => {
      const frame = Buffer.alloc(4 + chunk.length)
      frame.writeUInt32BE(id, 0)
      chunk.copy(frame, 4)
      sendBinaryToRelay(frame)
    })

    res.on('end', () => {
      sendToRelay(JSON.stringify({ type: 'http-response-end', id }))
    })

    res.on('error', () => {
      sendToRelay(JSON.stringify({ type: 'http-response-end', id }))
    })
  })

  req.on('error', (err) => {
    console.error(`[TUNNEL-AGENT] Local request failed (${reqPath}): ${err.message}`)
    // Send error as a complete streaming response
    sendToRelay(JSON.stringify({
      type: 'http-response-head',
      id,
      status: 502,
      headers: { 'content-type': 'text/plain' },
    }))
    const errBuf = Buffer.from('Local server error')
    const frame = Buffer.alloc(4 + errBuf.length)
    frame.writeUInt32BE(id, 0)
    errBuf.copy(frame, 4)
    sendBinaryToRelay(frame)
    sendToRelay(JSON.stringify({ type: 'http-response-end', id }))
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
    // Skip hop-by-hop headers
    if (['connection', 'keep-alive', 'transfer-encoding'].includes(k.toLowerCase())) continue
    filtered[k] = v
  }
  return filtered
}

// ── WebSocket channel proxy ────────────────────────────────────────
function handleWsOpen(msg) {
  const { id, path: wsPath, headers } = msg

  const localUrl = `ws://${LOCAL_HOST}:${LOCAL_PORT}${wsPath}`
  const localWs = new WebSocket(localUrl, {
    headers: headers || {},
    perMessageDeflate: false,
  })

  localWsChannels.set(id, localWs)

  localWs.on('open', () => {
    // Channel is ready — relay doesn't need explicit ack
  })

  localWs.on('message', (data, isBinary) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      if (isBinary) {
        // Binary: [4-byte channelId][payload]
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        const frame = Buffer.alloc(4 + buf.length)
        frame.writeUInt32BE(id, 0)
        buf.copy(frame, 4)
        sendBinaryToRelay(frame)
      } else {
        sendToRelay(JSON.stringify({
          type: 'ws-message',
          id,
          data: data.toString(),
          binary: false,
        }))
      }
    } catch {}
  })

  localWs.on('close', (code, reason) => {
    localWsChannels.delete(id)
    sendToRelay(JSON.stringify({
      type: 'ws-close',
      id,
      code,
      reason: reason?.toString() || '',
    }))
  })

  localWs.on('error', (err) => {
    console.error(`[TUNNEL-AGENT] Local WS error (channel ${id}): ${err.message}`)
    localWsChannels.delete(id)
    sendToRelay(JSON.stringify({
      type: 'ws-close',
      id,
      code: 1001,
      reason: 'local error',
    }))
  })
}

function handleWsMessage(msg) {
  const localWs = localWsChannels.get(msg.id)
  if (!localWs || localWs.readyState !== WebSocket.OPEN) return

  if (msg.binary) {
    localWs.send(Buffer.from(msg.data, 'base64'), { binary: true })
  } else {
    localWs.send(msg.data)
  }
}

function handleWsClose(msg) {
  const localWs = localWsChannels.get(msg.id)
  if (localWs) {
    try { localWs.close(msg.code || 1000, msg.reason || '') } catch {}
    localWsChannels.delete(msg.id)
  }
}

// ── Send helpers ───────────────────────────────────────────────────
function sendToRelay(text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(text) } catch {}
  }
}

function sendBinaryToRelay(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(buf) } catch {}
  }
}

// ── Graceful shutdown ──────────────────────────────────────────────
function shutdown() {
  console.log('[TUNNEL-AGENT] Shutting down...')
  destroyed = true
  cleanup()
  if (ws) {
    try { ws.close(1000, 'shutdown') } catch {}
  }
  setTimeout(() => process.exit(0), 1000)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ── Start ──────────────────────────────────────────────────────────
connect()
