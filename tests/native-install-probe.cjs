// Real desktop Chromium diagnostics. No synthetic install events or installation confirmation.
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ORIGIN = 'https://ok-clean.github.io';
const allowedHosts = new Set(['ok-clean.github.io', 'www.gstatic.com', 'fonts.gstatic.com', 'fonts.googleapis.com']);
const safeURL = (value, base = ORIGIN) => { try { const u = new URL(value, base); return u.protocol === 'data:' ? { kind: 'data', mime: value.slice(5, value.indexOf(';')) } : { host: u.host, path: u.pathname }; } catch { return { invalid: true }; } };
const safeError = error => String(error?.message || error).replace(/data:[^\s"']+/g, '[data URI]').replace(/https?:\/\/[^\s"')]+/g, value => { const u = safeURL(value); return u.host + u.path; }).slice(0, 600);
async function timed(promise, label, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function probe(pathname) {
  const result = { target: safeURL(ORIGIN + pathname), network: [], errors: [], snapshots: [], failed: false };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'okclean-native-install-'));
  let context, page;
  const record = (url, status) => { if (result.network.length < 150) result.network.push({ ...safeURL(url), status }); };
  try {
    // newContext() is off-the-record; use an empty normal profile for install diagnostics.
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: false, serviceWorkers: 'allow' });
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (!['GET', 'HEAD'].includes(req.method()) || url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
        record(req.url(), 'blocked'); return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      const path = value => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return null; } };
      const state = window.__nativeInstallProbe = { nativeEvents: [], stages: [], workerReadyAt: null, controllerChanges: [] };
      const sw = navigator.serviceWorker;
      state.capture = async stage => {
        const row = { stage, atMs: Math.round(performance.now()), readyState: document.readyState, visibility: document.visibilityState, workerSupported: !!sw, workerReadyAt: state.workerReadyAt, controller: path(sw?.controller?.scriptURL) };
        state.stages.push(row);
        try { row.registrations = sw ? (await sw.getRegistrations()).map(reg => ({ scope: path(reg.scope), active: path(reg.active?.scriptURL), state: reg.active?.state || null })) : []; }
        catch { row.registrationError = true; }
      };
      window.addEventListener('beforeinstallprompt', event => state.nativeEvents.push({ isTrusted: event.isTrusted, atMs: Math.round(performance.now()) }));
      document.addEventListener('DOMContentLoaded', () => { void state.capture('DOMContentLoaded'); }, { once: true });
      window.addEventListener('load', () => { void state.capture('load'); }, { once: true });
      if (sw) {
        sw.ready.then(() => { state.workerReadyAt = Math.round(performance.now()); }).catch(() => { state.workerReadyError = true; });
        sw.addEventListener('controllerchange', () => state.controllerChanges.push({ atMs: Math.round(performance.now()), controller: path(sw.controller?.scriptURL) }));
      }
    });
    page = await context.newPage();
    page.on('response', response => record(response.url(), response.status()));
    page.on('requestfailed', req => record(req.url(), 'failed'));
    page.on('pageerror', error => { if (result.errors.length < 10) result.errors.push({ phase: 'page', message: safeError(error) }); });
    const cdp = await context.newCDPSession(page);
    result.browserVersion = context.browser()?.version() || (await timed(cdp.send('Browser.getVersion'), 'Browser.getVersion')).product;
    const response = await page.goto(ORIGIN + pathname, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result.navigationStatus = response?.status() || null;
    await page.bringToFront();
    try { await page.locator('h1').first().click({ timeout: 5000 }); result.headingClick = true; }
    catch (error) { result.headingClick = false; result.errors.push({ phase: 'heading-click', message: safeError(error) }); }
    try { await page.waitForLoadState('load', { timeout: 30000 }); }
    catch (error) { result.failed = true; result.errors.push({ phase: 'load', message: safeError(error) }); }
    async function snapshot(stage) {
      const row = { stage };
      try {
        const manifest = await timed(cdp.send('Page.getAppManifest'), 'Page.getAppManifest');
        const raw = manifest.data ? JSON.parse(manifest.data) : manifest.manifest || {};
        row.manifest = { url: safeURL(manifest.url), errors: (manifest.errors || []).map(e => ({ critical: e.critical, message: safeError(e.message), line: e.line, column: e.column })), name: raw.name, id: safeURL(raw.id || raw.start_url || raw.startUrl || '', manifest.url), start: safeURL(raw.start_url || raw.startUrl || '', manifest.url), scope: safeURL(raw.scope || '', manifest.url), display: raw.display, icons: (raw.icons || []).map(icon => ({ source: safeURL(icon.src || icon.url || '', manifest.url), sizes: icon.sizes, type: icon.type, purpose: icon.purpose })) };
      } catch (error) { row.manifestError = safeError(error); }
      try {
        const data = await timed(cdp.send('Page.getInstallabilityErrors'), 'Page.getInstallabilityErrors');
        row.installabilityErrors = (data.installabilityErrors || []).map(e => ({ errorId: e.errorId, arguments: (e.errorArguments || []).map(a => ({ name: a.name, value: safeError(a.value) })) }));
      } catch (error) { row.installabilityProtocolError = safeError(error); }
      try {
        row.browser = await timed(page.evaluate(async stage => {
          const s = window.__nativeInstallProbe; await s.capture(stage);
          return { nativeEvents: s.nativeEvents, stages: s.stages, workerReadyAt: s.workerReadyAt, controllerChanges: s.controllerChanges, workerReadyError: !!s.workerReadyError };
        }, stage), 'worker snapshot');
      } catch (error) { row.workerSnapshotError = safeError(error); }
      result.snapshots.push(row);
      return row;
    }
    await snapshot('after-load');
    await page.waitForTimeout(30000);
    const final = await snapshot('after-30s');
    const worker = final.browser?.stages?.at(-1);
    result.failed ||= result.navigationStatus !== 200 || !!final.manifestError || !!final.installabilityProtocolError || !!final.workerSnapshotError || !!final.manifest?.errors?.some(error => error.critical) || !!final.installabilityErrors?.length || !worker?.workerSupported || final.browser?.workerReadyAt == null || !worker?.registrations?.some(reg => reg.active);
    result.nativeInstallEventObserved = !!final.browser?.nativeEvents?.some(event => event.isTrusted);
  } catch (error) { result.failed = true; result.errors.push({ phase: 'probe', message: safeError(error) }); }
  finally { if (context) await context.close(); fs.rmSync(profile, { recursive: true, force: true }); }
  return result;
}
(async () => {
  const report = { recordedAt: new Date().toISOString(), mode: 'headed desktop Chromium, fresh normal persistent profiles (not incognito), sequential foreground pages; not the user Android WebAPK state', noLoginOrInstallConfirmation: true, probes: [] };
  try {
    for (const pathname of ['/admin/', '/app/']) {
      try { report.probes.push(await probe(pathname)); }
      catch (error) { report.probes.push({ target: safeURL(ORIGIN + pathname), failed: true, error: safeError(error) }); }
    }
    report.browserVersion = report.probes.find(probe => probe.browserVersion)?.browserVersion || null;
  } catch (error) { report.launchError = safeError(error); }
  finally {
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync('test-results/native-installability.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (report.launchError || report.probes.some(probe => probe.failed)) process.exitCode = 1;
  }
})().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
