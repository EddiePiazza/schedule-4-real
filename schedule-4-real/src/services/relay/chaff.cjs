// ═══════════════════════════════════════════════════════════════════
// chaff.cjs — Cover traffic generator to peer relays
// Sends random packets to make traffic analysis harder
// ═══════════════════════════════════════════════════════════════════
'use strict'

const WebSocket = require('ws')
const { randomBytes } = require('./crypto.cjs')

let chaffIntervals = []
let chaffConnections = new Map()

function startChaff(peerUrls, packetSize = 512, intervalMs = 100) {
  stopChaff()
  for (const url of peerUrls) {
    let ws = null
    let reconnectTimer = null

    function connect() {
      try {
        ws = new WebSocket(url)
        ws.on('open', () => {
          chaffConnections.set(url, ws)
        })
        ws.on('close', () => {
          chaffConnections.delete(url)
          reconnectTimer = setTimeout(connect, 5000)
        })
        ws.on('error', () => {
          chaffConnections.delete(url)
        })
      } catch {}
    }

    connect()

    const iv = setInterval(() => {
      const conn = chaffConnections.get(url)
      if (conn && conn.readyState === WebSocket.OPEN) {
        const packet = Buffer.alloc(packetSize)
        packet[0] = 0xFF // chaff tag
        const payload = randomBytes(packetSize - 1)
        payload.copy(packet, 1)
        try { conn.send(packet) } catch {}
      }
    }, intervalMs)

    chaffIntervals.push({ iv, url, reconnectTimer: () => reconnectTimer })
  }
}

function stopChaff() {
  for (const { iv } of chaffIntervals) {
    clearInterval(iv)
  }
  for (const [, ws] of chaffConnections) {
    try { ws.close() } catch {}
  }
  chaffIntervals = []
  chaffConnections.clear()
}

module.exports = { startChaff, stopChaff }
