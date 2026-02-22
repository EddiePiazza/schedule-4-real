'use strict'
// ═══════════════════════════════════════════════════════════════════
// room-publisher.cjs — Auto-publishes room definitions to trackers
// Uses 1-hop onion circuits (WS → relay/tracker) to register rooms.
// Works with the existing relay protocol — no special endpoints needed.
// Heartbeats every 60s to keep rooms alive (TTL=120s on trackers).
// Gossip federation then spreads rooms to all peer trackers.
// ═══════════════════════════════════════════════════════════════════

const WebSocket = require('ws')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

let sodium
try {
  sodium = require('sodium-native')
} catch {
  console.error('[RoomPublisher] FATAL: sodium-native is required for onion circuits')
  console.error('[RoomPublisher] Install with: npm install sodium-native')
  process.exit(1)
}

// ── Constants ───────────────────────────────────────────────────────
const NONCE_BYTES = 24
const MAC_BYTES = 16
const KX_PK_BYTES = 32
const PACKET_SIZE = 512
const HEARTBEAT_INTERVAL = 60000  // 60s (tracker TTL = 120s)
const CONNECT_TIMEOUT = 10000
const METADATA_SEED = 'spiderfarmer-room-metadata-v1'

const MSG_TRACKER_REGISTER = 0x40
const MSG_TRACKER_HEARTBEAT = 0x43

// ── Paths ───────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const SYSTEM_ROOMS = path.join(PROJECT_ROOT, 'data/appdata/models/rooms/rooms.json')
const USER_ROOMS = path.join(PROJECT_ROOT, 'data/room3d/models/rooms/rooms.json')
const SECRET_PATH = path.join(PROJECT_ROOT, 'data/room3d/room-publisher-secret.json')
const ROOM_SETTINGS_PATH = path.join(PROJECT_ROOT, 'data/room3d/room-settings.json')
const TUNNEL_KEY_PATH = path.join(PROJECT_ROOT, 'data/room3d/tunnel-key.json')
const ENV_PATH = path.join(PROJECT_ROOT, '.env')
const RELAY_CONFIG = path.join(PROJECT_ROOT, 'data/relay/relay-config.json')

// ── Dynamic tracker discovery ────────────────────────────────────────
const SEED_TRACKERS = [
  'wss://schedule4real.com/rooms',
  'wss://r2.imaset.com',
]
const PEERS_FILE = path.join(PROJECT_ROOT, 'data/relay/peers.json')

let knownTrackers = [...SEED_TRACKERS]

function loadTrackersFromDisk() {
  try {
    const peers = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8'))
    if (!Array.isArray(peers)) return
    for (const p of peers) {
      if (p.tracker && p.url && (p.failures || 0) < 3 && !knownTrackers.includes(p.url))
        knownTrackers.push(p.url)
    }
  } catch {}
}

loadTrackersFromDisk()
// Re-read peers.json every 5 min (gossip.cjs keeps it updated)
setInterval(() => loadTrackersFromDisk(), 5 * 60_000)

// ── Crypto helpers ──────────────────────────────────────────────────
function encrypt(plaintext, key, aad) {
  const nonce = Buffer.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const ct = Buffer.alloc(plaintext.length + MAC_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ct, plaintext, aad, null, nonce, key)
  return Buffer.concat([nonce, ct])
}

function padPacket(data, size) {
  if (data.length >= size) return data
  const padded = Buffer.alloc(size)
  data.copy(padded)
  sodium.randombytes_buf(padded.subarray(data.length))
  return padded
}

// Build wire message: type(1) + nextHopLen(1) + [nextHop] + payloadLen(2) + payload
function buildMessage(type, nextHop, payload) {
  const hop = nextHop ? Buffer.from(nextHop, 'utf8') : Buffer.alloc(0)
  const msg = Buffer.alloc(1 + 1 + hop.length + 2 + payload.length)
  msg[0] = type
  msg[1] = hop.length
  if (hop.length) hop.copy(msg, 2)
  msg.writeUInt16BE(payload.length, 2 + hop.length)
  payload.copy(msg, 4 + hop.length)
  return msg
}

// ── Room data helpers ───────────────────────────────────────────────
function deriveMetadataKey() {
  const key = Buffer.alloc(32)
  sodium.crypto_generichash(key, Buffer.from(METADATA_SEED))
  return key
}

function encryptMetadata(plaintext, key) {
  const nonce = Buffer.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const ct = Buffer.alloc(plaintext.length + MAC_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ct, plaintext, null, null, nonce, key)
  return Buffer.concat([nonce, ct])
}

function deriveRoomId(envId, secret) {
  const id = Buffer.alloc(32)
  sodium.crypto_generichash(id, Buffer.concat([Buffer.from(envId, 'utf8'), secret]))
  return id
}

function loadRoomKey() {
  try {
    const data = JSON.parse(fs.readFileSync(TUNNEL_KEY_PATH, 'utf8'))
    if (data.roomKey) return data.roomKey
  } catch {}
  return null
}

function generateInviteToken(envId, roomKey, key) {
  if (!roomKey) return ''
  const plaintext = Buffer.from(envId, 'utf8')
  const nonce = Buffer.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const ct = Buffer.alloc(plaintext.length + MAC_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ct, plaintext, null, null, nonce, key)
  const payload = Buffer.concat([nonce, ct])
  return `${roomKey}.${payload.toString('base64url')}`
}

function loadOrCreateSecret() {
  try {
    const data = JSON.parse(fs.readFileSync(SECRET_PATH, 'utf8'))
    if (data.secret && data.secret.length === 64) return Buffer.from(data.secret, 'hex')
  } catch {}
  const secret = Buffer.alloc(32)
  sodium.randombytes_buf(secret)
  const dir = path.dirname(SECRET_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(SECRET_PATH, JSON.stringify({ secret: secret.toString('hex') }))
  console.log('[RoomPublisher] Generated new room publisher secret')
  return secret
}

function loadRoomSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(ROOM_SETTINGS_PATH, 'utf8'))
    if (raw.rooms && typeof raw.rooms === 'object') return raw.rooms
  } catch {}
  return {}
}

function getRoomSetting(settings, roomId) {
  const s = settings[roomId]
  // Defaults: big_room = public, others = private
  const defaults = roomId === 'big_room'
    ? { isPublic: true, inviteOnly: false, publicName: '', publicDescription: '', password: '' }
    : { isPublic: false, inviteOnly: true, publicName: '', publicDescription: '', password: '' }
  if (!s) return defaults
  return {
    isPublic: typeof s.isPublic === 'boolean' ? s.isPublic : defaults.isPublic,
    inviteOnly: typeof s.inviteOnly === 'boolean' ? s.inviteOnly : defaults.inviteOnly,
    publicName: s.publicName || defaults.publicName,
    publicDescription: s.publicDescription || defaults.publicDescription,
    password: typeof s.password === 'string' ? s.password : defaults.password,
  }
}

function loadRooms() {
  const allRooms = []
  for (const p of [SYSTEM_ROOMS, USER_ROOMS]) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (Array.isArray(data)) {
        for (const r of data) {
          if (!r.hidden) allRooms.push(r)
        }
      }
    } catch {}
  }

  // Filter: only publish rooms where isPublic is true
  const settings = loadRoomSettings()
  return allRooms.filter(r => getRoomSetting(settings, r.id).isPublic).map(r => {
    const rs = getRoomSetting(settings, r.id)
    return {
      ...r,
      // Use custom public name/description if set
      publishName: rs.publicName || r.name,
      publishDescription: rs.publicDescription || r.description || '',
      passwordProtected: !!rs.password,
    }
  })
}

function getEntryRelay() {
  // Primary: use publicUrl from relay-config.json (set by user in UI)
  try {
    const cfg = JSON.parse(fs.readFileSync(RELAY_CONFIG, 'utf8'))
    if (cfg.publicUrl) return cfg.publicUrl
  } catch {}
  return 'wss://schedule4real.com/rooms'
}

// ── 1-hop onion circuit to a tracker relay ──────────────────────────
// Connects to the relay via WS, performs X25519 key exchange,
// then sends encrypted tracker messages on the established circuit.
class TrackerCircuit {
  constructor(url) {
    this.url = url
    this.ws = null
    this.circuitId = 0
    this.aad = null
    this.tx = null   // client send key
    this.rx = null   // client receive key
    this.ready = false
  }

  async build() {
    this.ready = false
    try {
      // Connect
      this.ws = new WebSocket(this.url, { rejectUnauthorized: false })
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('connect timeout')), CONNECT_TIMEOUT)
        this.ws.on('open', () => { clearTimeout(t); resolve() })
        this.ws.on('error', (err) => { clearTimeout(t); reject(err) })
      })

      // Generate ephemeral X25519 keypair
      const kp = { publicKey: Buffer.alloc(KX_PK_BYTES), secretKey: sodium.sodium_malloc(32) }
      sodium.crypto_kx_keypair(kp.publicKey, kp.secretKey)

      // Random circuit ID
      const cidBuf = Buffer.alloc(4)
      sodium.randombytes_buf(cidBuf)
      this.circuitId = cidBuf.readUInt32BE(0)
      this.aad = Buffer.alloc(4)
      this.aad.writeUInt32BE(this.circuitId)

      // Send handshake: nonce(24) + circuitId(4) + clientPk(32) padded to 512
      const hs = Buffer.alloc(NONCE_BYTES + 4 + KX_PK_BYTES)
      sodium.randombytes_buf(hs.subarray(0, NONCE_BYTES))
      hs.writeUInt32BE(this.circuitId, NONCE_BYTES)
      kp.publicKey.copy(hs, NONCE_BYTES + 4)
      this.ws.send(padPacket(hs, PACKET_SIZE))

      // Wait for SFPK reply
      const reply = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('handshake timeout')), CONNECT_TIMEOUT)
        this.ws.once('message', (d) => { clearTimeout(t); resolve(Buffer.from(d)) })
      })

      if (reply.subarray(0, 4).toString() !== 'SFPK') {
        throw new Error('no SFPK magic in handshake reply')
      }

      const serverPk = reply.subarray(4, 36)

      // Derive session keys
      this.rx = sodium.sodium_malloc(32)
      this.tx = sodium.sodium_malloc(32)
      sodium.crypto_kx_client_session_keys(this.rx, this.tx, kp.publicKey, kp.secretKey, serverPk)

      this.ready = true
      this.ws.on('close', () => { this.ready = false })
      this.ws.on('error', () => { this.ready = false })
      return true
    } catch (err) {
      console.error(`[RoomPublisher] Circuit to ${this.url} failed: ${err.message}`)
      this.close()
      return false
    }
  }

  // Send a tracker message (REGISTER or HEARTBEAT) through the circuit
  send(payload) {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false

    // Wrap in message format: type(payload[0]) + nextHopLen(0) + payloadLen + payload
    const msg = buildMessage(payload[0], null, payload)

    // Encrypt with session key, circuitId as AAD
    const enc = encrypt(msg, this.tx, this.aad)

    // Wire format: nonce(24) + circuitId(4) + ciphertext
    const wire = Buffer.alloc(NONCE_BYTES + 4 + enc.length - NONCE_BYTES)
    enc.copy(wire, 0, 0, NONCE_BYTES)            // nonce
    wire.writeUInt32BE(this.circuitId, NONCE_BYTES) // circuitId
    enc.copy(wire, NONCE_BYTES + 4, NONCE_BYTES)  // ciphertext

    this.ws.send(wire)
    return true
  }

  close() {
    this.ready = false
    if (this.ws) {
      try { this.ws.close() } catch {}
      this.ws = null
    }
  }
}

// ── Build payload helpers ───────────────────────────────────────────
// REGISTER: type(1) + flags(1) + roomId(32) + relayLen(2) + relay + metadata
function buildRegisterPayload(roomId, entryRelay, metadata) {
  const relayBuf = Buffer.from(entryRelay, 'utf8')
  const payload = Buffer.alloc(1 + 1 + 32 + 2 + relayBuf.length + metadata.length)
  payload[0] = MSG_TRACKER_REGISTER
  payload[1] = 0x00 // flags: public
  roomId.copy(payload, 2)
  payload.writeUInt16BE(relayBuf.length, 34)
  relayBuf.copy(payload, 36)
  metadata.copy(payload, 36 + relayBuf.length)
  return payload
}

// HEARTBEAT: type(1) + roomId(32)
function buildHeartbeatPayload(roomId) {
  const payload = Buffer.alloc(1 + 32)
  payload[0] = MSG_TRACKER_HEARTBEAT
  roomId.copy(payload, 1)
  return payload
}

// ── State ───────────────────────────────────────────────────────────
const metadataKey = deriveMetadataKey()
const roomSecret = loadOrCreateSecret()
const roomKey = loadRoomKey()
const circuits = new Map()           // trackerUrl → TrackerCircuit
const registeredOnce = new Map()     // trackerUrl → Set<roomIdHex>
const lastMetaHash = new Map()       // roomIdHex → hash of metadata JSON
let lastLoggedCount = -1
let lastSettingsMtime = 0            // track room-settings.json changes

// ── Main publish cycle ──────────────────────────────────────────────
function checkSettingsChanged() {
  try {
    const stat = fs.statSync(ROOM_SETTINGS_PATH)
    const mtime = stat.mtimeMs
    if (mtime !== lastSettingsMtime) {
      lastSettingsMtime = mtime
      return true
    }
  } catch {}
  return false
}

async function publishAll() {
  const rooms = loadRooms()
  const entryRelay = getEntryRelay()

  // Detect settings file changes → force re-register on all trackers
  const settingsChanged = checkSettingsChanged()
  if (settingsChanged) {
    registeredOnce.clear()
    lastMetaHash.clear()
    console.log('[RoomPublisher] Settings changed — forcing re-register')
  }

  if (rooms.length === 0) {
    if (lastLoggedCount !== 0) {
      console.log('[RoomPublisher] No rooms to publish')
      lastLoggedCount = 0
    }
    return
  }

  let okCount = 0
  let failCount = 0

  for (const trackerUrl of knownTrackers) {
    let circuit = circuits.get(trackerUrl)

    // Build/rebuild circuit if needed
    if (!circuit || !circuit.ready) {
      if (circuit) circuit.close()
      circuit = new TrackerCircuit(trackerUrl)
      const ok = await circuit.build()
      if (!ok) {
        failCount += rooms.length
        circuits.delete(trackerUrl)
        registeredOnce.delete(trackerUrl) // force re-register on reconnect
        continue
      }
      circuits.set(trackerUrl, circuit)
      registeredOnce.delete(trackerUrl) // new circuit → must re-register
      console.log(`[RoomPublisher] Circuit to ${trackerUrl} established (id=${circuit.circuitId})`)
    }

    const registered = registeredOnce.get(trackerUrl) || new Set()
    let circuitBroken = false

    for (const room of rooms) {
      const roomId = deriveRoomId(room.id, roomSecret)
      const roomIdHex = roomId.toString('hex')

      // Build metadata JSON for this room
      const inviteToken = generateInviteToken(room.id, roomKey, metadataKey)
      const metaJson = JSON.stringify({
        envId: room.id,
        name: room.publishName || room.name,
        description: room.publishDescription || '',
        capacity: 8,
        tags: [],
        inviteToken,
        passwordProtected: !!room.passwordProtected,
      })

      // Check if metadata changed since last REGISTER
      const metaHash = crypto.createHash('md5').update(metaJson).digest('hex')
      const prevHash = lastMetaHash.get(roomIdHex)
      const metaChanged = prevHash && prevHash !== metaHash

      let payload
      if (registered.has(roomIdHex) && !metaChanged) {
        // Already registered, metadata unchanged — just heartbeat
        payload = buildHeartbeatPayload(roomId)
      } else {
        // First time or metadata changed — full REGISTER
        if (metaChanged) console.log(`[RoomPublisher] Metadata changed for ${room.id} — re-registering`)
        const metadata = encryptMetadata(Buffer.from(metaJson, 'utf8'), metadataKey)
        payload = buildRegisterPayload(roomId, entryRelay, metadata)
        lastMetaHash.set(roomIdHex, metaHash)
      }

      if (circuit.send(payload)) {
        registered.add(roomIdHex)
        okCount++
      } else {
        // Circuit broke mid-send
        circuit.close()
        circuits.delete(trackerUrl)
        registeredOnce.delete(trackerUrl)
        failCount += rooms.length
        circuitBroken = true
        break
      }
    }

    if (!circuitBroken) {
      registeredOnce.set(trackerUrl, registered)
    }
  }

  if (rooms.length !== lastLoggedCount || failCount > 0) {
    console.log(`[RoomPublisher] ${rooms.length} rooms → ${knownTrackers.length} trackers (${okCount} ok, ${failCount} fail) entry=${entryRelay}`)
    lastLoggedCount = rooms.length
  }
}

// ── Startup ─────────────────────────────────────────────────────────
console.log('[RoomPublisher] Starting — onion circuit publisher')
console.log(`[RoomPublisher] Trackers: ${knownTrackers.join(', ')}`)
console.log(`[RoomPublisher] Entry relay: ${getEntryRelay()}`)

// Initial publish after 5s
setTimeout(() => {
  publishAll().catch(err => console.error('[RoomPublisher] Error:', err.message))
}, 5000)

// Heartbeat every 60s — do NOT unref, this keeps the process alive
setInterval(() => {
  publishAll().catch(err => console.error('[RoomPublisher] Error:', err.message))
}, HEARTBEAT_INTERVAL)

// Watch room-settings.json for changes → immediate re-publish
let watchDebounce = null
try {
  const settingsDir = path.dirname(ROOM_SETTINGS_PATH)
  if (fs.existsSync(settingsDir)) {
    fs.watch(ROOM_SETTINGS_PATH, { persistent: false }, () => {
      if (watchDebounce) clearTimeout(watchDebounce)
      watchDebounce = setTimeout(() => {
        console.log('[RoomPublisher] room-settings.json changed — re-publishing now')
        publishAll().catch(err => console.error('[RoomPublisher] Error:', err.message))
      }, 1000) // 1s debounce
    })
    console.log('[RoomPublisher] Watching room-settings.json for changes')
  }
} catch (err) {
  console.log('[RoomPublisher] Could not watch settings file:', err.message)
}

// Safety net: prevent silent exits
process.on('uncaughtException', (err) => {
  console.error('[RoomPublisher] Uncaught exception:', err.message)
})
