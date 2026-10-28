// 홈 화면 앱용 서비스 워커: 항상 최신 내용을 먼저 받고, 인터넷이 끊겼을 때만 저장본을 보여줌
const CACHE = "okclean-v1";
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const req = e.request;
  if(req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => {
      if(r) return r;
      // 홈 문서를 하위 URL에 반환하면 상대 경로가 바뀌어 화면이 깨집니다.
      const path = new URL(req.url).pathname;
      const scope = new URL(self.registration.scope);
      const home = path === scope.pathname || path === new URL("index.html", scope).pathname;
      return req.mode === "navigate" && home ? caches.match("./index.html") : null;
    }).then(r => r || Response.error()))
  );
});
