'use strict'

const WebSocket = require('ws')
const {
  generateKxKeypair, serverSessionKeys,
  decrypt, encrypt, padPacket, randomBytes,
  NONCE_BYTES, MAC_BYTES, KX_PK_BYTES
} = require('./crypto.cjs')
const { registerCircuit, getCircuit, destroyCircuit } = require('./circuits.cjs')
const { establishRendezvous, joinRendezvous, relayRendezvousData } = require('./rendezvous.cjs')

const MSG = {
  HANDSHAKE_INIT: 0x01,
  HANDSHAKE_REPLY: 0x02,
  RELAY: 0x10,
  DATA: 0x20,
  ESTABLISH_RENDEZVOUS: 0x30,
  RENDEZVOUS_ESTABLISHED: 0x31,
  INTRODUCE: 0x32,
  RENDEZVOUS_JOIN: 0x33,
  TRACKER_REGISTER: 0x40,
  TRACKER_QUERY: 0x41,
  TRACKER_RESPONSE: 0x42,
  TRACKER_HEARTBEAT: 0x43,
  TRACKER_INTRODUCE: 0x44,
  TRACKER_INTRODUCE_DATA: 0x45,
  CIRCUIT_DESTROY: 0xF0,
  CHAFF: 0xFF,
}

// Runtime config — populated by configure()
const config = {
  keySeed: null,
  packetSize: 1024,
  maxJitter: 0,
  trackerInternalPort: null,
  trackerUrl: null,
}

let relayKeypair = null
let previousKeypair = null
const outboundPool = new Map()

// Internal tracker connection (only if this relay co-hosts tracker)
let trackerWs = null
let trackerDirectHandler = null // function(data, ws, circuitIdBuf) — for co-hosted tracker
const trackerPendingCallbacks = new Map()

function configure(opts) {
  if (opts.keySeed !== undefined) config.keySeed = opts.keySeed
  if (opts.packetSize !== undefined) config.packetSize = opts.packetSize
  if (opts.maxJitter !== undefined) config.maxJitter = opts.maxJitter
  if (opts.trackerInternalPort !== undefined) config.trackerInternalPort = opts.trackerInternalPort
  if (opts.trackerUrl !== undefined) config.trackerUrl = opts.trackerUrl

  // (Re)generate keypair with the configured seed
  relayKeypair = generateKxKeypair(config.keySeed)
  previousKeypair = null
}

// Set a direct handler for tracker messages (co-hosted tracker, no WS needed)
// handler(data, ws, circuitIdBuf) → returns Buffer response or null
function setTrackerHandler(handler) {
  trackerDirectHandler = handler
}

function getTrackerWs() {
  // Support both internal port (co-hosted tracker) and external URL
  const trackerTarget = config.trackerInternalPort
    ? `ws://127.0.0.1:${config.trackerInternalPort}`
    : config.trackerUrl || null
  if (!trackerTarget) return null
  if (trackerWs && trackerWs.readyState === WebSocket.OPEN) return trackerWs
  trackerWs = new WebSocket(trackerTarget)
  trackerWs.on('message', (data) => {
    // Route tracker responses back through the appropriate circuit
    try {
      const buf = Buffer.from(data)
      if (buf.length < 5) return
      const circuitId = buf.readUInt32BE(0)
      const responsePayload = buf.subarray(4)
      const cb = trackerPendingCallbacks.get(circuitId)
      if (cb) {
        cb(responsePayload)
      } else {
        // Push message (e.g. TRACKER_INTRODUCE_DATA) -- send directly to circuit
        const circuit = getCircuit(circuitId)
        if (circuit) sendToCircuit(circuit, responsePayload)
      }
    } catch {}
  })
  trackerWs.on('error', () => {})
  trackerWs.on('close', () => { trackerWs = null })
  return trackerWs
}

function handlePacket(rawData, ws) {
  if (rawData.length < NONCE_BYTES + 4 + MAC_BYTES + 1) return
  if (rawData[0] === 0xFF) return // chaff

  const circuitId = rawData.readUInt32BE(NONCE_BYTES)
  const circuit = getCircuit(circuitId)

  if (!circuit) {
    handleHandshake(rawData, circuitId, ws)
    return
  }

  const aad = Buffer.alloc(4)
  aad.writeUInt32BE(circuitId)

  const encryptedPayload = Buffer.concat([
    rawData.subarray(0, NONCE_BYTES),
    rawData.subarray(NONCE_BYTES + 4)
  ])

  const plaintext = decrypt(encryptedPayload, circuit.rx, aad)
  if (!plaintext) {
    console.log(`[RELAY] Decrypt failed for circuit ${circuitId} (${rawData.length}B)`)
    return
  }

  const msgType = plaintext[0]
  const nextHopLen = plaintext[1]
  const nextHop = nextHopLen > 0 ? plaintext.subarray(2, 2 + nextHopLen).toString('utf8') : null
  const payloadLen = plaintext.readUInt16BE(2 + nextHopLen)
  const payload = plaintext.subarray(4 + nextHopLen, 4 + nextHopLen + payloadLen)

  if (msgType >= 0x40 && msgType <= 0x45) {
    console.log(`[RELAY] Tracker msg 0x${msgType.toString(16)} on circuit ${circuitId} (${payload.length}B payload, hop=${nextHop || 'local'})`)
  }

  const jitter = Math.random() * config.maxJitter
  setTimeout(() => processMessage(msgType, nextHop, payload, circuit, ws), jitter)
}

function handleHandshake(rawData, circuitId, ws) {
  if (rawData.length < NONCE_BYTES + 4 + KX_PK_BYTES) return
  const clientPk = rawData.subarray(NONCE_BYTES + 4, NONCE_BYTES + 4 + KX_PK_BYTES)

  let keys
  try {
    keys = serverSessionKeys(relayKeypair.publicKey, relayKeypair.secretKey, clientPk)
  } catch {
    // Try previous keypair
    if (previousKeypair) {
      try {
        keys = serverSessionKeys(previousKeypair.publicKey, previousKeypair.secretKey, clientPk)
      } catch { return }
    } else { return }
  }

  if (!registerCircuit(circuitId, keys.rx, keys.tx, ws)) return

  // Reply format: magic("SFPK",4) + serverPk(32) + nonce(24) + circuitId(4) + ciphertext
  // Magic prefix allows client to detect new format vs old relays
  // serverPk is cleartext so client can derive session keys before decrypting
  const reply = Buffer.alloc(1 + KX_PK_BYTES)
  reply[0] = MSG.HANDSHAKE_REPLY
  relayKeypair.publicKey.copy(reply, 1)

  const aad = Buffer.alloc(4)
  aad.writeUInt32BE(circuitId)
  const encrypted = encrypt(reply, keys.tx, aad) // nonce(24) + ciphertext

  const MAGIC = Buffer.from('SFPK')
  const packet = Buffer.alloc(4 + KX_PK_BYTES + NONCE_BYTES + 4 + encrypted.length - NONCE_BYTES)
  MAGIC.copy(packet, 0)                                   // magic at offset 0
  relayKeypair.publicKey.copy(packet, 4)                   // cleartext serverPk at offset 4
  encrypted.copy(packet, 4 + KX_PK_BYTES, 0, NONCE_BYTES) // nonce at offset 36
  packet.writeUInt32BE(circuitId, 4 + KX_PK_BYTES + NONCE_BYTES) // circuitId at offset 60
  encrypted.copy(packet, 4 + KX_PK_BYTES + NONCE_BYTES + 4, NONCE_BYTES) // ciphertext at offset 64

  ws.send(padPacket(packet, config.packetSize))
}

function processMessage(msgType, nextHop, payload, circuit, ws) {
  switch (msgType) {
    case MSG.RELAY:
      if (nextHop) forwardToHop(nextHop, payload, circuit)
      break

    case MSG.DATA:
      if (circuit.rendezvousPairId) {
        // Forward E2E payload to paired circuit WITH circuit-layer encryption
        const toCircuit = getCircuit(circuit.rendezvousPairId)
        if (toCircuit) {
          // Build a proper DATA message: type(1) + nextHopLen(1=0) + payloadLen(2) + payload
          const dataMsg = Buffer.alloc(4 + payload.length)
          dataMsg[0] = MSG.DATA
          dataMsg[1] = 0 // no next hop
          dataMsg.writeUInt16BE(payload.length, 2)
          if (Buffer.isBuffer(payload)) {
            payload.copy(dataMsg, 4)
          } else {
            Buffer.from(payload).copy(dataMsg, 4)
          }
          sendToCircuit(toCircuit, dataMsg)
        }
      }
      break

    case MSG.ESTABLISH_RENDEZVOUS: {
      const cookie = payload.subarray(0, 20)
      const result = establishRendezvous(circuit.circuitId, cookie)
      // Build proper message envelope: type(1) + nextHopLen(1=0) + payloadLen(2) + payload(1)
      const replyBuf = Buffer.alloc(5)
      replyBuf[0] = MSG.RENDEZVOUS_ESTABLISHED
      replyBuf[1] = 0 // no next hop
      replyBuf.writeUInt16BE(1, 2) // payload length = 1
      replyBuf[4] = result.success ? 1 : 0
      sendToCircuit(circuit, replyBuf)
      break
    }

    case MSG.RENDEZVOUS_JOIN: {
      const joinCookie = payload.subarray(0, 20)
      const joinHandshakeData = payload.subarray(20)
      const joinResult = joinRendezvous(circuit.circuitId, joinCookie)
      if (joinResult.success) {
        const visitorCircuit = getCircuit(joinResult.visitorCircuitId)
        if (visitorCircuit) {
          // Build proper message envelope: type(1) + nextHopLen(1=0) + payloadLen(2) + payload
          const handshakeMsg = Buffer.alloc(4 + joinHandshakeData.length)
          handshakeMsg[0] = MSG.RENDEZVOUS_JOIN
          handshakeMsg[1] = 0 // no next hop
          handshakeMsg.writeUInt16BE(joinHandshakeData.length, 2)
          joinHandshakeData.copy(handshakeMsg, 4)
          sendToCircuit(visitorCircuit, handshakeMsg)
        }
      }
      break
    }

    case MSG.TRACKER_REGISTER:
    case MSG.TRACKER_QUERY:
    case MSG.TRACKER_HEARTBEAT:
    case MSG.TRACKER_INTRODUCE: {
      // Direct handler (co-hosted tracker — no WS roundtrip)
      if (trackerDirectHandler) {
        const circuitIdBuf = Buffer.alloc(4)
        circuitIdBuf.writeUInt32BE(circuit.circuitId, 0)
        const response = trackerDirectHandler(payload, ws, circuitIdBuf)
        if (response) {
          // Wrap tracker response in standard message envelope
          // The tracker returns raw protocol data; we wrap it as:
          // type(1) + nextHopLen(1=0) + payloadLen(2) + payload
          const responseType = response[0] || 0x42 // TRACKER_RESPONSE
          const responsePayload = response.subarray(1)
          const wrapped = Buffer.alloc(4 + responsePayload.length)
          wrapped[0] = responseType
          wrapped[1] = 0 // no next hop
          wrapped.writeUInt16BE(responsePayload.length, 2)
          responsePayload.copy(wrapped, 4)
          sendToCircuit(circuit, wrapped)
        }
        break
      }
      // Forward to tracker via WS (external tracker)
      const tw = getTrackerWs()
      if (tw && tw.readyState === WebSocket.OPEN) {
        const withCircuit = Buffer.alloc(4 + payload.length)
        withCircuit.writeUInt32BE(circuit.circuitId, 0)
        payload.copy(withCircuit, 4)
        trackerPendingCallbacks.set(circuit.circuitId, (responsePayload) => {
          // Wrap tracker response in standard message envelope
          const rType = responsePayload[0] || 0x42
          const rData = responsePayload.subarray(1)
          const rWrapped = Buffer.alloc(4 + rData.length)
          rWrapped[0] = rType
          rWrapped[1] = 0
          rWrapped.writeUInt16BE(rData.length, 2)
          rData.copy(rWrapped, 4)
          sendToCircuit(circuit, rWrapped)
          trackerPendingCallbacks.delete(circuit.circuitId)
        })
        tw.send(withCircuit)
      } else if (nextHop) {
        forwardToHop(nextHop, payload, circuit)
      }
      break
    }

    case MSG.CIRCUIT_DESTROY:
      destroyCircuit(circuit.circuitId)
      break
  }
}

function forwardToHop(hopUrl, payload, circuit) {
  // If circuit already has outbound WS (extend completed), forward directly
  if (circuit.outboundWs && circuit.outboundWs.readyState === WebSocket.OPEN) {
    console.log(`[RELAY] Forward ${payload.length}B to ${hopUrl} (existing WS) circuit=${circuit.circuitId}`)
    circuit.outboundWs.send(payload)
    return
  }

  // New extend: open per-circuit WS to next hop
  const ws = new WebSocket(hopUrl)
  ws.on('open', () => {
    ws.send(padPacket(payload, config.packetSize))
  })
  ws.on('message', (data) => {
    const raw = Buffer.from(data)
    if (!circuit.outboundWs) {
      // First reply = extend handshake — wrap in HANDSHAKE_REPLY frame
      circuit.outboundWs = ws
      circuit.nextHop = hopUrl
      const msg = Buffer.alloc(1 + 1 + 2 + raw.length)
      msg[0] = MSG.HANDSHAKE_REPLY
      msg[1] = 0
      msg.writeUInt16BE(raw.length, 2)
      raw.copy(msg, 4)
      sendToCircuit(circuit, msg)
    } else {
      // Post-extend: forward raw (already encrypted for client by next hop)
      sendToCircuit(circuit, raw)
    }
  })
  ws.on('close', () => {
    if (circuit.outboundWs === ws) circuit.outboundWs = null
  })
  ws.on('error', () => {
    if (circuit.outboundWs === ws) circuit.outboundWs = null
  })
}

function sendToCircuit(circuit, plaintext) {
  const aad = Buffer.alloc(4)
  aad.writeUInt32BE(circuit.circuitId)
  const encrypted = encrypt(plaintext, circuit.tx, aad)
  if (circuit.inboundWs && circuit.inboundWs.readyState === WebSocket.OPEN) {
    // No post-encryption padding — random bytes after ciphertext corrupt MAC
    circuit.inboundWs.send(encrypted)
  }
}

/**
 * Push a message to a specific circuit by its 4-byte ID buffer.
 * Used by co-hosted tracker to send INTRODUCE_DATA through proper circuit encryption.
 */
function pushToCircuitById(circuitIdBuf, payload) {
  const circuitId = circuitIdBuf.readUInt32BE(0)
  const circuit = getCircuit(circuitId)
  if (circuit) sendToCircuit(circuit, payload)
}

function getRelayPublicKey() {
  return relayKeypair.publicKey
}

function rotateKeys() {
  previousKeypair = relayKeypair
  relayKeypair = generateKxKeypair()
  setTimeout(() => {
    if (previousKeypair) {
      previousKeypair.secretKey.fill(0)
      previousKeypair = null
    }
  }, 120000)
}

module.exports = {
  MSG,
  configure,
  setTrackerHandler,
  handlePacket,
  pushToCircuitById,
  getRelayPublicKey,
  rotateKeys,
}
