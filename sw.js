// 두 앱의 캐시는 URL별로 저장합니다. 관리자 요청에 고객 홈페이지를 대신 반환하지 않습니다.
const CACHE = 'okclean-public-v2';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(key => key === 'okclean-v1')
    .map(key => caches.delete(key)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  const network = fetch(request);
  // Keep the cache write alive without delaying the network response or returning a stale copy.
  event.waitUntil(network.then(response => {
    if (response.ok) {
      const copy = response.clone();
      return caches.open(CACHE).then(cache => cache.put(request, copy));
    }
  }).catch(() => {}));
  event.respondWith(network.catch(async () => {
    const cache = await caches.open(CACHE);
    const exact = await cache.match(request);
    if (exact) return exact;
    // A missing administrator page or script must never become the customer index HTML.
    return new Response('인터넷 연결을 확인한 뒤 다시 열어 주세요.', {
      status: 503,
      headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'}
    });
  }));
});
