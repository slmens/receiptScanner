/**
 * Receipt Vault — Service Worker
 * Caches the app shell for offline access.
 * API calls are network-first (never cached).
 */

const CACHE_NAME = 'vault-shell-v1'

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/config.js',
  '/manifest.json',
]

// ── Install: cache the app shell ──────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

// ── Activate: clean up old caches ─────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

// ── Fetch: network-first for API, cache-first for shell ───────────────────────

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // Never cache API calls, auth, or cross-origin resources
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.origin !== self.location.origin
  ) {
    event.respondWith(fetch(event.request))
    return
  }

  // Cache-first for shell assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached

      return fetch(event.request).then(response => {
        // Cache successful GET responses for shell assets
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return response
      })
    }),
  )
})
