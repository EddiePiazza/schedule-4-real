// ═══════════════════════════════════════════════════════════════════
// gossip.cjs — Peer discovery via gossip protocol
// Each relay node maintains a list of known peers and periodically
// exchanges lists with them for decentralised discovery.
// ═══════════════════════════════════════════════════════════════════
'use strict'

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const { sign, verify, randomBytes } = require('./crypto.cjs')
const { loadPeers, savePeers, SEED_NODES, DATA_DIR, loadBootstrapPeers } = require('./config.cjs')

// ── Module state ────────────────────────────────────────────────────
const knownPeers = new Map()   // url or pk:signPk -> peer object

// ── Key revocation ──────────────────────────────────────────────────
const revokedKeys = new Set()  // signPk hex strings (lowercase)
const pendingRevocations = []  // { signPk, newSignPk, ts, sig } — to propagate in next gossip cycle

// Load persisted revocations
try {
  const revokedFile = path.join(DATA_DIR, 'revoked-keys.json')
  if (fs.existsSync(revokedFile)) {
    const data = JSON.parse(fs.readFileSync(revokedFile, 'utf-8'))
    if (Array.isArray(data)) data.forEach(k => revokedKeys.add(k.toLowerCase()))
  }
} catch {}

function persistRevocations() {
  try {
    const revokedFile = path.join(DATA_DIR, 'revoked-keys.json')
    fs.writeFileSync(revokedFile, JSON.stringify([...revokedKeys]))
  } catch {}
}

function isRevoked(signPk) {
  return signPk && revokedKeys.has(signPk.toLowerCase())
}

/**
 * Process a key revocation announcement.
 * Format: { type: 'revoke', signPk: oldKey, newSignPk: '', ts, sig }
 * sig = sign("revoke|oldSignPk|newSignPk|ts", oldSecretKey)
 * Proves the OLD key owner authorized the revocation.
 */
function processRevocation(revocation) {
  if (!revocation || !revocation.signPk || !revocation.ts || !revocation.sig) return false
  if (!/^[0-9a-f]{64}$/i.test(revocation.signPk)) return false
  if (isRevoked(revocation.signPk)) return true // Already revoked

  const newSpk = revocation.newSignPk || ''
  const msg = Buffer.from(`revoke|${revocation.signPk}|${newSpk}|${revocation.ts}`)
  try {
    const sig = Buffer.from(revocation.sig, 'hex')
    const pubKey = Buffer.from(revocation.signPk, 'hex')
    if (!verify(sig, msg, pubKey)) return false
  } catch { return false }

  // Valid revocation — add to set and remove peer
  const revokedLower = revocation.signPk.toLowerCase()
  revokedKeys.add(revokedLower)
  for (const [key, peer] of knownPeers) {
    if (peer.signPk?.toLowerCase() === revokedLower) {
      knownPeers.delete(key)
    }
  }
  pendingRevocations.push(revocation)
  persistRevocations()
  console.log(`[GOSSIP] Key revoked: ${revocation.signPk.slice(0, 16)}...`)
  return true
}

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

  // If only seeds known, try encrypted bootstrap peers as fallback
  const peersWithUrls = [...knownPeers.values()].filter(p => p.url)
  if (peersWithUrls.length <= SEED_NODES.length) {
    const bootstrap = loadBootstrapPeers()
    if (bootstrap.length) {
      for (const bp of bootstrap) {
        if (bp.signPk && !knownPeers.has(`pk:${bp.signPk}`)) {
          knownPeers.set(`pk:${bp.signPk}`, bp)
        }
      }
      console.log(`[GOSSIP] Loaded ${bootstrap.length} bootstrap peers as fallback`)
    }
  }

  // Always ensure self is in the peer list with real pk so that
  // GET /peers returns our actual public key to other nodes
  if (myUrl && myPk && (myUrl.startsWith('wss://') || myUrl.startsWith('ws://')) && !isRawIpUrl(myUrl)) {
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

  // Persist loop: save to disk every 5min (prune dead peers before saving)
  persistInterval = setInterval(() => {
    pruneDeadPeers()
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

// ── Peer pruning ────────────────────────────────────────────────────

/**
 * Remove peers that have too many failures or haven't been seen in 48h.
 * Seed nodes are never pruned.
 */
function pruneDeadPeers() {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000  // 48h
  let pruned = 0
  for (const [key, peer] of knownPeers) {
    if (peer.url && isSeedNode(peer.url)) continue
    if (peer.failures >= MAX_FAILURES && peer.lastSeen < cutoff) {
      knownPeers.delete(key)
      pruned++
    }
  }
  if (pruned > 0) console.log(`[GOSSIP] Pruned ${pruned} dead peer(s)`)
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
    // New format: peer without URL (signPk-only, privacy-preserving)
    if (!rp.url && rp.signPk && /^[0-9a-f]{64}$/i.test(rp.signPk)) {
      if (!rp.pk || !/^[0-9a-f]{64}$/i.test(rp.pk)) continue
      // Skip self
      if (rp.signPk === mySignPk) continue

      const key = `pk:${rp.signPk}`
      const existing = knownPeers.get(key)
      if (!existing) {
        if (knownPeers.size >= MAX_PEERS) continue
        knownPeers.set(key, {
          url: '', // no URL — signPk-only peer
          pk: rp.pk,
          signPk: rp.signPk,
          tracker: !!rp.tracker,
          ts: rp.ts || Date.now(),
          failures: 0,
          lastSeen: rp.lastSeen || 0,
        })
      } else {
        if (rp.ts && rp.ts > (existing.ts || 0)) {
          existing.pk = rp.pk || existing.pk
          existing.tracker = rp.tracker !== undefined ? !!rp.tracker : existing.tracker
          existing.ts = rp.ts
        }
      }
      continue
    }

    // Legacy format: peer with URL
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
 * Uses signPk-based identity — NO URL in announcement (privacy hardening).
 * Seed nodes' URLs are hardcoded in config.cjs, not shared via gossip.
 */
function getAnnouncement() {
  const ts = Date.now()
  // New format: signPk|pk|ts (no URL — prevents IP leak via gossip)
  const message = `${mySignPk}|${myPk}|${ts}`
  const msgBuf = Buffer.from(message, 'utf-8')
  const sigBuf = sign(msgBuf, mySignSk)

  return {
    // NO url field — prevents IP leak to any relay joining the gossip network
    pk: myPk,
    signPk: mySignPk,
    tracker: true,
    ts,
    sig: sigBuf.toString('hex'),
  }
}

/**
 * Verify a peer's announcement signature + freshness.
 * Accepts two formats (backward compatible during transition):
 *  - New: signPk|pk|ts (no URL — privacy hardening)
 *  - Legacy: url|pk|ts (old relays that haven't updated yet)
 * @param {{ url?: string, pk: string, signPk: string, ts: number, sig: string }} announcement
 * @returns {boolean}
 */
function verifyAnnouncement(announcement) {
  try {
    if (!announcement || !announcement.pk || !announcement.signPk || !announcement.ts || !announcement.sig) {
      return false
    }
    // Reject announcements from revoked keys
    if (isRevoked(announcement.signPk)) return false

    // Validate hex key formats
    if (!/^[0-9a-f]{64}$/i.test(announcement.pk)) return false
    if (!/^[0-9a-f]{64}$/i.test(announcement.signPk)) return false

    // Anti-replay: reject stale or future timestamps
    const now = Date.now()
    if (typeof announcement.ts !== 'number') return false
    if (announcement.ts < now - ANNOUNCE_MAX_AGE_MS) return false  // too old
    if (announcement.ts > now + ANNOUNCE_MAX_FUTURE_MS) return false // too far in the future

    // New format: signPk|pk|ts (no URL)
    if (!announcement.url) {
      const message = `${announcement.signPk}|${announcement.pk}|${announcement.ts}`
      const msgBuf = Buffer.from(message, 'utf-8')
      const sigBuf = Buffer.from(announcement.sig, 'hex')
      const pkBuf = Buffer.from(announcement.signPk, 'hex')
      return verify(sigBuf, msgBuf, pkBuf)
    }

    // Legacy format: url|pk|ts (backward compat during transition)
    if (typeof announcement.url !== 'string' || (!announcement.url.startsWith('wss://') && !announcement.url.startsWith('ws://'))) {
      return false
    }
    if (announcement.url.length > 256) return false
    if (isInternalUrl(announcement.url)) return false
    if (isRawIpUrl(announcement.url)) return false

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
    // Challenge-response auth: sign(peers|ts|mySignPk|targetSignPk) with Ed25519
    let authParam = ''
    if (mySignPk && mySignSk) {
      const targetPeer = knownPeers.get(peerUrl)
      const targetSignPk = targetPeer?.signPk || ''
      const ts = Date.now().toString()
      const msg = Buffer.from(`peers|${ts}|${mySignPk}|${targetSignPk}`)
      const sig = sign(msg, mySignSk).toString('hex')
      authParam = `?ts=${ts}&pk=${mySignPk}&sig=${sig}`
    }
    const httpUrl = wsUrlToHttpBase(peerUrl) + '/peers' + authParam
    const mod = httpUrl.startsWith('https:') ? https : http

    const MAX_BODY = 256 * 1024 // 256KB max for peer list response
    const startTime = Date.now()

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
            peer.rtt = Date.now() - startTime
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
  // Block deprecated/dead domains from propagating through gossip
  if (/weedlix\.com/i.test(p.url)) return false
  if (!p.pk || typeof p.pk !== 'string') return false
  if (!/^[0-9a-f]{64}$/i.test(p.pk)) return false
  // Reject internal/private IPs
  if (isInternalUrl(p.url)) return false
  // Reject raw IP addresses in URLs — relays must use domain names for gossip.
  // Raw IPs leak infrastructure details and often point to un-NATed addresses.
  if (isRawIpUrl(p.url)) return false
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
 * Check if a URL uses a raw IP address instead of a domain name.
 * Raw IPs leak infrastructure details and often don't have proper NAT/TLS.
 */
function isRawIpUrl(url) {
  try {
    const parsed = new URL(url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'))
    const host = parsed.hostname
    // IPv4: digits and dots only
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
    // IPv6: contains colons (including bracketed form which URL parser strips)
    if (host.includes(':')) return true
    return false
  } catch {
    return true // Invalid URL → reject
  }
}

/**
 * Check whether a URL is one of the hardcoded seed nodes.
 */
function isSeedNode(url) {
  return SEED_NODES.some(s => s.url === url)
}

/**
 * Get all peers except self that have a reachable URL.
 * Peers without URLs (signPk-only) cannot be contacted via HTTP.
 */
function getOtherPeers() {
  return getPeerList().filter(p => p.url && p.url !== myUrl)
}

/**
 * Pick up to n random elements from an array (Fisher-Yates partial shuffle).
 */
function pickRandom(arr, n) {
  if (arr.length <= n) return [...arr]
  const copy = [...arr]
  const result = []
  for (let i = 0; i < n; i++) {
    // Rejection sampling to avoid modulo bias
    const len = copy.length
    const max = 0xFFFFFFFF - (0xFFFFFFFF % len)
    let rnd
    do { rnd = randomBytes(4).readUInt32BE(0) } while (rnd >= max)
    const idx = rnd % len
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

// ── PK-based routing lookups ────────────────────────────────────────

/**
 * Look up a peer's WebSocket URL by its Ed25519 signing public key.
 * Used by relay.cjs to resolve PK-based EXTEND routing.
 * @param {string} signPk - 64-char hex Ed25519 public key
 * @returns {string|null} WebSocket URL or null if not found
 */
function lookupUrlBySignPk(signPk) {
  if (!signPk || typeof signPk !== 'string') return null
  const normalized = signPk.toLowerCase()
  for (const [url, peer] of knownPeers) {
    if (peer.signPk && peer.signPk.toLowerCase() === normalized) return url
  }
  return null
}

/**
 * Look up a peer's Ed25519 signing public key by its WebSocket URL.
 * Used by tracker.cjs to resolve PK for legacy URL-based registrations.
 * @param {string} url - WebSocket URL
 * @returns {string|null} 64-char hex signPk or null
 */
function lookupSignPkByUrl(url) {
  const peer = knownPeers.get(url)
  return peer?.signPk || null
}

/**
 * Get peer list without URLs — for public-facing endpoints.
 * Prevents leaking relay IPs to browsers/external queries.
 */
function getPeerListPublic() {
  return getPeerList().map(p => ({
    pk: p.pk,
    signPk: p.signPk,
    tracker: p.tracker,
    // NO: ts, failures, lastSeen, rtt — enables fingerprinting/triangulation
  }))
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  configure,
  start,
  stop,
  mergePeers,
  getPeerList,
  getPeerListPublic,
  getActivePeers,
  getAnnouncement,
  verifyAnnouncement,
  fetchPeersFrom,
  announceToAll,
  lookupUrlBySignPk,
  lookupSignPkByUrl,
  isRevoked,
  processRevocation,
}
