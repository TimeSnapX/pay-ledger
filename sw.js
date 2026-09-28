/*
 * Pay Ledger service worker: makes the app installable (WebAPK) and lets it
 * open offline. Deliberately small:
 * - Only same-origin GET requests inside this scope are handled. Everything
 *   else (Google sign-in, accounts.google.com, *.googleapis.com, Drive API,
 *   fonts, any POST/PUT/PATCH) is never intercepted and never cached; the
 *   browser handles it exactly as if there were no service worker.
 * - Network first for everything it handles, so online behaviour is unchanged;
 *   the cache is only a fallback when the network fails (offline).
 * - Never touches IndexedDB (your ledger data lives there).
 * Bump VERSION to drop old caches.
 */
const VERSION = "v1";
const CACHE = `pay-ledger-${VERSION}`;
const SCOPE = new URL(self.registration.scope);

// App shell fetched on install so the app can open offline straight away.
// Missing files are skipped (install never fails because of one of them).
const SHELL = [
  "./",
  "index.html",
  "add-shifts.html",
  "manifest.webmanifest",
  "favicon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "css/app.css?v=4",
  "js/app.js?v=4",
  "js/db.js?v=4",
  "js/money.js?v=4",
  "js/migrate.js?v=4",
  "js/exporters.js?v=4",
  "js/share.js?v=4",
  "js/transfer.js?v=4",
  "js/drive-config.js?v=4",
  "js/drive-sync.js?v=4",
];

const NEVER = /(^|\.)google\.com$|(^|\.)googleapis\.com$|(^|\.)gstatic\.com$|(^|\.)googleusercontent\.com$/;

function handled(request) {
  if (request.method !== "GET") return false;
  if (request.headers.has("range")) return false;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return false;
  if (NEVER.test(url.hostname)) return false;
  if (!url.pathname.startsWith(SCOPE.pathname)) return false;
  if (url.pathname === `${SCOPE.pathname}sw.js`) return false;
  return true;
}

function isPage(request) {
  return request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html");
}

// Pages are stored without their query string (e.g. ?chronaAdd=...), so the
// cache keeps one copy per page.
function cacheKey(request) {
  const url = new URL(request.url);
  url.hash = "";
  if (isPage(request)) url.search = "";
  return url.href;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        SHELL.map((path) =>
          fetch(new Request(new URL(path, SCOPE).href, { cache: "reload" }))
            .then((res) => (res.ok ? cache.put(new URL(path, SCOPE).href, res) : null))
            .catch(() => null),
        ),
      ),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("pay-ledger-") && k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!handled(request)) return; // not ours: browser does the normal network request
  const key = cacheKey(request);
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(key, copy)).catch(() => {}));
        }
        return res;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        const hit = (await cache.match(key)) || (await cache.match(request.url, { ignoreSearch: isPage(request) }));
        if (hit) return hit;
        if (isPage(request)) {
          const shell = (await cache.match(SCOPE.href)) || (await cache.match(new URL("index.html", SCOPE).href));
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
