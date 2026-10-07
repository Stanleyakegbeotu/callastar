const SHELL_CACHE = "callastar-shell-v1";
const ASSET_CACHE = "callastar-assets-v1";
const PRECACHE = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/maskable-icon-512x512.png",
  "/branding/callastar-mark.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(PRECACHE);

    // Cache the current hashed JS/CSS entry points as well as the document.
    // That lets the shell start offline without precaching user media or models.
    const response = await fetch("/index.html", { cache: "reload" });
    if (!response.ok) return;
    await shell.put("/index.html", response.clone());
    const html = await response.text();
    const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))(?:\?[^"']*)?["']/g)]
      .map((match) => new URL(match[1], self.location.origin).href)
      .filter((url) => new URL(url).origin === self.location.origin);
    const assetCache = await caches.open(ASSET_CACHE);
    await Promise.all(assets.map(async (url) => {
      try {
        const asset = await fetch(url, { cache: "reload" });
        if (asset.ok) await assetCache.put(url, asset);
      } catch {
        // The shell and manifest are still useful if an optional chunk misses.
      }
    }));

    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith("callastar-") && ![SHELL_CACHE, ASSET_CACHE].includes(name))
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match("/index.html")) || new Response(
          "CallaStar is offline. Reconnect to place or answer calls.",
          { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }
    })());
    return;
  }

  const isBuildAsset = url.pathname.startsWith("/assets/");
  const isBrandAsset = url.pathname.startsWith("/branding/") || /\/(?:favicon\.svg|apple-touch-icon\.png|pwa-\d+\.png|maskable-icon-\d+\.png|manifest\.webmanifest)$/.test(url.pathname);
  if (!isBuildAsset && !isBrandAsset) return;

  event.respondWith((async () => {
    const cacheName = isBuildAsset ? ASSET_CACHE : SHELL_CACHE;
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  })());
});
