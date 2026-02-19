// ═══════════════════════════════════════════════════════════════════
// tunnel-proxy.cjs — HTTP/WS tunnel proxy (host ↔ guest)
// Adapted from onion-relay/src/tunnel.js to CJS
// ═══════════════════════════════════════════════════════════════════
'use strict'

const { randomBytes } = require('./crypto.cjs')

// ── Host tunnel registry ──────────────────────────────────────────────
// roomKey (hex string) → { ws, pendingHttp: Map<id,{res,chunks,timer}>, nextReqId, wsChannels: Map }
const hostTunnels = new Map()

// ── Guest sessions ────────────────────────────────────────────────────
// sessionId (hex string) → { roomKey, createdAt }
const sessions = new Map()

const SESSION_TTL = 24 * 60 * 60 * 1000 // 24h
const HTTP_TIMEOUT = 30_000             // 30s per HTTP request

// ── Host registration ─────────────────────────────────────────────────

function registerHost(ws, roomKey) {
  const existing = hostTunnels.get(roomKey)
  if (existing && existing.ws !== ws) {
    try { existing.ws.close(1000, 'replaced') } catch {}
  }

  const tunnel = {
    ws,
    pendingHttp: new Map(),
    nextReqId: 1,
    wsChannels: new Map(), // channelId → guestWs
  }
  hostTunnels.set(roomKey, tunnel)

  ws.on('close', () => {
    if (hostTunnels.get(roomKey)?.ws === ws) {
      for (const [, pending] of tunnel.pendingHttp) {
        clearTimeout(pending.timer)
        try {
          if (!pending.res.writableEnded) {
            if (!pending.res.headersSent) {
              pending.res.writeHead(502, { 'Content-Type': 'text/plain' })
            }
            pending.res.end('Host disconnected')
          }
        } catch {}
      }
      for (const [, guestWs] of tunnel.wsChannels) {
        try { guestWs.close(1001, 'host disconnected') } catch {}
      }
      hostTunnels.delete(roomKey)
      console.log(`[TUNNEL] Host disconnected: ${roomKey.substring(0, 8)}...`)
    }
  })

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleHostBinary(tunnel, Buffer.from(data))
    } else {
      handleHostText(tunnel, data.toString())
    }
  })

  console.log(`[TUNNEL] Host registered: ${roomKey.substring(0, 8)}...`)
}

function handleHostText(tunnel, text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }

  switch (msg.type) {
    case 'http-response-head': {
      const pending = tunnel.pendingHttp.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      pending.timer = setTimeout(() => {
        tunnel.pendingHttp.delete(msg.id)
        if (!pending.res.writableEnded) {
          try { pending.res.end() } catch {}
        }
      }, 120_000)

      const headers = msg.headers || {}
      delete headers['transfer-encoding']
      delete headers['connection']

      try {
        pending.headersWritten = true
        pending.res.writeHead(msg.status || 200, headers)
      } catch {}
      break
    }

    case 'http-response-end': {
      const pending = tunnel.pendingHttp.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      tunnel.pendingHttp.delete(msg.id)
      try {
        if (!pending.res.writableEnded) pending.res.end()
      } catch {}
      break
    }

    case 'ws-message': {
      const guestWs = tunnel.wsChannels.get(msg.id)
      if (guestWs && guestWs.readyState === 1) {
        if (msg.binary) {
          guestWs.send(Buffer.from(msg.data, 'base64'), { binary: true })
        } else {
          guestWs.send(msg.data)
        }
      }
      break
    }

    case 'ws-close': {
      const gws = tunnel.wsChannels.get(msg.id)
      if (gws) {
        try { gws.close(msg.code || 1000, msg.reason || '') } catch {}
        tunnel.wsChannels.delete(msg.id)
      }
      break
    }
  }
}

function handleHostBinary(tunnel, buf) {
  if (buf.length < 4) return
  const reqId = buf.readUInt32BE(0)
  const payload = buf.subarray(4)

  // Streaming HTTP response body chunk
  const pending = tunnel.pendingHttp.get(reqId)
  if (pending && pending.headersWritten) {
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => {
      tunnel.pendingHttp.delete(reqId)
      if (!pending.res.writableEnded) {
        try { pending.res.end() } catch {}
      }
    }, 120_000)

    try {
      if (!pending.res.writableEnded) pending.res.write(payload)
    } catch {}
    return
  }

  // WS binary message forwarding
  const guestWs = tunnel.wsChannels.get(reqId)
  if (guestWs && guestWs.readyState === 1) {
    guestWs.send(payload, { binary: true })
  }
}

// ── Session management ────────────────────────────────────────────────

function createSession(roomKey) {
  const sessionId = randomBytes(32).toString('hex')
  sessions.set(sessionId, { roomKey, createdAt: Date.now() })
  return sessionId
}

function resolveSession(cookieHeader) {
  if (!cookieHeader) return null
  const match = cookieHeader.match(/(?:^|;\s*)__sfr=([a-f0-9]{64})/)
  if (!match) return null
  const sessionId = match[1]
  const session = sessions.get(sessionId)
  if (!session) return null
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(sessionId)
    return null
  }
  return session.roomKey
}

function getHostTunnel(roomKey) {
  return hostTunnels.get(roomKey) || null
}

// ── HTTP proxying ─────────────────────────────────────────────────────

function proxyHttpRequest(tunnel, reqId, method, path, headers, body, res) {
  const msg = {
    type: 'http-request',
    id: reqId,
    method,
    path,
    headers,
  }
  if (body && body.length > 0) {
    msg.body = body.toString('base64')
  }

  const timer = setTimeout(() => {
    tunnel.pendingHttp.delete(reqId)
    try {
      if (!res.writableEnded) {
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'text/plain' })
        }
        res.end('Gateway timeout')
      }
    } catch {}
  }, HTTP_TIMEOUT)

  tunnel.pendingHttp.set(reqId, { res, timer })

  try {
    tunnel.ws.send(JSON.stringify(msg))
  } catch {
    clearTimeout(timer)
    tunnel.pendingHttp.delete(reqId)
    if (!res.writableEnded) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end('Tunnel send failed')
    }
  }
}

function getNextReqId(tunnel) {
  const id = tunnel.nextReqId++
  if (tunnel.nextReqId > 0x7FFFFFFF) tunnel.nextReqId = 1
  return id
}

// ── WebSocket proxying ────────────────────────────────────────────────

function proxyWebSocket(tunnel, guestWs, path, headers) {
  const channelId = getNextReqId(tunnel)
  tunnel.wsChannels.set(channelId, guestWs)

  try {
    tunnel.ws.send(JSON.stringify({
      type: 'ws-open',
      id: channelId,
      path,
      headers: filterWsHeaders(headers),
    }))
  } catch {
    guestWs.close(1001, 'tunnel failed')
    tunnel.wsChannels.delete(channelId)
    return
  }

  guestWs.on('message', (data, isBinary) => {
    if (tunnel.ws.readyState !== 1) return
    try {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        const frame = Buffer.alloc(4 + buf.length)
        frame.writeUInt32BE(channelId, 0)
        buf.copy(frame, 4)
        tunnel.ws.send(frame)
      } else {
        tunnel.ws.send(JSON.stringify({
          type: 'ws-message',
          id: channelId,
          data: data.toString(),
          binary: false,
        }))
      }
    } catch {}
  })

  guestWs.on('close', (code, reason) => {
    tunnel.wsChannels.delete(channelId)
    if (tunnel.ws.readyState === 1) {
      try {
        tunnel.ws.send(JSON.stringify({
          type: 'ws-close',
          id: channelId,
          code,
          reason: reason?.toString() || '',
        }))
      } catch {}
    }
  })

  guestWs.on('error', () => {
    tunnel.wsChannels.delete(channelId)
  })
}

function filterWsHeaders(headers) {
  const safe = {}
  const keep = ['cookie', 'origin', 'user-agent', 'accept-language', 'sec-websocket-protocol']
  for (const k of keep) {
    if (headers[k]) safe[k] = headers[k]
  }
  return safe
}

// ── Cleanup ───────────────────────────────────────────────────────────

function cleanupExpiredSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) {
      sessions.delete(id)
    }
  }
}

// ── Stats ─────────────────────────────────────────────────────────────

function tunnelStats() {
  return {
    hosts: hostTunnels.size,
    sessions: sessions.size,
  }
}

// Return the single host's roomKey if exactly one host is tunneled, else null
function getDefaultRoomKey() {
  if (hostTunnels.size !== 1) return null
  return hostTunnels.keys().next().value
}

module.exports = {
  registerHost, resolveSession, createSession, getHostTunnel, getDefaultRoomKey,
  proxyHttpRequest, getNextReqId, proxyWebSocket,
  cleanupExpiredSessions, tunnelStats,
}
