const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const net = require('node:net');
(async () => {
  const server = spawn("python3", ["-m", "http.server", "8765", "--bind", "127.0.0.1"]);
  await new Promise((resolve, reject) => { let attempts = 0; function probe() { const s = net.connect(8765, "127.0.0.1"); s.on("connect", () => {s.destroy(); resolve();}); s.on("error", () => {if (++attempts > 100) reject(new Error("server did not start")); else setTimeout(probe, 50);}); } probe(); });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({viewport: {width: 390, height: 844}});
    await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:8765/', {waitUntil: 'domcontentloaded'});
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(() => fetch('/app.js'));
    await page.waitForFunction(async () => !!(await caches.match('/app.js')));
    server.kill();
    await new Promise(resolve => server.once("exit", resolve));
    await context.setOffline(true);
    const result = await page.evaluate(async () => {
      const cached = await fetch('/app.js');
      let missingFailed = false;
      try { await fetch('/not-cached.js'); } catch (_) { missingFailed = true; }
      return {cachedOk: cached.ok, cachedType: cached.headers.get('content-type'), missingFailed};
    });
    assert.equal(result.cachedOk, true);
    assert.match(result.cachedType, /javascript/);
    assert.equal(result.missingFailed, true);
    await page.goto('http://127.0.0.1:8765/', {waitUntil:'domcontentloaded'});
    assert.match(await page.title(), /오케이청소/);
    console.log('PASS offline cached page, cached script and missing script');
    await context.close();
  } finally { server.kill(); await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
