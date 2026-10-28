const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');

// A local fixture serves the site's code but removes backend configuration and external fonts.
let home = fs.readFileSync('index.html', 'utf8');
home = home.replace(/<link rel="stylesheet" href="https:\/\/[^\"]+">/g, '');
home = home.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_, start, raw, end) => {
  const cfg = JSON.parse(raw);
  cfg.firebase = null;
  cfg.memberBackendUrl = '';
  cfg.blog = [];
  return start + JSON.stringify(cfg).replace(/<\//g, '<\\/') + end;
});
const scripts = Object.fromEntries(['sw.js', 'app.js', 'site.js', 'style.css'].map(name => [name, fs.readFileSync(name, 'utf8')]));
let networkDown = false;
const server = http.createServer((req, res) => {
  // Playwright's page offline emulation may not apply to the service worker's
  // own network fetch. Force an actual connection failure for both contexts.
  if(networkDown) { req.socket.destroy(); return; }
  let path = new URL(req.url, 'http://127.0.0.1').pathname;
  if(path.startsWith('/subpath/')) path = path.slice('/subpath'.length);
  if(path === '/' || path === '/index.html') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(home); }
  if(path === '/bootstrap') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end('<!doctype html><title>시험 준비</title>'); }
  if(path === '/area/cached.html' || path === '/services/cached.html') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    return res.end('<!doctype html><title>저장된 상세페이지</title><p>가상 상세 내용</p>');
  }
  if(path === '/cases.json') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end('{"cases":[]}'); }
  if(path === '/fixture-data.json') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end('{"example":true}'); }
  const file = path.slice(1);
  if(Object.hasOwn(scripts, file)) { res.writeHead(200, {'Content-Type':file.endsWith('.css') ? 'text/css' : 'application/javascript'}); return res.end(scripts[file]); }
  if(path === '/fixture-500') { res.writeHead(500); return res.end('temporary error'); }
  res.writeHead(404); return res.end('not found');
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844}, {width:1440,height:900}]) {
      const context = await browser.newContext({viewport});
      await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await context.addInitScript(() => { if(location.hostname === '127.0.0.1') localStorage.setItem('joinLater', JSON.stringify(Date.now())); });
      const page = await context.newPage();
      await page.goto(base + '/index.html', {waitUntil:'load'});
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.reload({waitUntil:'load'});
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      for(const path of ['/area/cached.html', '/services/cached.html']) {
        await page.goto(base + path, {waitUntil:'load'});
        assert.equal(await page.title(), '저장된 상세페이지');
      }
      await page.goto(base + '/index.html', {waitUntil:'load'});
      assert.deepEqual(await page.evaluate(async () => {
        const result = await Promise.all(['/app.js','/style.css','/fixture-data.json','/fixture-500','/not-found'].map(x => fetch(x)));
        return result.map(r => r.status);
      }), [200, 200, 200, 500, 404]);
      await page.waitForFunction(async () => {
        const c = await caches.open('okclean-v1');
        return (await Promise.all(['/index.html','/site.js','/app.js','/style.css','/fixture-data.json','/area/cached.html','/services/cached.html'].map(x => c.match(x)))).every(Boolean);
      });
      assert.equal(await page.evaluate(async () => !!(await caches.match('/index.html?area=%EC%B6%98%EC%B2%9C'))), false);
      assert.deepEqual(await page.evaluate(async () => Promise.all(
        ['/uncached.js','/uncached.css','/uncached.json','/uncached-script.js','/area/uncached.html','/services/uncached.html','/?area=%EC%B6%98%EC%B2%9C'].map(async path => !!(await caches.match(path)))
      )), [false, false, false, false, false, false, false]);
      networkDown = true;
      await context.setOffline(true);
      const response = await page.goto(base + '/index.html?area=' + encodeURIComponent('춘천') + '#quote', {waitUntil:'domcontentloaded'});
      assert.equal(response.status(), 200);
      assert.equal(await page.locator('#qArea').inputValue(), '춘천');
      assert.equal(await page.evaluate(() => !!navigator.serviceWorker.controller), true);
      const root = await page.goto(base + '/?area=' + encodeURIComponent('춘천') + '#quote', {waitUntil:'domcontentloaded'});
      assert.equal(root.status(), 200);
      assert.equal(await page.locator('#qArea').inputValue(), '춘천');
      assert.deepEqual(await page.evaluate(async () => {
        const js = await fetch('/app.js');
        const data = await fetch('/fixture-data.json');
        const failed = await Promise.all(['/uncached.js','/uncached.css','/uncached.json'].map(async path => {
          try { await fetch(path); return false; } catch(_) { return true; }
        }));
        const scriptError = await new Promise(resolve => {
          const script = document.createElement('script'); script.src = '/uncached-script.js';
          script.onload = () => resolve(false); script.onerror = () => resolve(true); document.body.append(script);
        });
        return [js.status, js.headers.get('content-type'), await data.json(), ...failed, scriptError];
      }), [200, 'application/javascript', {example:true}, true, true, true, true]);

      // Cached detail documents still work; uncached nested navigations must fail.
      for(const path of ['/area/cached.html', '/services/cached.html']) {
        const cached = await page.goto(base + path, {waitUntil:'load'});
        assert.equal(cached.status(), 200);
        assert.equal(await page.title(), '저장된 상세페이지');
      }
      for(const path of ['/area/uncached.html?area=춘천#quote', '/services/uncached.html#quote']) {
        await assert.rejects(page.goto(base + path, {waitUntil:'domcontentloaded'}));
      }
      await context.close();

      // With no cached /index.html the existing document fallback cannot work.
      networkDown = false;
      const cold = await browser.newContext({viewport});
      await cold.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const coldPage = await cold.newPage();
      await coldPage.goto(base + '/bootstrap');
      await coldPage.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
      await coldPage.reload();
      await coldPage.waitForFunction(() => !!navigator.serviceWorker.controller);
      assert.equal(await coldPage.evaluate(async () => !!(await caches.match('/index.html'))), false);
      networkDown = true;
      await cold.setOffline(true);
      await assert.rejects(coldPage.goto(base + '/index.html?area=' + encodeURIComponent('춘천'), {waitUntil:'domcontentloaded'}));
      await cold.close();
      networkDown = false;

      // Also exercise a worker installed below a non-root scope.
      const sub = await browser.newContext({viewport});
      await sub.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await sub.addInitScript(() => { if(location.hostname === '127.0.0.1') localStorage.setItem('joinLater', JSON.stringify(Date.now())); });
      const subPage = await sub.newPage();
      await subPage.goto(base + '/subpath/index.html', {waitUntil:'load'});
      await subPage.evaluate(() => navigator.serviceWorker.ready);
      await subPage.reload({waitUntil:'load'});
      await subPage.waitForFunction(() => !!navigator.serviceWorker.controller);
      await subPage.goto(base + '/subpath/services/cached.html', {waitUntil:'load'});
      await subPage.goto(base + '/subpath/index.html', {waitUntil:'load'});
      await subPage.waitForFunction(async () => {
        const c = await caches.open('okclean-v1');
        return (await Promise.all(['/subpath/index.html','/subpath/app.js','/subpath/site.js','/subpath/style.css','/subpath/services/cached.html'].map(x => c.match(x)))).every(Boolean);
      });
      assert.equal(await subPage.evaluate(async () => !!(await caches.match('/subpath/?area=%EC%B6%98%EC%B2%9C'))), false);
      networkDown = true;
      await sub.setOffline(true);
      const subRoot = await subPage.goto(base + '/subpath/?area=' + encodeURIComponent('춘천') + '#quote', {waitUntil:'domcontentloaded'});
      assert.equal(subRoot.status(), 200);
      assert.equal(await subPage.locator('#qArea').inputValue(), '춘천');
      const subCached = await subPage.goto(base + '/subpath/services/cached.html', {waitUntil:'load'});
      assert.equal(subCached.status(), 200);
      assert.equal(await subPage.title(), '저장된 상세페이지');
      await assert.rejects(subPage.goto(base + '/subpath/area/uncached.html', {waitUntil:'domcontentloaded'}));
      await sub.close();
      networkDown = false;
      console.log('offline PASS ' + viewport.width);
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
