// Actual desktop Chromium: observe a real install event, click the site's button,
// photograph the browser confirmation, cancel it, then reload/restart the browser.
// This is not an Android WebAPK, icon coexistence, or physical-device installation test.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MODE = process.env.OKCLEAN_NATIVE_TARGET || 'candidate';
assert(['candidate', 'public'].includes(MODE), 'Unknown native probe target');
const PROFILE = process.env.OKCLEAN_NATIVE_PROFILE || 'pages';
assert(['pages', 'admin-hosting'].includes(PROFILE), 'Unknown native probe profile');
if (PROFILE === 'admin-hosting') {
  assert.equal(MODE, 'public', 'Admin Hosting profile verifies an existing public deployment only');
  assert(process.env.OKCLEAN_BASELINE_DIR, 'Admin Hosting requires the generated public bundle as its baseline');
  assert(/^[0-9a-f]{40}$/.test(process.env.OKCLEAN_PROBE_SOURCE_SHA || ''), 'The exact deployed source SHA is required');
  assert.equal(process.env.OKCLEAN_BASELINE_SHA, process.env.OKCLEAN_PROBE_SOURCE_SHA, 'Hosting baseline and deployed source must be the same SHA');
}
const PUBLIC = PROFILE === 'admin-hosting' ? 'https://okclean-admin-app.web.app' : 'https://ok-clean.github.io';
const ORIGIN = MODE === 'public' ? PUBLIC : process.env.OKCLEAN_TEST_ORIGIN || 'http://127.0.0.1:8766';
assert(MODE === 'public' || ['127.0.0.1', 'localhost'].includes(new URL(ORIGIN).hostname), 'Candidate server must be local');
const reference = path.resolve(process.env.OKCLEAN_BASELINE_DIR || '.');
const staticHosts = new Set(['www.gstatic.com', 'fonts.gstatic.com', 'fonts.googleapis.com', 'cdn.jsdelivr.net']);
const assets = PROFILE === 'admin-hosting'
  ? ['install.js', 'install.css', 'admin/index.html', 'admin/admin.js', 'admin/manifest.webmanifest', 'admin/icon-192.png', 'admin/icon-512.png', 'admin/apple-touch-icon.png', 'config.json', 'sw.js', 'robots.txt']
  : ['install.js', 'install.css', 'manifest.webmanifest', 'admin/manifest.webmanifest', 'admin/index.html', 'app/index.html', 'sw.js', 'admin/admin.js'];
const manifestPaths = PROFILE === 'admin-hosting' ? ['admin/manifest.webmanifest'] : ['manifest.webmanifest', 'admin/manifest.webmanifest'];
const apps = [{ key: 'admin', pathname: '/admin/', id: '/admin/' }];
if (PROFILE === 'pages') apps.push({ key: 'customer', pathname: '/app/', id: '/' });
const safeURL = (value, base = ORIGIN) => {
  try { const u = new URL(value, base); return u.protocol === 'data:' ? { kind: 'data', mime: String(value).slice(5, String(value).indexOf(';')) } : { host: u.host, path: u.pathname }; }
  catch { return { invalid: true }; }
};
const safeError = error => String(error?.message || error).replace(/data:[^\s"']+/g, '[data URI]').replace(/https?:\/\/[^\s"')]+/g, value => { const u = safeURL(value); return u.host + u.path; }).slice(0, 600);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function timed(promise, label, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}

async function publicParity(timeoutMs = 15000) {
  const names = new Set(assets);
  for (const name of manifestPaths) {
    const manifest = JSON.parse(fs.readFileSync(path.join(reference, name), 'utf8'));
    for (const icon of manifest.icons || []) {
      const url = new URL(icon.src, PUBLIC + '/' + name);
      if (url.origin === PUBLIC) names.add(url.pathname.slice(1));
    }
  }
  return Promise.all([...names].map(async name => {
    const row = { path: '/' + name, expectedRef: process.env.OKCLEAN_BASELINE_SHA || null };
    try {
      const expected = fs.readFileSync(path.join(reference, name));
      const response = await fetch(PUBLIC + '/' + name, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'Cache-Control': 'no-cache' } });
      const actual = Buffer.from(await response.arrayBuffer());
      Object.assign(row, { status: response.status, expectedBytes: expected.length, actualBytes: actual.length, expectedSha256: hash(expected), actualSha256: hash(actual) });
      row.match = response.status === 200 && row.expectedSha256 === row.actualSha256;
    } catch (error) { row.match = false; row.error = safeError(error); }
    return row;
  }));
}

async function waitForPublicParity() {
  const started = Date.now(), budgetMs = MODE === 'public' ? 90000 : 0;
  const attempts = [];
  let rows = [];
  // Pages deployment runs independently of this push workflow. Wait only for
  // this exact checkout's bytes; do not inspect a stale release as the new one.
  for (let number = 1; number <= (MODE === 'public' ? 10 : 1); number++) {
    const remaining = budgetMs - (Date.now() - started);
    if (number > 1 && remaining <= 0) break;
    rows = await publicParity(MODE === 'public' ? Math.max(1, Math.min(15000, remaining)) : 15000);
    const mismatch = rows.filter(row => !row.match);
    const attempt = { number, elapsedMs: Date.now() - started, matched: rows.length - mismatch.length, total: rows.length,
      failures: mismatch.map(row => ({ path: row.path, status: row.status || null, error: row.error || 'bytes differ from checkout' })) };
    attempts.push(attempt);
    console.log('PUBLIC_PARITY_ATTEMPT ' + JSON.stringify(attempt));
    if (!mismatch.length || MODE !== 'public' || Date.now() - started >= budgetMs) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(10000, budgetMs - (Date.now() - started))));
  }
  return { rows, status: { attemptCount: attempts.length, budgetMs, elapsedMs: Date.now() - started, matched: rows.length > 0 && rows.every(row => row.match), attempts } };
}

async function launch(profile, record) {
  // A normal profile is required; browser.newContext() is off-the-record and can
  // suppress install promotion. No installability bypass or auto-accept flags.
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false, serviceWorkers: 'allow', viewport: { width: 1120, height: 800 } });
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    const staticRead = ['GET', 'HEAD'].includes(req.method()) && (url.origin === new URL(ORIGIN).origin || (url.protocol === 'https:' && staticHosts.has(url.hostname)));
    if (!staticRead) { record(req.url(), 'blocked'); return route.abort(); }
    return route.continue();
  });
  await context.addInitScript(() => {
    const state = window.__nativeInstallProbe = { nativeEvents: [], promptCalls: [], installedEvents: [], observerErrors: [] };
    window.addEventListener('beforeinstallprompt', event => {
      const row = { isTrusted: event.isTrusted, atMs: Math.round(performance.now()) };
      state.nativeEvents.push(row);
      // Pass through the original browser method synchronously, without changing
      // its result, event propagation, eligibility, or default prevention.
      const original = event.prompt;
      try {
        Object.defineProperty(event, 'prompt', { configurable: true, value: function (...args) {
          const call = { atMs: Math.round(performance.now()), eventIsTrusted: event.isTrusted, activeUserGesture: navigator.userActivation?.isActive === true, pending: true };
          state.promptCalls.push(call);
          try {
            const result = original.apply(this, args);
            Promise.resolve(result).then(choice => { call.pending = false; call.outcome = choice?.outcome || null; }, () => { call.pending = false; call.rejected = true; });
            return result;
          } catch (error) { call.pending = false; call.threw = true; throw error; }
        } });
      } catch { state.observerErrors.push('Native prompt observer could not attach'); }
    });
    window.addEventListener('appinstalled', event => state.installedEvents.push({ isTrusted: event.isTrusted, atMs: Math.round(performance.now()) }));
  });
  return context;
}

async function uiState(page) {
  return page.evaluate(() => ({
    native: window.__nativeInstallProbe,
    controller: window.OKCleanInstall?.getState?.() || null,
    buttons: [...document.querySelectorAll('[data-install]')].map(button => ({ state: button.dataset.installState || null, label: button.textContent.trim(), disabled: button.disabled, hidden: button.hidden })),
    helperVisible: !!document.querySelector('#okInstallPanel:not([hidden]), #okInstallDialog[open]'),
    loginVisible: !!document.querySelector('#login:not([hidden])') && !!document.querySelector('#login')?.getClientRects().length,
    path: location.pathname
  }));
}

async function snapshot(context, page, stage) {
  const cdp = await context.newCDPSession(page), row = { stage };
  try {
    const manifest = await timed(cdp.send('Page.getAppManifest'), 'Page.getAppManifest');
    const raw = manifest.data ? JSON.parse(manifest.data) : manifest.manifest || {};
    row.manifest = { url: safeURL(manifest.url), errors: (manifest.errors || []).map(e => ({ critical: e.critical, message: safeError(e.message) })), name: raw.name, id: safeURL(raw.id || raw.start_url || raw.startUrl || '', manifest.url), start: safeURL(raw.start_url || raw.startUrl || '', manifest.url), scope: safeURL(raw.scope || '', manifest.url), display: raw.display, icons: (raw.icons || []).map(icon => ({ source: safeURL(icon.src || icon.url || '', manifest.url), sizes: icon.sizes, type: icon.type, purpose: icon.purpose })) };
    row.installabilityErrors = (await timed(cdp.send('Page.getInstallabilityErrors'), 'Page.getInstallabilityErrors')).installabilityErrors || [];
    row.worker = await page.evaluate(async () => ({ controller: navigator.serviceWorker?.controller?.scriptURL || null, registrations: (await navigator.serviceWorker.getRegistrations()).map(reg => ({ scope: reg.scope, active: reg.active?.scriptURL || null, state: reg.active?.state || null })) }));
    row.ui = await uiState(page);
  } finally { await cdp.detach(); }
  return row;
}

async function openPage(context, pathname, result, record) {
  const page = await context.newPage();
  page.on('response', response => record(response.url(), response.status()));
  page.on('requestfailed', req => record(req.url(), 'failed'));
  page.on('pageerror', error => { if (result.errors.length < 10) result.errors.push({ phase: 'page', message: safeError(error) }); });
  const response = await page.goto(ORIGIN + pathname, { waitUntil: 'load', timeout: 30000 });
  assert.equal(response?.status(), 200, 'Page navigation must succeed');
  await page.bringToFront();
  await page.locator('h1').first().click();
  await timed(page.evaluate(() => navigator.serviceWorker.ready.then(() => true)), 'service worker ready');
  await page.waitForFunction(() => typeof window.OKCleanInstall?.getState === 'function', null, { timeout: 10000 });
  return page;
}

function photograph(name) {
  const file = path.join('test-results', name + '.png');
  // Page.screenshot excludes browser chrome. Capture the X display to retain the
  // genuine Chromium install confirmation for independent visual review.
  execFileSync('import', ['-window', 'root', file], { timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
  assert(fs.statSync(file).size > 0, 'Native browser screenshot must exist');
  return { file, sha256: hash(fs.readFileSync(file)), review: 'manual visual review required; not an Android screenshot' };
}

async function probe(app) {
  const result = { app: app.key, target: safeURL(ORIGIN + app.pathname), network: [], errors: [], snapshots: [], screenshots: [], failed: false, androidDeviceVerified: false };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'okclean-native-install-'));
  const record = (url, status) => { if (result.network.length < 100) result.network.push({ ...safeURL(url), status }); };
  let context;
  try {
    context = await launch(profile, record);
    let page = await openPage(context, app.pathname, result, record);
    const versionSession = await context.newCDPSession(page);
    try { result.browserVersion = context.browser()?.version() || (await timed(versionSession.send('Browser.getVersion'), 'Browser.getVersion')).product; }
    finally { await versionSession.detach(); }
    await page.waitForFunction(() => window.__nativeInstallProbe.nativeEvents.some(event => event.isTrusted), null, { timeout: 30000 });
    const ready = await snapshot(context, page, 'ready-before-native-click');
    result.snapshots.push(ready);
    assert.equal(ready.manifest.id.path, app.id);
    assert.equal(ready.manifest.start.path, app.pathname);
    assert.equal(ready.manifest.scope.path, app.pathname);
    for (const field of ['id', 'start', 'scope']) assert.equal(ready.manifest[field].host, new URL(ORIGIN).host, 'Manifest identity and launch paths must use the verified origin');
    assert(!ready.manifest.errors.some(error => error.critical), 'Manifest has no critical errors');
    assert.equal(ready.installabilityErrors.length, 0, 'Browser reports no installability error');
    assert(ready.worker.registrations.some(reg => reg.state === 'activated'), 'A real active service worker exists');
    assert.equal(ready.ui.controller.state, 'ready', 'Real install event must enable the install action');
    assert(!ready.ui.helperVisible, 'Real-event readiness must not auto-open a second install UI');
    await page.locator('[data-install]').first().click();
    await page.waitForFunction(() => window.__nativeInstallProbe.promptCalls.length === 1, null, { timeout: 5000 });
    const prompting = await uiState(page), call = prompting.native.promptCalls[0];
    assert(call.eventIsTrusted && call.activeUserGesture, 'The original browser prompt must be called from the button user gesture');
    assert(!call.threw && !call.rejected, 'The native prompt call must not fail');
    result.snapshots.push({ stage: 'native-prompt-requested', ui: prompting });
    await page.waitForTimeout(400); // Settle only the browser bubble animation for its photograph.
    result.screenshots.push(photograph('native-install-' + app.key + '-confirmation'));
    execFileSync('xdotool', ['key', '--clearmodifiers', 'Escape'], { timeout: 5000, stdio: ['ignore', 'ignore', 'pipe'] });
    await page.waitForFunction(() => window.__nativeInstallProbe.promptCalls[0]?.outcome === 'dismissed', null, { timeout: 10000 });
    await page.waitForFunction(() => window.OKCleanInstall.getState().state !== 'prompting', null, { timeout: 5000 });
    const cancelled = await uiState(page);
    result.snapshots.push({ stage: 'native-confirmation-cancelled', ui: cancelled });
    assert.equal(cancelled.native.promptCalls.length, 1, 'One user click must consume only one browser event');
    assert.equal(cancelled.native.installedEvents.length, 0, 'Cancelling must not emit installation success');
    assert(!['requested', 'installed-browser', 'prompting'].includes(cancelled.controller.state), 'Cancellation must not leave a success or stuck state');
    assert(!cancelled.buttons[0].disabled, 'Cancellation must restore a usable button');
    result.screenshots.push(photograph('native-install-' + app.key + '-cancelled'));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => { const s = window.OKCleanInstall?.getState?.(); return s && s.state !== 'checking'; }, null, { timeout: 15000 });
    const refreshed = await uiState(page);
    result.snapshots.push({ stage: 'refresh-after-cancellation', ui: refreshed });
    assert(!refreshed.helperVisible, 'Refresh must not auto-open installation help');
    assert(!['requested', 'installed-browser', 'prompting'].includes(refreshed.controller.state), 'Refresh must not restore a false installation state');
    assert.equal(refreshed.native.promptCalls.length, 0, 'Refresh must not call the native prompt automatically');
    await context.close(); context = null;
    context = await launch(profile, record);
    page = await openPage(context, app.pathname, result, record);
    await page.waitForFunction(() => window.OKCleanInstall.getState().state !== 'checking', null, { timeout: 15000 });
    const restarted = await uiState(page);
    result.snapshots.push({ stage: 'browser-restart-after-cancellation', ui: restarted });
    assert(!restarted.helperVisible, 'Browser restart must not auto-open installation help');
    assert(!['requested', 'installed-browser', 'prompting'].includes(restarted.controller.state), 'Browser restart must not restore a false installation state');
    assert.equal(restarted.native.promptCalls.length, 0, 'Browser restart must not prompt without a user click');
    if (app.key === 'admin') assert(restarted.loginVisible, 'Installation state must not block the administrator login screen');
    result.nativeInstallEventObserved = true;
    result.nativePromptCalledFromSiteButton = true;
    result.nativeCancellationObserved = true;
    result.installConfirmationAccepted = false;
  } catch (error) { result.failed = true; result.errors.push({ phase: 'probe', message: safeError(error) }); }
  finally { if (context) await context.close(); fs.rmSync(profile, { recursive: true, force: true }); }
  return result;
}

(async () => {
  fs.mkdirSync('test-results', { recursive: true });
  const report = { recordedAt: new Date().toISOString(), targetMode: MODE, targetProfile: PROFILE, expectedPublicOrigin: PUBLIC, checkedSourceSha: process.env.OKCLEAN_PROBE_SOURCE_SHA || null, probeCodeSha: process.env.OKCLEAN_PROBE_CODE_SHA || null, mode: 'headed desktop Chromium, fresh normal persistent profiles; actual native event and cancellation; no Android device or existing customer WebAPK', noLoginOrFormSubmission: true, noInstallConfirmationAccepted: true, publicAssets: [], probes: [] };
  try {
    const parity = await waitForPublicParity();
    report.publicAssets = parity.rows;
    report.publicParity = parity.status;
    if (MODE === 'public' && !parity.status.matched) throw new Error('Public assets did not match this checkout within the bounded deployment wait; browser checks were not run against a different release');
    for (const app of apps) report.probes.push(await probe(app));
  } catch (error) { report.error = safeError(error); }
  finally {
    report.failed = !!report.error || report.publicAssets.some(row => !row.match) || report.probes.length !== apps.length || report.probes.some(row => row.failed);
    fs.writeFileSync('test-results/native-installability.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (report.failed) process.exitCode = 1;
  }
})().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
