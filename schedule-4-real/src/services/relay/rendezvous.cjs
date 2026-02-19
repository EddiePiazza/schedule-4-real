// ═══════════════════════════════════════════════════════════════════
// rendezvous.cjs — Cookie-based rendezvous point pairing
// ═══════════════════════════════════════════════════════════════════
'use strict'

const { getCircuit } = require('./circuits.cjs')

const pendingRendezvous = new Map()
const MAX_PENDING = 10000
const COOKIE_TTL_MS = 30000

function establishRendezvous(circuitId, cookie) {
  if (cookie.length !== 20) return { success: false, error: 'Cookie must be 20 bytes' }
  const cookieHex = cookie.toString('hex')
  if (pendingRendezvous.has(cookieHex)) return { success: false, error: 'Cookie already in use' }
  if (pendingRendezvous.size >= MAX_PENDING) return { success: false, error: 'Too many pending' }
  pendingRendezvous.set(cookieHex, { circuitId, timestamp: Date.now() })
  return { success: true }
}

function joinRendezvous(hostCircuitId, cookie) {
  const cookieHex = cookie.toString('hex')
  const pending = pendingRendezvous.get(cookieHex)
  if (!pending) return { success: false, error: 'Cookie not found or expired' }
  pendingRendezvous.delete(cookieHex)
  const visitorCircuit = getCircuit(pending.circuitId)
  const hostCircuit = getCircuit(hostCircuitId)
  if (!visitorCircuit || !hostCircuit) return { success: false, error: 'Circuit no longer exists' }
  visitorCircuit.rendezvousPairId = hostCircuitId
  hostCircuit.rendezvousPairId = pending.circuitId
  return { success: true, visitorCircuitId: pending.circuitId }
}

function relayRendezvousData(fromCircuitId, data) {
  const fromCircuit = getCircuit(fromCircuitId)
  if (!fromCircuit || !fromCircuit.rendezvousPairId) return false
  const toCircuit = getCircuit(fromCircuit.rendezvousPairId)
  if (!toCircuit || !toCircuit.inboundWs) return false
  if (toCircuit.inboundWs.readyState === 1) {
    toCircuit.inboundWs.send(data)
    return true
  }
  return false
}

function cleanupPendingRendezvous() {
  const now = Date.now()
  for (const [cookieHex, entry] of pendingRendezvous) {
    if (now - entry.timestamp > COOKIE_TTL_MS) {
      pendingRendezvous.delete(cookieHex)
    }
  }
}

module.exports = { establishRendezvous, joinRendezvous, relayRendezvousData, cleanupPendingRendezvous }
