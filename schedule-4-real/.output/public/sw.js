// Schedule 4 Real — Asset Cache Service Worker
// Cache-first strategy: assets cached on first fetch, served from cache thereafter.

const CACHE_NAME = 'spider-assets-v3'

// ─── Lifecycle ────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_NAME)
        .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  )
})

// ─── Fetch Interception ──────────────────────────────────────────────────────

function isCacheablePath(pathname) {
  if (pathname === '/' || pathname === '/sw.js') return false
  if (pathname.startsWith('/api/')) return false
  if (pathname.startsWith('/_nuxt/')) return false
  if (pathname.startsWith('/__')) return false

  // Allow .json under /defaults/
  if (pathname.startsWith('/defaults/') && pathname.endsWith('.json')) return true

  // Skip code/config extensions
  const dot = pathname.lastIndexOf('.')
  if (dot !== -1) {
    const ext = pathname.substring(dot + 1).toLowerCase()
    if (['json', 'js', 'mjs', 'cjs', 'css', 'html', 'htm', 'map'].includes(ext)) return false
  }

  return true
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  if (isCacheablePath(url.pathname)) {
    event.respondWith(cacheFirst(event.request))
  }
})

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)

  // Use URL-only matching (ignore headers like Range, Vary, etc.)
  const cacheKey = new Request(request.url)
  const cached = await cache.match(cacheKey, { ignoreVary: true })
  if (cached) return cached

  try {
    // Always fetch full resource (strip Range header) so we can cache the complete response
    const response = await fetch(new Request(request.url))

    // Only cache complete 200 responses that weren't redirected
    if (response.status === 200 && !response.redirected) {
      try {
        await cache.put(cacheKey, response.clone())
      } catch (e) {
        // Cache storage full or other error — continue without caching
      }
    }

    return response
  } catch (err) {
    return new Response('Asset not available offline', { status: 503 })
  }
}

// ─── Message Handler ─────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  if (!event.data || !event.data.type) return

  if (event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      if (event.source) {
        event.source.postMessage({ type: 'CACHE_CLEARED' })
      }
    })
  }

  // Invalidate specific URLs whose files changed on the server
  if (event.data.type === 'INVALIDATE_FILES') {
    const urls = event.data.urls // string[]
    if (!Array.isArray(urls) || urls.length === 0) return
    caches.open(CACHE_NAME).then(async (cache) => {
      let evicted = 0
      for (const urlPath of urls) {
        const fullUrl = new URL(urlPath, self.location.origin).href
        const deleted = await cache.delete(new Request(fullUrl), { ignoreVary: true })
        if (deleted) evicted++
      }
      if (evicted > 0 && event.source) {
        event.source.postMessage({ type: 'FILES_INVALIDATED', count: evicted })
      }
    })
  }
})
