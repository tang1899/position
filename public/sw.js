const CACHE_NAME = 'quanzhou-monitor-pwa-v1'
const SCOPE = self.registration.scope
const SHELL_URLS = [
  SCOPE,
  new URL('index.html', SCOPE).href,
  new URL('manifest.webmanifest', SCOPE).href,
  new URL('icons/icon-192.png', SCOPE).href,
  new URL('icons/icon-512.png', SCOPE).href,
  new URL('icons/apple-touch-icon.png', SCOPE).href,
  new URL('favicon.ico', SCOPE).href,
]

async function cacheResponse(cache, url, response) {
  if (response?.ok) await cache.put(url, response.clone())
}

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME)
  await Promise.all(
    SHELL_URLS.map(async (url) => {
      try {
        const response = await fetch(url, { cache: 'no-cache' })
        await cacheResponse(cache, url, response)
      } catch {
        // A missing optional shell asset should not block installation.
      }
    }),
  )

  try {
    const indexUrl = new URL('index.html', SCOPE).href
    const response = await fetch(indexUrl, { cache: 'no-cache' })
    if (!response.ok) return
    await cacheResponse(cache, indexUrl, response)
    const html = await response.text()
    const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => new URL(match[1], SCOPE))
      .filter((url) => url.origin === self.location.origin)
      .map((url) => url.href)
    await Promise.all(
      [...new Set(assetUrls)].map(async (url) => {
        if (SHELL_URLS.includes(url)) return
        try {
          const assetResponse = await fetch(url, { cache: 'no-cache' })
          await cacheResponse(cache, url, assetResponse)
        } catch {
          // Runtime caching will retry assets when the page is opened.
        }
      }),
    )
  } catch {
    // The app shell remains usable once network access is restored.
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          const cache = await caches.open(CACHE_NAME)
          await cacheResponse(cache, request, response)
          return response
        })
        .catch(async () => {
          const cached = await caches.match(request)
          return cached || caches.match(new URL('index.html', SCOPE).href)
        }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached
      try {
        const response = await fetch(request)
        const cache = await caches.open(CACHE_NAME)
        await cacheResponse(cache, request, response)
        return response
      } catch {
        return cached
      }
    }),
  )
})
