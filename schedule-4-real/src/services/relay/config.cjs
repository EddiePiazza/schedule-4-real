// ═══════════════════════════════════════════════════════════════════
// config.cjs — Relay configuration loader
// Reads from data/relay/relay-config.json + defaults
// ═══════════════════════════════════════════════════════════════════
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomBytes, generateKxKeypair, generateSignKeypair } = require('./crypto.cjs')

const DATA_DIR = path.join(process.cwd(), 'data', 'relay')

// Seed nodes — hardcoded public URLs + public keys
// These are always-available bootstrap nodes for new installations
const SEED_NODES = [
  { url: 'wss://schedule4real.com/rooms', pk: '' }, // pk filled at runtime from /pk endpoint
  { url: 'wss://r2.imaset.com', pk: '' },
]

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

function loadIdentity() {
  ensureDataDir()
  const idFile = path.join(DATA_DIR, 'relay-identity.json')
  if (fs.existsSync(idFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(idFile, 'utf-8'))
      // Fix permissions on existing identity files (security hardening)
      try { fs.chmodSync(idFile, 0o600) } catch {}
      return {
        kxSeed: Buffer.from(data.kxSeed, 'hex'),
        signSeed: Buffer.from(data.signSeed, 'hex'),
      }
    } catch {}
  }
  // Generate new identity
  const kxSeed = randomBytes(32)
  const signSeed = randomBytes(32)
  const identity = { kxSeed: kxSeed.toString('hex'), signSeed: signSeed.toString('hex') }
  fs.writeFileSync(idFile, JSON.stringify(identity, null, 2), { mode: 0o600 })
  console.log('[RELAY] Generated new relay identity')
  return { kxSeed, signSeed }
}

function loadConfig() {
  ensureDataDir()
  const configFile = path.join(DATA_DIR, 'relay-config.json')
  const defaults = {
    enabled: true,
    trackerEnabled: false,             // Room registry (tracker) — off by default for privacy
    port: 9443,
    publicUrl: '',
    keyRotationIntervalMs: 3600000,    // 1 hour
    sessionTtlMs: 300000,              // 5 min circuit TTL
    packetSize: 512,
    chaffIntervalMs: 100,              // 10 packets/sec
    maxCircuits: 10000,
    maxJitterMs: 3,
    roomTtlMs: 120000,                 // 2 min room TTL
    roomHeartbeatIntervalMs: 60000,    // 1 min heartbeat
    maxRooms: 50000,
  }

  if (fs.existsSync(configFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configFile, 'utf-8'))
      const config = { ...defaults, ...saved }
      // Normalize publicUrl — UI stores domain-only, add wss:// if missing
      if (config.publicUrl && !config.publicUrl.startsWith('wss://') && !config.publicUrl.startsWith('ws://')) {
        config.publicUrl = 'wss://' + config.publicUrl
      }
      return config
    } catch {}
  }

  // Write defaults
  fs.writeFileSync(configFile, JSON.stringify(defaults, null, 2))
  return defaults
}

function saveConfig(config) {
  ensureDataDir()
  const configFile = path.join(DATA_DIR, 'relay-config.json')
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
}

function loadPeers() {
  const peersFile = path.join(DATA_DIR, 'peers.json')
  if (fs.existsSync(peersFile)) {
    try {
      return JSON.parse(fs.readFileSync(peersFile, 'utf-8'))
    } catch {}
  }
  return []
}

function savePeers(peers) {
  ensureDataDir()
  const peersFile = path.join(DATA_DIR, 'peers.json')
  fs.writeFileSync(peersFile, JSON.stringify(peers, null, 2))
}

/**
 * Load encrypted bootstrap peers from bootstrap-peers.enc (fallback when seeds are unreachable).
 * Requires BOOTSTRAP_PEERS_KEY in process.env and sodium-native.
 */
function loadBootstrapPeers() {
  const keyHex = process.env.BOOTSTRAP_PEERS_KEY
  if (!keyHex || keyHex.length !== 64) return []

  const encFile = path.join(DATA_DIR, 'bootstrap-peers.enc')
  if (!fs.existsSync(encFile)) return []

  try {
    const sodium = require('sodium-native')
    const encData = fs.readFileSync(encFile)
    if (encData.length < 24 + 16) return []

    const key = Buffer.from(keyHex, 'hex')
    const nonce = encData.subarray(0, 24)
    const ciphertext = encData.subarray(24)
    const plaintext = Buffer.alloc(ciphertext.length - 16)
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(plaintext, null, ciphertext, null, nonce, key)
    const data = JSON.parse(plaintext.toString('utf-8'))
    return (data.peers || []).map(p => ({
      url: '', pk: p.pk, signPk: p.signPk, tracker: !!p.tracker,
      ts: data.ts || 0, failures: 0, lastSeen: 0,
    }))
  } catch { return [] }
}

module.exports = {
  DATA_DIR, SEED_NODES,
  loadIdentity, loadConfig, saveConfig, loadPeers, savePeers,
  loadBootstrapPeers, ensureDataDir,
}
