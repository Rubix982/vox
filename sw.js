/* Cross-origin isolation for hosts that can't set headers (GitHub Pages).

   Multithreaded WASM needs SharedArrayBuffer, which browsers only expose to a
   page served with COOP: same-origin and COEP: require-corp. This worker
   re-serves every same-origin response with those two headers added, which is
   all the isolation check looks at. Cross-origin requests (the model hosts)
   pass straight through untouched; they are CORS fetches, which COEP allows.

   It caches nothing and changes no response body. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (new URL(req.url).origin !== self.location.origin) return;
  // Chrome throws on this combination; it only comes from DevTools.
  if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

  e.respondWith((async () => {
    const res = await fetch(req);
    if (res.status === 0) return res;   // opaque: nothing to rewrite
    const headers = new Headers(res.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  })());
});
