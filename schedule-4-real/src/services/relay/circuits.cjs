// ═══════════════════════════════════════════════════════════════════
// circuits.cjs — Circuit state management
// ═══════════════════════════════════════════════════════════════════
'use strict'

const circuits = new Map()
let maxCircuits = 10000
let sessionTtl = 300000

function configure(opts) {
  if (opts.maxCircuits) maxCircuits = opts.maxCircuits
  if (opts.sessionTtl) sessionTtl = opts.sessionTtl
}

function registerCircuit(circuitId, rx, tx, inboundWs) {
  if (circuits.size >= maxCircuits) return false
  circuits.set(circuitId, {
    circuitId, rx, tx, inboundWs,
    outboundWs: null,
    lastActivity: Date.now(),
    nextHop: null,
    rendezvousPairId: null,
  })
  return true
}

function getCircuit(circuitId) {
  const circuit = circuits.get(circuitId)
  if (circuit) circuit.lastActivity = Date.now()
  return circuit
}

function destroyCircuit(circuitId) {
  const circuit = circuits.get(circuitId)
  if (!circuit) return
  if (circuit.outboundWs && circuit.outboundWs.readyState <= 1) {
    circuit.outboundWs.close()
  }
  if (circuit.rx) circuit.rx.fill(0)
  if (circuit.tx) circuit.tx.fill(0)
  if (circuit.rendezvousPairId) {
    const pair = circuits.get(circuit.rendezvousPairId)
    if (pair) {
      pair.rendezvousPairId = null
      destroyCircuit(pair.circuitId)
    }
  }
  circuits.delete(circuitId)
}

function cleanupExpired() {
  const now = Date.now()
  for (const [id, circuit] of circuits) {
    if (now - circuit.lastActivity > sessionTtl) {
      destroyCircuit(id)
    }
  }
}

function activeCount() {
  return circuits.size
}

module.exports = { configure, registerCircuit, getCircuit, destroyCircuit, cleanupExpired, activeCount }
