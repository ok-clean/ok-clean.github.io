// 홈 화면 앱용 서비스 워커: 항상 최신 내용을 먼저 받고, 인터넷이 끊겼을 때만 저장본을 보여줌
// 이전 버전의 회원 수집 코드 및 URL 캐시를 최신 서비스 워커가 활성화될 때 비웁니다.
const CACHE = "okclean-v2";
const CACHE_PREFIX = "okclean-";
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(CACHE_PREFIX) && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if(req.method !== "GET" || url.origin !== location.origin) return;
  // 쿼리에는 추천 코드나 이용자 입력이 들어갈 수 있으므로 캐시에 보관하지 않습니다.
  const hasQuery = url.search !== "";
  const network = fetch(req);
  // 응답은 바로 전달하되 캐시 저장이 끝날 때까지 작업자를 유지합니다.
  // 저장 공간 부족 등 캐시 실패는 성공한 네트워크 응답을 바꾸지 않습니다.
  e.waitUntil(network.then(res => {
    if(res.ok && !hasQuery){
      const copy = res.clone();
      return caches.open(CACHE).then(c => c.put(req, copy));
    }
  }).catch(() => {}));
  e.respondWith(
    network.catch(() => caches.open(CACHE).then(cache => cache.match(req).then(r => {
      if(r) return r;
      // 홈 문서를 하위 URL에 반환하면 상대 경로가 바뀌어 화면이 깨집니다.
      const path = new URL(req.url).pathname;
      const scope = new URL(self.registration.scope);
      const home = path === scope.pathname || path === new URL("index.html", scope).pathname;
      return req.mode === "navigate" && home ? cache.match(new URL("index.html", scope).href) : null;
    })).then(r => r || Response.error()))
  );
});

