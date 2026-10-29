// 홈 화면 앱용 서비스 워커: 항상 최신 내용을 먼저 받고, 인터넷이 끊겼을 때만 저장본을 보여줌
const CACHE = "okclean-v1";
const CACHE_PREFIX = "okclean-";
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if(req.method !== "GET" || url.origin !== location.origin) return;
  // 사례 목록은 요청마다 시각이 달라 매번 새로운 캐시 항목이 생깁니다.
  const timestampedCases = req.mode !== "navigate" &&
    url.pathname === new URL("cases.json", self.registration.scope).pathname && /^\?t=[0-9]+$/.test(url.search);
  e.respondWith(
    fetch(req).then(res => {
      if(res.ok && !timestampedCases){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.open(CACHE).then(cache => cache.match(req).then(r => {
      if(r) return r;
      // 홈 문서를 하위 URL에 반환하면 상대 경로가 바뀌어 화면이 깨집니다.
      const path = new URL(req.url).pathname;
      const scope = new URL(self.registration.scope);
      const home = path === scope.pathname || path === new URL("index.html", scope).pathname;
      return req.mode === "navigate" && home ? cache.match(new URL("index.html", scope).href) : null;
    })).then(r => r || Response.error()))
  );
});
