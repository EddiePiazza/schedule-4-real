// ═══════════════════════════════════════════════════════════════════
// gossip.cjs — Peer discovery via gossip protocol
// Each relay node maintains a list of known peers and periodically
// exchanges lists with them for decentralised discovery.
// ═══════════════════════════════════════════════════════════════════
'use strict'

const http = require('node:http')
const https = require('node:https')
const { sign, verify, randomBytes } = require('./crypto.cjs')
const { loadPeers, savePeers, SEED_NODES } = require('./config.cjs')

// ── Module state ────────────────────────────────────────────────────
const knownPeers = new Map()   // url -> peer object

let myUrl = ''
let myPk = ''
let mySignPk = ''
let mySignSk = null

let gossipInterval = null
let announceInterval = null
let persistInterval = null
let roomFederationInterval = null

// Callback for room federation: (sourceRelay, rooms) => void
let onFederatedRooms = null

const REQUEST_TIMEOUT_MS = 5000
const GOSSIP_INTERVAL_MS = 60_000       // 60s
const ANNOUNCE_INTERVAL_MS = 300_000    // 5min
const PERSIST_INTERVAL_MS = 300_000     // 5min
const MAX_FAILURES = 3
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000   // 24h
const MAX_PEERS = 500                   // Prevent memory exhaustion from peer flooding
const ANNOUNCE_MAX_AGE_MS = 600_000     // Reject announcements older than 10 min (anti-replay)
const ANNOUNCE_MAX_FUTURE_MS = 60_000   // Reject announcements more than 1 min in the future

// ── Identity configuration ──────────────────────────────────────────

/**
 * Set this node's identity. Must be called before start().
 * @param {{ url: string, kxPublicKey: string, signPublicKey: string, signSecretKey: Buffer }} opts
 */
function configure(opts) {
  myUrl = opts.url || ''
  myPk = opts.kxPublicKey || ''
  mySignPk = opts.signPublicKey || ''
  mySignSk = opts.signSecretKey || null
  if (opts.onFederatedRooms) onFederatedRooms = opts.onFederatedRooms
}

// ── Lifecycle ───────────────────────────────────────────────────────

function start() {
  // Load persisted peers and merge seed nodes
  const saved = loadPeers()
  if (Array.isArray(saved)) {
    for (const p of saved) {
      if (isValidPeer(p)) {
        knownPeers.set(p.url, { ...p })
      }
    }
  }

  // Merge seed nodes (always present, failures never increment)
  for (const seed of SEED_NODES) {
    if (!seed.url) continue
    const existing = knownPeers.get(seed.url)
    if (existing) {
      existing.failures = 0
    } else {
      knownPeers.set(seed.url, {
        url: seed.url,
        pk: seed.pk || '',
        signPk: seed.signPk || '',
        tracker: !!seed.tracker,
        ts: Date.now(),
        failures: 0,
        lastSeen: 0,
      })
    }
  }

  // Always ensure self is in the peer list with real pk so that
  // GET /peers returns our actual public key to other nodes
  if (myUrl && myPk) {
    const self = knownPeers.get(myUrl)
    if (self) {
      self.pk = myPk
      self.signPk = mySignPk
      self.tracker = true
      self.lastSeen = Date.now()
    } else {
      knownPeers.set(myUrl, {
        url: myUrl,
        pk: myPk,
        signPk: mySignPk,
        tracker: true,
        ts: Date.now(),
        failures: 0,
        lastSeen: Date.now(),
      })
    }
  }

  console.log(`[GOSSIP] Started with ${knownPeers.size} known peers`)

  // Immediate bootstrap: fetch peers + announce + federate rooms after HTTP server is ready
  setTimeout(() => {
    const peer = pickRandom(getOtherPeers(), 1)[0]
    if (peer) {
      fetchPeersFrom(peer.url).catch(() => {})
    }
    announceToAll().catch(() => {})
    // Federate rooms after a short delay to let announcements propagate
    setTimeout(() => federateRooms().catch(() => {}), 5000)
  }, 3000)

  // Gossip loop: every 60s fetch peer list from a random peer
  gossipInterval = setInterval(() => {
    const peer = pickRandom(getOtherPeers(), 1)[0]
    if (peer) {
      fetchPeersFrom(peer.url).catch(() => {})
    }
  }, GOSSIP_INTERVAL_MS)

  // Announce loop: every 5min announce self to 3 random peers
  announceInterval = setInterval(() => {
    announceToAll().catch(() => {})
  }, ANNOUNCE_INTERVAL_MS)

  // Persist loop: save to disk every 5min
  persistInterval = setInterval(() => {
    savePeers(getPeerList())
  }, PERSIST_INTERVAL_MS)

  // Room federation loop: every 60s fetch rooms from all peer trackers
  roomFederationInterval = setInterval(() => {
    federateRooms().catch(() => {})
  }, GOSSIP_INTERVAL_MS)
}

function stop() {
  if (gossipInterval) { clearInterval(gossipInterval); gossipInterval = null }
  if (announceInterval) { clearInterval(announceInterval); announceInterval = null }
  if (persistInterval) { clearInterval(persistInterval); persistInterval = null }
  if (roomFederationInterval) { clearInterval(roomFederationInterval); roomFederationInterval = null }
  console.log('[GOSSIP] Stopped')
}

// ── Peer merging ────────────────────────────────────────────────────

/**
 * Merge a list of remote peers into local state.
 * @param {Array} remotePeers
 */
function mergePeers(remotePeers) {
  if (!Array.isArray(remotePeers)) return
  // Limit how many peers we process from a single response
  const toProcess = remotePeers.slice(0, 200)

  for (const rp of toProcess) {
    if (!isValidPeer(rp)) continue
    // Skip self
    if (rp.url === myUrl) continue

    const existing = knownPeers.get(rp.url)
    if (!existing) {
      // Enforce max peer count — don't add if at limit
      if (knownPeers.size >= MAX_PEERS) continue
      // New peer
      knownPeers.set(rp.url, {
        url: rp.url,
        pk: rp.pk || '',
        signPk: rp.signPk || '',
        tracker: !!rp.tracker,
        ts: rp.ts || Date.now(),
        failures: 0,
        lastSeen: rp.lastSeen || 0,
      })
    } else {
      // Update if remote timestamp is newer
      if (rp.ts && rp.ts > (existing.ts || 0)) {
        existing.pk = rp.pk || existing.pk
        existing.signPk = rp.signPk || existing.signPk
        existing.tracker = rp.tracker !== undefined ? !!rp.tracker : existing.tracker
        existing.ts = rp.ts
        if (rp.lastSeen && rp.lastSeen > (existing.lastSeen || 0)) {
          existing.lastSeen = rp.lastSeen
        }
      }
      // Never bump failures for seed nodes
      if (isSeedNode(existing.url)) {
        existing.failures = 0
      }
    }
  }
}

// ── Peer queries ────────────────────────────────────────────────────

/**
 * Returns array of all known peers.
 */
function getPeerList() {
  return Array.from(knownPeers.values())
}

/**
 * Returns only peers with failures < 3 and lastSeen within 24h.
 */
function getActivePeers() {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS
  return getPeerList().filter(p =>
    p.failures < MAX_FAILURES && p.lastSeen > cutoff
  )
}

// ── Announcements ───────────────────────────────────────────────────

/**
 * Build a signed announcement for this node.
 */
function getAnnouncement() {
  const ts = Date.now()
  const message = `${myUrl}|${myPk}|${ts}`
  const msgBuf = Buffer.from(message, 'utf-8')
  const sigBuf = sign(msgBuf, mySignSk)

  return {
    url: myUrl,
    pk: myPk,
    signPk: mySignPk,
    tracker: true,
    ts,
    sig: sigBuf.toString('hex'),
  }
}

/**
 * Verify a peer's announcement signature + freshness.
 * @param {{ url: string, pk: string, signPk: string, ts: number, sig: string }} announcement
 * @returns {boolean}
 */
function verifyAnnouncement(announcement) {
  try {
    if (!announcement || !announcement.url || !announcement.pk || !announcement.signPk || !announcement.ts || !announcement.sig) {
      return false
    }

    // Validate URL format
    if (typeof announcement.url !== 'string' || (!announcement.url.startsWith('wss://') && !announcement.url.startsWith('ws://'))) {
      return false
    }
    if (announcement.url.length > 256) return false

    // Validate hex key formats
    if (!/^[0-9a-f]{64}$/i.test(announcement.pk)) return false
    if (!/^[0-9a-f]{64}$/i.test(announcement.signPk)) return false

    // Anti-replay: reject stale or future timestamps
    const now = Date.now()
    if (typeof announcement.ts !== 'number') return false
    if (announcement.ts < now - ANNOUNCE_MAX_AGE_MS) return false  // too old
    if (announcement.ts > now + ANNOUNCE_MAX_FUTURE_MS) return false // too far in the future

    // Reject URLs pointing to internal/private IPs (SSRF prevention)
    if (isInternalUrl(announcement.url)) return false

    const message = `${announcement.url}|${announcement.pk}|${announcement.ts}`
    const msgBuf = Buffer.from(message, 'utf-8')
    const sigBuf = Buffer.from(announcement.sig, 'hex')
    const pkBuf = Buffer.from(announcement.signPk, 'hex')
    return verify(sigBuf, msgBuf, pkBuf)
  } catch {
    return false
  }
}

// ── Network operations ──────────────────────────────────────────────

/**
 * Fetch peer list from a remote peer via HTTP(S) GET /peers.
 * On failure, increments the peer's failure count.
 * @param {string} peerUrl  WebSocket URL of the peer (wss:// or ws://)
 */
function fetchPeersFrom(peerUrl) {
  return new Promise((resolve, reject) => {
    const httpUrl = wsUrlToHttpBase(peerUrl) + '/peers'
    const mod = httpUrl.startsWith('https:') ? https : http

    const MAX_BODY = 256 * 1024 // 256KB max for peer list response

    const req = mod.get(httpUrl, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = ''
      let totalSize = 0
      res.on('data', (chunk) => {
        totalSize += chunk.length
        if (totalSize > MAX_BODY) {
          req.destroy()
          incrementFailure(peerUrl)
          reject(new Error('Peer response too large'))
          return
        }
        body += chunk
      })
      res.on('end', () => {
        try {
          const remotePeers = JSON.parse(body)
          mergePeers(remotePeers)

          // Mark this peer as recently seen
          const peer = knownPeers.get(peerUrl)
          if (peer) {
            peer.lastSeen = Date.now()
            peer.failures = isSeedNode(peerUrl) ? 0 : Math.max(0, peer.failures - 1)
          }

          resolve(remotePeers)
        } catch (e) {
          incrementFailure(peerUrl)
          reject(e)
        }
      })
    })

    req.on('error', (err) => {
      incrementFailure(peerUrl)
      reject(err)
    })

    req.on('timeout', () => {
      req.destroy()
      incrementFailure(peerUrl)
      reject(new Error(`Timeout fetching peers from ${peerUrl}`))
    })
  })
}

/**
 * Announce self to up to 3 random peers via HTTP POST /peers/announce.
 */
async function announceToAll() {
  if (!myUrl || !mySignSk) return

  const announcement = getAnnouncement()
  const payload = JSON.stringify(announcement)
  const targets = pickRandom(getOtherPeers(), 3)

  const results = await Promise.allSettled(
    targets.map(peer => postAnnouncement(peer.url, payload))
  )

  let ok = 0
  for (const r of results) {
    if (r.status === 'fulfilled') ok++
  }

  if (targets.length > 0) {
    console.log(`[GOSSIP] Announced to ${ok}/${targets.length} peers`)
  }
}

/**
 * POST announcement to a single peer.
 * @param {string} peerUrl  WebSocket URL
 * @param {string} payload  JSON string
 */
function postAnnouncement(peerUrl, payload) {
  return new Promise((resolve, reject) => {
    const httpUrl = wsUrlToHttpBase(peerUrl) + '/peers/announce'
    const parsed = new URL(httpUrl)
    const mod = parsed.protocol === 'https:' ? https : http

    const options = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }

    const req = mod.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        const peer = knownPeers.get(peerUrl)
        if (peer) {
          peer.lastSeen = Date.now()
        }
        resolve(body)
      })
    })

    req.on('error', (err) => {
      incrementFailure(peerUrl)
      reject(err)
    })

    req.on('timeout', () => {
      req.destroy()
      incrementFailure(peerUrl)
      reject(new Error(`Timeout announcing to ${peerUrl}`))
    })

    req.write(payload)
    req.end()
  })
}

// ── Room federation ─────────────────────────────────────────────

/**
 * Fetch rooms from all peer trackers and merge into local tracker.
 * Only fetches from peers that have tracker: true.
 */
async function federateRooms() {
  if (!onFederatedRooms) return

  const trackerPeers = getOtherPeers().filter(p => p.tracker)
  if (trackerPeers.length === 0) return

  const results = await Promise.allSettled(
    trackerPeers.map(peer => fetchRoomsFrom(peer.url))
  )

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'fulfilled' && results[i].value) {
      onFederatedRooms(trackerPeers[i].url, results[i].value)
    }
  }
}

/**
 * Fetch rooms from a peer tracker via HTTP GET /rooms.
 * Returns array of room objects or null on failure.
 * @param {string} peerUrl WebSocket URL of the peer
 * @returns {Promise<Array|null>}
 */
function fetchRoomsFrom(peerUrl) {
  return new Promise((resolve, reject) => {
    const httpUrl = wsUrlToHttpBase(peerUrl) + '/api/rooms'
    const mod = httpUrl.startsWith('https:') ? https : http

    const req = mod.get(httpUrl, { timeout: REQUEST_TIMEOUT_MS }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          const data = JSON.parse(body)
          if (data && Array.isArray(data.rooms)) {
            // Only pass through non-federated rooms (prevent re-sharing loops)
            const localRooms = data.rooms.filter(r => !r.federated)
            resolve(localRooms)
          } else {
            resolve(null)
          }
        } catch {
          resolve(null)
        }
      })
    })

    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Convert a ws:// or wss:// URL to http:// or https://
 */
function wsUrlToHttp(wsUrl) {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

/**
 * Convert a ws:// or wss:// URL to HTTP base URL (protocol + host, no path).
 * E.g. 'wss://schedule4real.com/rooms' → 'https://schedule4real.com'
 */
function wsUrlToHttpBase(wsUrl) {
  const httpUrl = wsUrlToHttp(wsUrl)
  try {
    const parsed = new URL(httpUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return httpUrl
  }
}

/**
 * Validate a peer object has the minimum required fields.
 */
function isValidPeer(p) {
  if (!p || typeof p !== 'object') return false
  if (!p.url || typeof p.url !== 'string') return false
  if (!p.url.startsWith('ws://') && !p.url.startsWith('wss://')) return false
  if (p.url.length > 256) return false
  if (!p.pk || typeof p.pk !== 'string') return false
  if (!/^[0-9a-f]{64}$/i.test(p.pk)) return false
  // Reject internal/private IPs
  if (isInternalUrl(p.url)) return false
  return true
}

/**
 * Check if a URL points to an internal/private IP (SSRF prevention).
 */
function isInternalUrl(url) {
  try {
    const parsed = new URL(url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'))
    const host = parsed.hostname
    // Block localhost variants
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
    // Block private IP ranges
    if (/^10\./.test(host)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
    if (/^192\.168\./.test(host)) return true
    if (/^169\.254\./.test(host)) return true // link-local
    if (/^fc00:|^fd/.test(host)) return true  // IPv6 private
    return false
  } catch {
    return true // Invalid URL → treat as internal
  }
}

/**
 * Check whether a URL is one of the hardcoded seed nodes.
 */
function isSeedNode(url) {
  return SEED_NODES.some(s => s.url === url)
}

/**
 * Get all peers except self.
 */
function getOtherPeers() {
  return getPeerList().filter(p => p.url !== myUrl)
}

/**
 * Pick up to n random elements from an array (Fisher-Yates partial shuffle).
 */
function pickRandom(arr, n) {
  if (arr.length <= n) return [...arr]
  const copy = [...arr]
  const result = []
  for (let i = 0; i < n; i++) {
    // Use crypto-quality randomness for index selection
    const rnd = randomBytes(4).readUInt32BE(0)
    const idx = rnd % copy.length
    result.push(copy[idx])
    copy[idx] = copy[copy.length - 1]
    copy.pop()
  }
  return result
}

/**
 * Increment failure count for a peer (unless it is a seed node).
 */
function incrementFailure(peerUrl) {
  const peer = knownPeers.get(peerUrl)
  if (!peer) return
  if (isSeedNode(peerUrl)) {
    peer.failures = 0
  } else {
    peer.failures = (peer.failures || 0) + 1
  }
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  configure,
  start,
  stop,
  mergePeers,
  getPeerList,
  getActivePeers,
  getAnnouncement,
  verifyAnnouncement,
  fetchPeersFrom,
  announceToAll,
}
