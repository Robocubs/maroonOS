const CACHE_NAME = 'maroonos-media-v1';
const MEDIA_RE = /^\/static\/(images|videos)\//;

self.addEventListener('install', e => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', event => {
    if (!MEDIA_RE.test(new URL(event.request.url).pathname)) return;

    // Use the URL string (not the Request object) as the cache key so that
    // mode/credentials differences between fetch() and <img src> loads never
    // cause a cache miss.
    // Decode percent-encoding (e.g. %28 → '(') so the cache key always matches
    // the normalized form Chrome uses for event.request.url on image loads.
    const url = decodeURI(event.request.url);
    event.respondWith(
        caches.open(CACHE_NAME).then(cache =>
            cache.match(url, {ignoreVary: true}).then(cached => {
                if (cached) return cached;
                // 'force-cache' tells the browser to return a 200 with body from its
                // HTTP cache rather than a body-less 304, which cannot be stored in
                // the SW cache.
                return fetch(new Request(url, {cache: 'force-cache'})).then(response => {
                    if (response.ok) cache.put(url, response.clone());
                    return response;
                });
            })
        )
    );
});
