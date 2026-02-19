// ═══════════════════════════════════════════════════════════════════
// join-page.cjs — SSR HTML page listing public rooms at GET /join
// Decrypts room metadata and renders a dark-themed standalone page
// ═══════════════════════════════════════════════════════════════════
'use strict'

const sodium = require('sodium-native')

const METADATA_SEED = 'spiderfarmer-room-metadata-v1'
const NONCE_BYTES = 24
const MAC_BYTES = 16

let metadataKey = null

function getMetadataKey() {
  if (!metadataKey) {
    metadataKey = Buffer.alloc(32)
    sodium.crypto_generichash(metadataKey, Buffer.from(METADATA_SEED))
  }
  return metadataKey
}

function decryptMetadata(encryptedBuf) {
  const key = getMetadataKey()
  if (!encryptedBuf || encryptedBuf.length < NONCE_BYTES + MAC_BYTES) return null

  const nonce = encryptedBuf.subarray(0, NONCE_BYTES)
  const ciphertext = encryptedBuf.subarray(NONCE_BYTES)
  const plaintext = Buffer.alloc(ciphertext.length - MAC_BYTES)

  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plaintext, null, ciphertext, null, nonce, key
    )
    return JSON.parse(plaintext.toString('utf8'))
  } catch {
    return null
  }
}

function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Render the public rooms listing page.
 * @param {Function} listPublicRooms - returns array of { roomId, metadata: Buffer, entryRelay, federated }
 * @param {string} relayUrl - this relay's public URL (wss://...)
 * @returns {string} HTML page
 */
async function renderJoinPage(listPublicRooms, relayUrl) {
  const publicRooms = listPublicRooms()

  // Decrypt metadata for each room
  const rooms = []
  for (const room of publicRooms) {
    const meta = decryptMetadata(room.metadata)
    if (!meta) continue
    rooms.push({
      roomId: room.roomId,
      entryRelay: room.entryRelay,
      federated: room.federated,
      name: meta.name || 'Unnamed Room',
      description: meta.description || '',
      capacity: meta.capacity || 8,
      tags: meta.tags || [],
      inviteToken: meta.inviteToken || '',
      passwordProtected: !!meta.passwordProtected,
    })
  }

  rooms.sort((a, b) => a.name.localeCompare(b.name))

  const roomCards = rooms.map(room => {
    const hasToken = !!room.inviteToken
    const joinUrl = hasToken ? `${room.entryRelay}/join/${room.inviteToken}` : ''

    return `
      <div class="room-card" data-search="${esc((room.name + ' ' + room.description).toLowerCase())}">
        <div class="room-header">
          <div class="room-name">${room.passwordProtected ? '<span class="lock">&#128274;</span> ' : ''}${esc(room.name)}</div>
          <div class="room-cap">${room.capacity} max</div>
        </div>
        ${room.description ? `<div class="room-desc">${esc(room.description)}</div>` : ''}
        <div class="room-footer">
          <div class="room-tags">${room.federated ? '<span class="tag tag-fed">federated</span>' : ''}${room.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
          ${hasToken ? `<a href="${esc(joinUrl)}" class="join-btn">Join</a>` : '<span class="join-na">Waiting for host...</span>'}
        </div>
      </div>`
  }).join('')

  const count = rooms.length
  const empty = count === 0
    ? '<div class="empty">No public rooms available right now.<br>Check back later.</div>'
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Public Rooms</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0f;color:#e0e0e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;padding:2rem 1rem}
.wrap{max-width:720px;margin:0 auto}
h1{font-size:1.75rem;font-weight:700;color:#f0f0f5;margin-bottom:.25rem}
.sub{color:#777;margin-bottom:1.5rem}
.search{width:100%;padding:.75rem 1rem;background:#16161f;border:1px solid #2a2a3a;border-radius:.5rem;color:#e0e0e5;font-size:1rem;margin-bottom:1.25rem;outline:none}
.search:focus{border-color:#14b8a6}
.search::placeholder{color:#555}
.list{display:flex;flex-direction:column;gap:.75rem}
.room-card{background:#13131d;border:1px solid #2a2a3a;border-radius:.75rem;padding:1.25rem;transition:border-color .2s,box-shadow .2s}
.room-card:hover{border-color:rgba(20,184,166,.5);box-shadow:0 4px 20px rgba(0,0,0,.4)}
.room-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem}
.room-name{font-size:1.125rem;font-weight:600;color:#f0f0f5}
.room-cap{color:#666;white-space:nowrap;margin-left:1rem}
.room-desc{color:#999;margin-bottom:.75rem;line-height:1.5}
.room-footer{display:flex;justify-content:space-between;align-items:center;gap:.5rem}
.room-tags{display:flex;gap:.4rem;flex-wrap:wrap}
.tag{background:rgba(20,184,166,.12);color:#14b8a6;padding:.15rem .6rem;border-radius:1rem;font-size:.85rem}
.tag-fed{background:rgba(139,92,246,.12);color:#8b5cf6}
.lock{font-size:.9em}
.join-btn{display:inline-block;background:#14b8a6;color:#0a0a0f;padding:.5rem 1.25rem;border-radius:.5rem;text-decoration:none;font-weight:600;font-size:1rem;transition:background .2s;white-space:nowrap}
.join-btn:hover{background:#0d9488}
.join-na{color:#555;font-size:.9rem}
.empty{text-align:center;padding:4rem 1rem;color:#555;font-size:1.125rem;line-height:1.6}
.foot{text-align:center;color:#333;margin-top:2rem;font-size:.85rem}
</style>
</head>
<body>
<div class="wrap">
<h1>Public Rooms</h1>
<div class="sub">${count} room${count !== 1 ? 's' : ''} available</div>
${count > 3 ? '<input type="text" class="search" placeholder="Search rooms..." id="q">' : ''}
<div class="list" id="r">${roomCards}${empty}</div>
<div class="foot">Auto-refreshes every 30s</div>
</div>
<script>
var q=document.getElementById('q');
if(q)q.addEventListener('input',function(){var v=this.value.toLowerCase();document.querySelectorAll('.room-card').forEach(function(c){c.style.display=c.dataset.search.indexOf(v)>=0?'':'none'})});
setTimeout(function(){location.reload()},30000);
</script>
</body>
</html>`
}

module.exports = { renderJoinPage }
