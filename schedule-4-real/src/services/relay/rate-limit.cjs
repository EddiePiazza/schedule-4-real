// ═══════════════════════════════════════════════════════════════════
// rate-limit.cjs — Per-IP sliding window rate limiter for relay
// In-memory, no external dependencies. Auto-cleans expired entries.
// ═══════════════════════════════════════════════════════════════════
'use strict'

/**
 * Create a rate limiter with a sliding window.
 * @param {number} maxRequests  Max requests per window
 * @param {number} windowMs     Window duration in milliseconds
 * @returns {{ check(ip: string): boolean, reset(): void }}
 */
function createRateLimiter(maxRequests, windowMs) {
  // ip → { timestamps: number[], blocked: number (epoch when unblocked, 0 = not blocked) }
  const buckets = new Map()
  const MAX_TRACKED_IPS = 50000 // prevent memory exhaustion from distributed attack

  // Cleanup every 60s
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    const cutoff = now - windowMs * 2
    for (const [ip, bucket] of buckets) {
      // Remove entries where all timestamps are expired and not blocked
      if (bucket.blocked && bucket.blocked > now) continue
      const fresh = bucket.timestamps.filter(t => t > cutoff)
      if (fresh.length === 0) {
        buckets.delete(ip)
      } else {
        bucket.timestamps = fresh
      }
    }
  }, 60000)
  if (cleanupTimer.unref) cleanupTimer.unref()

  return {
    /**
     * Check if a request from this IP should be allowed.
     * Returns true if allowed, false if rate-limited.
     * @param {string} ip
     * @returns {boolean}
     */
    check(ip) {
      const now = Date.now()

      let bucket = buckets.get(ip)
      if (!bucket) {
        if (buckets.size >= MAX_TRACKED_IPS) {
          // Under extreme load, start rejecting new IPs
          return false
        }
        bucket = { timestamps: [], blocked: 0 }
        buckets.set(ip, bucket)
      }

      // Check block
      if (bucket.blocked && bucket.blocked > now) {
        return false
      }
      bucket.blocked = 0

      // Slide the window
      const windowStart = now - windowMs
      bucket.timestamps = bucket.timestamps.filter(t => t > windowStart)

      if (bucket.timestamps.length >= maxRequests) {
        // Block for 1 window duration
        bucket.blocked = now + windowMs
        return false
      }

      bucket.timestamps.push(now)
      return true
    },

    /** Reset all tracked state */
    reset() {
      buckets.clear()
    },

    /** Current number of tracked IPs */
    get size() {
      return buckets.size
    },
  }
}

module.exports = { createRateLimiter }
