// UI and controller regression tests. Native install events and device signals are
// fixtures: these checks do not claim Android/iPhone installation success.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = process.env.OKCLEAN_TEST_ORIGIN || 'http://127.0.0.1:8765';
assert(['127.0.0.1', 'localhost'].includes(new URL(ORIGIN).hostname), 'Tests must use a local fixture server');
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const APPS = [
  { key: 'customer', path: '/', installPath: '/app/', identity: '/', manifestPath: '/manifest.webmanifest', name: '오케이청소' },
  { key: 'admin', path: '/admin/', installPath: '/admin/', identity: '/admin/', manifestPath: '/admin/manifest.webmanifest', name: '오케이청소 관리자' }
];
const DIALOG = '#okInstallDialog';
const ACTION = name => `[data-install-action="${name}"]`;
let browser;
let passed = 0;

function pass(message) {
  passed++;
  console.log('PASS:', message);
}

async function fixture(app, { width = 390, ua = ANDROID, query = '', standalone = false, iosStandalone = false, copyFails = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 820 }, userAgent: ua,
    isMobile: true, hasTouch: true, serviceWorkers: 'block'
  });
  await context.route('**/*', route => {
    // No Firebase auth/data, analytics, or other real external services in tests.
    const url = new URL(route.request().url());
    return url.origin === new URL(ORIGIN).origin ? route.continue() : route.abort();
  });
  await context.addInitScript(({ standalone, iosStandalone, copyFails }) => {
    // Keep the no-event scenarios deterministic on install-capable CI browsers.
    window.addEventListener('beforeinstallprompt', event => {
      if (event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    if (standalone) {
      const original = window.matchMedia.bind(window);
      window.matchMedia = query => {
        if (query === '(display-mode: standalone)') {
          return { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
        }
        return original(query);
      };
    }
    if (iosStandalone) {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    }
    if (copyFails) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async () => { throw new Error('fixture clipboard denied'); } }
      });
      document.execCommand = () => false;
    }
  }, { standalone, iosStandalone, copyFails });
  const page = await context.newPage();
  const responses = new Map();
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === new URL(ORIGIN).origin) responses.set(url.pathname, response.status());
  });
  await page.goto(ORIGIN + app.path + query, { waitUntil: 'load' });
  await page.locator('[data-install]').first().waitFor({ state: 'visible' });
  return { context, page, responses };
}

async function emitPrompt(page, outcome = 'accepted', error = false) {
  await page.evaluate(({ outcome, error }) => {
    const state = window.installFixture = { calls: 0, activation: [], prevented: false };
    const event = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(event, {
      prompt() {
        state.calls++;
        state.activation.push(navigator.userActivation?.isActive === true);
        if (state.calls > 1) throw new Error('An install event was reused');
        if (error) throw new Error('fixture prompt unavailable');
        return Promise.resolve({ outcome });
      },
      userChoice: Promise.resolve({ outcome })
    });
    window.dispatchEvent(event);
    state.prevented = event.defaultPrevented;
  }, { outcome, error });
}

async function closeDialog(page) {
  if (await page.locator(DIALOG).isVisible()) {
    await page.locator(`${DIALOG} ${ACTION('close')}`).first().click();
    await page.locator(DIALOG).waitFor({ state: 'hidden' });
  }
}

async function assertNativeCalls(page, count) {
  await page.waitForFunction(expected => window.installFixture.calls === expected, count);
  const state = await page.evaluate(() => window.installFixture);
  assert.equal(state.calls, count);
  assert.equal(state.prevented, true, 'The browser event must be retained for the explicit install action');
}

async function assertChromeHandoff(page, app) {
  const chrome = page.locator(`${DIALOG} ${ACTION('chrome')}`);
  await chrome.waitFor({ state: 'visible' });
  const href = await chrome.getAttribute('href');
  assert(href.startsWith(`intent://${new URL(ORIGIN).host}${app.installPath}?`), 'Chrome handoff must preserve the correct app installation path');
  assert(href.includes('package=com.android.chrome;'));
  assert(href.includes('install=1'));
  const fallbackValue = href.match(/S\.browser_fallback_url=([^;]+);/);
  assert(fallbackValue, 'A blocked/unavailable Chrome handoff needs a fallback');
  const fallback = new URL(decodeURIComponent(fallbackValue[1]));
  assert.equal(fallback.pathname, app.installPath);
  assert.equal(fallback.searchParams.get('install'), '1');
  assert.equal(fallback.searchParams.get('install_fallback'), '1');
  return href;
}

async function assertNoInstallClaimFromMode(page) {
  assert.doesNotMatch(await page.locator('[data-install]').first().innerText(), /앱 사용 중|설치 완료/, 'Display mode must not identify the currently installed app');
  assert.equal(await page.locator(`${DIALOG} .ok-install-success`).count(), 0, 'Standalone alone must not produce an installation success screen');
}

async function checkInitialHelp(app, width) {
  const { context, page } = await fixture(app, { width });
  try {
    assert(!(await page.locator(DIALOG).isVisible()), 'A normal visit must not auto-open the installer');
    await page.locator('[data-install]').first().click();
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.match(await page.locator(DIALOG).innerText(), new RegExp(app.name));
    await assertChromeHandoff(page, app);
    assert.equal(page.url(), ORIGIN + app.path, 'Opening help must not launch a browser or navigate');
    const layout = await page.locator(DIALOG).evaluate(element => {
      const rect = element.getBoundingClientRect();
      const action = element.querySelector('[data-install-action="chrome"]').getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: innerWidth,
        width: element.clientWidth, contentWidth: element.scrollWidth, tapHeight: action.height };
    });
    assert(layout.left >= -1 && layout.right <= layout.viewport + 1, 'Install dialog must fit the phone width');
    assert(layout.contentWidth <= layout.width + 1, 'Install help must not scroll horizontally');
    assert(layout.tapHeight >= 44, 'Primary action must have a usable touch target');
    if (width === 390) {
      fs.mkdirSync('test-results', { recursive: true });
      await page.screenshot({ path: path.join('test-results', `install-${app.key}-390.png`), animations: 'disabled' });
    }
    await page.keyboard.press('Escape');
    await page.locator(DIALOG).waitFor({ state: 'hidden' });
    assert(await page.locator('[data-install]').first().evaluate(element => element === document.activeElement), 'Closing help must restore keyboard focus');
    pass(`${app.key}: compact Android help, app-specific intent and focus at ${width}px`);
  } finally { await context.close(); }
}

async function checkReturnedAndReady(app, standalone = false) {
  const { context, page } = await fixture(app, { query: '?install=1&ref=fixture', standalone });
  try {
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).searchParams.get('install'), null, 'The handoff marker must be consumed');
    assert.equal(new URL(page.url()).searchParams.get('ref'), 'fixture', 'Unrelated URL parameters must be retained');
    if (standalone) {
      // A return marker does not prove that the browser handoff escaped an
      // installed PWA. Keep an explicit recovery action without auto-launching.
      await assertChromeHandoff(page, app);
      await assertNoInstallClaimFromMode(page);
      assert.equal(new URL(page.url()).pathname, app.path, 'Returned standalone help must not navigate automatically');
    } else {
      assert.equal(await page.locator(`${DIALOG} ${ACTION('chrome')}`).count(), 0, 'A returned browser page must not loop into Chrome again');
    }
    assert.equal(await page.locator(`${DIALOG} ${ACTION('install')}`).count(), 0, 'No ready event means no pretend native-install action');
    await emitPrompt(page);
    assert.equal(await page.evaluate(() => window.installFixture.calls), 0, 'A late event must not auto-prompt');
    await page.locator(`${DIALOG} ${ACTION('install')}`).waitFor({ state: 'visible' });
    await page.locator(`${DIALOG} ${ACTION('install')}`).click();
    await assertNativeCalls(page, 1);
    assert.deepEqual(await page.evaluate(() => window.installFixture.activation), [true], 'Native prompt must be requested within a user gesture');
    await page.waitForFunction(() => document.querySelector('#okInstallDialog')?.innerText.includes('설치를 시작'));
    assert(await page.locator('[data-install]').first().isVisible(), 'Install/help action must remain available after acceptance');
    await closeDialog(page);
    await page.locator('[data-install]').first().click();
    assert.equal(await page.evaluate(() => window.installFixture.calls), 1, 'Consumed events must not be reused');
    pass(`${app.key}: ${standalone ? 'standalone' : 'browser'} return, late readiness, explicit single prompt and acceptance`);
  } finally { await context.close(); }
}

async function checkDismissalAndFailures() {
  const { context, page } = await fixture(APPS[0], { query: '?install=1', standalone: true });
  try {
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    await closeDialog(page);
    await emitPrompt(page, 'dismissed');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(!(await page.locator(DIALOG).isVisible()), 'A late event must respect a dismissed helper');
    // Synthetic click checks synchronous invocation before an await; actual
    // Playwright clicks in the preceding test separately check user activation.
    const syncCalls = await page.locator('[data-install]').first().evaluate(element => {
      element.click();
      return window.installFixture.calls;
    });
    assert.equal(syncCalls, 1, 'A ready native prompt must be invoked synchronously from its click');
    await page.waitForFunction(() => document.querySelector('#okInstallDialog')?.innerText.includes('취소'));
    await closeDialog(page);
    await page.locator('[data-install]').first().click();
    assert.equal(await page.evaluate(() => window.installFixture.calls), 1, 'A dismissed native event cannot be prompted again');
    await closeDialog(page);
    await emitPrompt(page, 'accepted', true);
    await page.locator('[data-install]').first().click();
    await assertNativeCalls(page, 1);
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.match(await page.locator(DIALOG).innerText(), /열지 못|열 수 없|설치 방법/);
    assert(await page.locator('[data-install]').first().isEnabled(), 'Prompt errors must not leave the install button disabled');
    await closeDialog(page);
    await page.locator('[data-install]').first().click();
    assert.equal(await page.evaluate(() => window.installFixture.calls), 1);
    pass('Shared controller: dismissal, late-event silence, synchronous prompt, cancel and error recovery');
  } finally { await context.close(); }
}

async function checkPlatformStates(app) {
  // navigator.standalone is independent of the Android display-mode fixture.
  for (const iosStandalone of [false, true]) {
    const { context, page } = await fixture(app, { ua: IPHONE, iosStandalone });
    try {
      await page.locator('[data-install]').first().click();
      await page.locator(DIALOG).waitFor({ state: 'visible' });
      const text = await page.locator(DIALOG).innerText();
      assert.match(text, /공유/);
      assert.match(text, /홈 화면에 추가/);
      if (iosStandalone) assert.match(text, /Safari/, 'An iPhone app window needs browser recovery guidance');
      assert.equal(await page.locator(`${DIALOG} ${ACTION('install')}`).count(), 0);
      assert.equal(await page.locator(`${DIALOG} ${ACTION('chrome')}`).count(), 0);
      assert(await page.locator(`${DIALOG} ${ACTION('copy')}`).isVisible());
      await assertNoInstallClaimFromMode(page);
    } finally { await context.close(); }
  }
  pass(`${app.key}: iPhone browser and standalone manual recovery without false installed status`);
}

async function checkFallbackAndManifests() {
  const { context, page } = await fixture(APPS[1], { query: '?install=1&install_fallback=1', standalone: true, copyFails: true });
  try {
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.match(await page.locator(DIALOG).innerText(), /열지 못|열 수 없/);
    assert.equal(await page.locator(`${DIALOG} ${ACTION('chrome')}`).count(), 0, 'Failed handoff must stop rather than reopen Chrome');
    await assertNoInstallClaimFromMode(page);
    await page.locator(`${DIALOG} ${ACTION('copy')}`).click();
    const field = page.locator(`${DIALOG} [data-install-url]`);
    await field.waitFor({ state: 'visible' });
    assert.equal(new URL(await field.inputValue()).pathname, '/admin/');
    const manifests = [], scopes = [];
    for (const app of APPS) {
      const url = ORIGIN + app.manifestPath;
      const response = await context.request.get(url);
      assert.equal(response.status(), 200);
      const manifest = await response.json();
      assert.equal(new URL(manifest.id, url).pathname, app.identity, 'Each app must preserve its existing manifest identity');
      assert.equal(new URL(manifest.start_url, url).pathname, app.installPath);
      assert.equal(new URL(manifest.scope, url).pathname, app.installPath);
      manifests.push(new URL(manifest.id, url).href);
      scopes.push(new URL(manifest.scope, url).pathname);
    }
    assert.notEqual(manifests[0], manifests[1], 'Customer and admin must not share an install identity');
    assert(!scopes[0].startsWith(scopes[1]) && !scopes[1].startsWith(scopes[0]), 'Neither app scope may contain the other app');
    pass('Standalone handoff/clipboard failure recovery, preserved identities and nonoverlapping app scopes');
  } finally { await context.close(); }
}

async function checkPerAppInstallState() {
  for (const standalone of [false, true]) {
    const { context, page } = await fixture(APPS[0], { standalone });
    try {
      await page.locator('[data-install]').first().click();
      await page.locator(DIALOG).waitFor({ state: 'visible' });
      await assertChromeHandoff(page, APPS[0]);
      await assertNoInstallClaimFromMode(page);
      await closeDialog(page);
      await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
      await page.locator('[data-install]').first().click();
      await page.locator(DIALOG).waitFor({ state: 'visible' });
      assert.match(await page.locator(DIALOG).innerText(), /설치를 시작/);
      // Reproduce an old customer PWA whose root scope also contains /admin/.
      // Navigation retains standalone mode, but must not identify the admin
      // PWA as installed or suppress its own installation route.
      await page.goto(ORIGIN + APPS[1].path);
      await page.locator('[data-install]').first().waitFor({ state: 'visible' });
      await page.locator('[data-install]').first().click();
      await page.locator(DIALOG).waitFor({ state: 'visible' });
      await assertChromeHandoff(page, APPS[1]);
      await assertNoInstallClaimFromMode(page);
      assert.match(await page.locator(DIALOG).innerText(), /관리자용/);
      assert.equal(await page.locator(`${DIALOG} ${ACTION('install')}`).count(), 0, 'No browser event means no pretend install action');
      assert.equal(new URL(page.url()).pathname, '/admin/', 'Opening recovery must not automatically navigate');
      if (standalone) {
        fs.mkdirSync('test-results', { recursive: true });
        await page.screenshot({ path: path.join('test-results', 'install-admin-standalone-390.png'), animations: 'disabled' });
      }
      pass(`Customer → administrator in ${standalone ? 'standalone' : 'browser'} mode retains separate installation access`);
    } finally { await context.close(); }
  }
}

async function checkCustomerAppEntry() {
  const app = APPS[0];
  const { context, page, responses } = await fixture({ ...app, path: app.installPath }, { query: '?src=app&ref=OK-TEST01' });
  try {
    assert.equal(new URL(page.url()).pathname, app.installPath, 'The customer app entry must be a real page, not a redirect out of its scope');
    for (const asset of ['/app.js', '/site.js', '/style.css', '/install.js', '/install.css', '/icon-192.png']) {
      assert.equal(responses.get(asset), 200, `Customer app entry must load ${asset} successfully`);
    }
    assert.equal(await page.locator('link[rel="manifest"]').evaluate(link => new URL(link.href).pathname), app.manifestPath);
    assert.equal(await page.evaluate(() => window.OKCleanInstall?.app), 'customer');
    await page.locator('#qSvc option').first().waitFor({ state: 'attached' });
    assert(await page.locator('#qSvc option').count() > 1, 'The customer app needs the full quote calculator');
    const before = await page.locator('#qSvc').inputValue();
    await page.locator('#qSvc').selectOption({ index: 1 });
    const selected = await page.locator('#qSvc').inputValue();
    assert.notEqual(selected, before);
    await page.waitForFunction(value => JSON.parse(localStorage.getItem('quote'))?.svc === value, selected);
    assert((await page.locator('#qV').innerText()).trim(), 'Changing the quote service must leave a visible quote result');
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith('/cases.json')));
    assert.equal(responses.get('/cases.json'), 200, 'The app entry must fetch public case data at the working root path');
    assert(!responses.has('/app/cases.json'), 'Moving the app entry must not break relative case-data loading');
    await page.getByRole('link', { name: '상담용 견적 문의하기', exact: true }).click();
    await page.waitForFunction(() => location.hash === '#quote');
    const after = new URL(page.url());
    assert.equal(after.pathname, app.installPath, 'Hash navigation must stay inside the customer app scope');
    assert.equal(after.searchParams.get('ref'), 'OK-TEST01', 'Hash navigation must retain referral attribution');
    await page.locator('[data-install]').first().click();
    const href = await assertChromeHandoff(page, app);
    assert(href.includes('ref=OK-TEST01'), 'Customer installation handoff must retain referral attribution');
    pass('Customer /app/ entry loads assets/cases, runs quote controls and preserves in-scope hash navigation/referral');
  } finally { await context.close(); }
}

(async () => {
  browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox']
  });
  try {
    for (const app of APPS) for (const width of [320, 390]) await checkInitialHelp(app, width);
    for (const app of APPS) for (const standalone of [false, true]) await checkReturnedAndReady(app, standalone);
    await checkDismissalAndFailures();
    for (const app of APPS) await checkPlatformStates(app);
    await checkFallbackAndManifests();
    await checkPerAppInstallState();
    await checkCustomerAppEntry();
    console.log(`Install UX: ${passed} scenario groups passed. Chromium fixtures only; no native installation or production writes.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
