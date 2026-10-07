const PUBLIC_CACHE = "callastar-public-v2"
const PUBLIC_ASSETS = ["/favicon.ico", "/favicon.svg"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PUBLIC_CACHE)
      await Promise.all(
        PUBLIC_ASSETS.map(async (path) => {
          try {
            const response = await fetch(path, { cache: "reload" })
            if (response.ok) await cache.put(path, response)
          } catch {
            // Offline install can still activate; public assets may load later.
          }
        }),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter(
            (name) => name.startsWith("callastar-") && name !== PUBLIC_CACHE,
          )
          .map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === "navigate") {
    // Every document navigation must reach Netlify's edge gate, including
    // offline requests. Never serve an application document from a cache.
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response("CallaStar is offline. Reconnect to continue.", {
            status: 503,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            },
          }),
      ),
    )
    return
  }

  // App bundles remain behind the edge gate; cached JS/CSS could bypass it.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(fetch(request))
    return
  }

  if (!PUBLIC_ASSETS.includes(url.pathname)) return
  event.respondWith(
    (async () => {
      const cache = await caches.open(PUBLIC_CACHE)
      const cached = await cache.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) await cache.put(request, response.clone())
      return response
    })(),
  )
})
