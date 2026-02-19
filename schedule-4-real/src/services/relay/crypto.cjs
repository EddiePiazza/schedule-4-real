// ═══════════════════════════════════════════════════════════════════
// crypto.cjs — libsodium wrappers for onion relay
// XChaCha20-Poly1305 AEAD, X25519 key exchange, packet padding
// ═══════════════════════════════════════════════════════════════════
'use strict'

const sodium = require('sodium-native')

const KX_PK_BYTES = sodium.crypto_kx_PUBLICKEYBYTES    // 32
const KX_SK_BYTES = sodium.crypto_kx_SECRETKEYBYTES    // 32
const KX_SESSION_BYTES = sodium.crypto_kx_SESSIONKEYBYTES // 32
const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES // 24
const MAC_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES      // 16
const SIGN_PK_BYTES = sodium.crypto_sign_PUBLICKEYBYTES // 32
const SIGN_SK_BYTES = sodium.crypto_sign_SECRETKEYBYTES // 64
const SIGN_BYTES = sodium.crypto_sign_BYTES             // 64

function generateKxKeypair(seed) {
  const pk = Buffer.alloc(KX_PK_BYTES)
  const sk = sodium.sodium_malloc(KX_SK_BYTES)
  if (seed) {
    sodium.crypto_kx_seed_keypair(pk, sk, seed)
  } else {
    sodium.crypto_kx_keypair(pk, sk)
  }
  return { publicKey: pk, secretKey: sk }
}

function serverSessionKeys(relayPk, relaySk, clientPk) {
  const rx = sodium.sodium_malloc(KX_SESSION_BYTES)
  const tx = sodium.sodium_malloc(KX_SESSION_BYTES)
  sodium.crypto_kx_server_session_keys(rx, tx, relayPk, relaySk, clientPk)
  return { rx, tx }
}

function encrypt(plaintext, key, aad = null) {
  const nonce = Buffer.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const ciphertext = Buffer.alloc(plaintext.length + MAC_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext, plaintext, aad, null, nonce, key
  )
  return Buffer.concat([nonce, ciphertext])
}

function decrypt(nonceAndCiphertext, key, aad = null) {
  if (nonceAndCiphertext.length < NONCE_BYTES + MAC_BYTES) return null
  const nonce = nonceAndCiphertext.subarray(0, NONCE_BYTES)
  const ciphertext = nonceAndCiphertext.subarray(NONCE_BYTES)
  const plaintext = Buffer.alloc(ciphertext.length - MAC_BYTES)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plaintext, null, ciphertext, aad, nonce, key
    )
    return plaintext
  } catch {
    return null
  }
}

function padPacket(data, targetSize) {
  if (data.length >= targetSize) return data   // never truncate — would destroy MAC
  const padded = Buffer.alloc(targetSize)
  data.copy(padded)
  const padding = padded.subarray(data.length)
  sodium.randombytes_buf(padding)
  return padded
}

function hash(input, outputLen = 32) {
  const output = Buffer.alloc(outputLen)
  sodium.crypto_generichash(output, input)
  return output
}

function randomBytes(length) {
  const buf = Buffer.alloc(length)
  sodium.randombytes_buf(buf)
  return buf
}

// Ed25519 signing for gossip protocol
function generateSignKeypair(seed) {
  const pk = Buffer.alloc(SIGN_PK_BYTES)
  const sk = sodium.sodium_malloc(SIGN_SK_BYTES)
  if (seed) {
    sodium.crypto_sign_seed_keypair(pk, sk, seed)
  } else {
    sodium.crypto_sign_keypair(pk, sk)
  }
  return { publicKey: pk, secretKey: sk }
}

function sign(message, secretKey) {
  const sig = Buffer.alloc(SIGN_BYTES)
  sodium.crypto_sign_detached(sig, message, secretKey)
  return sig
}

function verify(sig, message, publicKey) {
  try {
    return sodium.crypto_sign_verify_detached(sig, message, publicKey)
  } catch {
    return false
  }
}

module.exports = {
  KX_PK_BYTES, KX_SK_BYTES, KX_SESSION_BYTES,
  NONCE_BYTES, MAC_BYTES,
  SIGN_PK_BYTES, SIGN_SK_BYTES, SIGN_BYTES,
  generateKxKeypair, serverSessionKeys,
  encrypt, decrypt, padPacket, hash, randomBytes,
  generateSignKeypair, sign, verify,
}
