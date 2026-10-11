const CACHE = "din8sty-v26";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [
  OFFLINE_URL,
  "/styles.css",
  "/theme.js",
  "/i18n.js",
  "/auth.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isApi(url) {
  return sameOrigin(url) && url.pathname.startsWith("/api/");
}

function isStatic(url) {
  if (!sameOrigin(url)) return false;
  if (url.pathname === "/sw.js" || url.pathname === "/sw-register.js") return false;
  if (url.pathname === "/manifest.webmanifest") return false;
  return (
    url.pathname.startsWith("/logos/") ||
    url.pathname.startsWith("/icons/") ||
    /\.(?:css|js|png|jpg|jpeg|webp|svg|woff2|ico)$/i.test(url.pathname)
  );
}

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    return fresh;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    throw new Error("offline");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  if (isApi(url)) {
    event.respondWith(fetch(req));
    return;
  }

  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(networkFirst(req));
    return;
  }

  if (isStatic(url)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});
