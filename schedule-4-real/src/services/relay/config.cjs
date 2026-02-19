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
  fs.writeFileSync(idFile, JSON.stringify(identity, null, 2))
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
      return { ...defaults, ...saved }
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

module.exports = {
  DATA_DIR, SEED_NODES,
  loadIdentity, loadConfig, saveConfig, loadPeers, savePeers,
  ensureDataDir,
}
