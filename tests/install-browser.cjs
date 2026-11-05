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
  { key: 'customer', path: '/', name: '오케이청소' },
  { key: 'admin', path: '/admin/', name: '오케이청소 관리자' }
];
const DIALOG = '#okInstallDialog';
const ACTION = name => `[data-install-action="${name}"]`;
let browser;
let passed = 0;

function pass(message) {
  passed++;
  console.log('PASS:', message);
}

async function fixture(app, { width = 390, ua = ANDROID, query = '', standalone = false, copyFails = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: 820 }, userAgent: ua,
    isMobile: true, hasTouch: true, serviceWorkers: 'block'
  });
  await context.route('**/*', route => {
    // No Firebase auth/data, analytics, or other real external services in tests.
    const url = new URL(route.request().url());
    return url.origin === new URL(ORIGIN).origin ? route.continue() : route.abort();
  });
  await context.addInitScript(({ standalone, copyFails }) => {
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
    if (copyFails) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async () => { throw new Error('fixture clipboard denied'); } }
      });
      document.execCommand = () => false;
    }
  }, { standalone, copyFails });
  const page = await context.newPage();
  await page.goto(ORIGIN + app.path + query, { waitUntil: 'load' });
  await page.locator('[data-install]').first().waitFor({ state: 'visible' });
  return { context, page };
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

async function checkInitialHelp(app, width) {
  const { context, page } = await fixture(app, { width });
  try {
    assert(!(await page.locator(DIALOG).isVisible()), 'A normal visit must not auto-open the installer');
    await page.locator('[data-install]').first().click();
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.match(await page.locator(DIALOG).innerText(), new RegExp(app.name));
    const chrome = page.locator(`${DIALOG} ${ACTION('chrome')}`);
    await chrome.waitFor({ state: 'visible' });
    const href = await chrome.getAttribute('href');
    assert(href.startsWith(`intent://${new URL(ORIGIN).host}${app.path}?`), 'Chrome handoff must preserve the correct app path');
    assert(href.includes('package=com.android.chrome;'));
    assert(href.includes('install=1'));
    const fallbackValue = href.match(/S\.browser_fallback_url=([^;]+);/);
    assert(fallbackValue, 'A blocked/unavailable Chrome handoff needs a fallback');
    const fallback = new URL(decodeURIComponent(fallbackValue[1]));
    assert.equal(fallback.pathname, app.path);
    assert.equal(fallback.searchParams.get('install'), '1');
    assert.equal(fallback.searchParams.get('install_fallback'), '1');
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

async function checkReturnedAndReady(app) {
  const { context, page } = await fixture(app, { query: '?install=1&ref=fixture' });
  try {
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).searchParams.get('install'), null, 'The handoff marker must be consumed');
    assert.equal(new URL(page.url()).searchParams.get('ref'), 'fixture', 'Unrelated URL parameters must be retained');
    assert.equal(await page.locator(`${DIALOG} ${ACTION('chrome')}`).count(), 0, 'A returned page must not loop into Chrome again');
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
    pass(`${app.key}: browser return, late readiness, explicit single prompt and acceptance`);
  } finally { await context.close(); }
}

async function checkDismissalAndFailures() {
  const { context, page } = await fixture(APPS[0], { query: '?install=1' });
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
  let current = await fixture(app, { ua: IPHONE });
  try {
    await current.page.locator('[data-install]').first().click();
    await current.page.locator(DIALOG).waitFor({ state: 'visible' });
    const text = await current.page.locator(DIALOG).innerText();
    assert.match(text, /공유/);
    assert.match(text, /홈 화면에 추가/);
    assert.equal(await current.page.locator(`${DIALOG} ${ACTION('install')}`).count(), 0);
    assert.equal(await current.page.locator(`${DIALOG} ${ACTION('chrome')}`).count(), 0);
  } finally { await current.context.close(); }
  current = await fixture(app, { standalone: true });
  try {
    await current.page.locator('[data-install]').first().click();
    await current.page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.match(await current.page.locator(DIALOG).innerText(), /실행 중|사용 중/);
    assert.equal(await current.page.locator(`${DIALOG} ${ACTION('install')}`).count(), 0);
    assert.equal(await current.page.locator(`${DIALOG} ${ACTION('chrome')}`).count(), 0);
    assert(await current.page.locator('[data-install]').first().isVisible());
    pass(`${app.key}: iPhone manual steps and app-running state (simulated device signals)`);
  } finally { await current.context.close(); }
}

async function checkFallbackAndManifests() {
  const { context, page } = await fixture(APPS[1], { query: '?install=1&install_fallback=1', copyFails: true });
  try {
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.match(await page.locator(DIALOG).innerText(), /열지 못|열 수 없/);
    assert.equal(await page.locator(`${DIALOG} ${ACTION('chrome')}`).count(), 0, 'Failed handoff must stop rather than reopen Chrome');
    await page.locator(`${DIALOG} ${ACTION('copy')}`).click();
    const field = page.locator(`${DIALOG} [data-install-url]`);
    await field.waitFor({ state: 'visible' });
    assert.equal(new URL(await field.inputValue()).pathname, '/admin/');
    const manifests = [];
    for (const app of APPS) {
      const url = ORIGIN + app.path + 'manifest.webmanifest';
      const response = await context.request.get(url);
      assert.equal(response.status(), 200);
      const manifest = await response.json();
      assert.equal(new URL(manifest.id, url).pathname, app.path, 'Each app must keep its own manifest identity');
      assert.equal(new URL(manifest.start_url, url).pathname, app.path);
      assert.equal(new URL(manifest.scope, url).pathname, app.path);
      manifests.push(new URL(manifest.id, url).href);
    }
    assert.notEqual(manifests[0], manifests[1], 'Customer and admin must not share an install identity');
    pass('Blocked Chrome/clipboard fallback and distinct customer/admin manifests');
  } finally { await context.close(); }
}

async function checkPerAppInstallState() {
  const { context, page } = await fixture(APPS[0]);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await page.locator('[data-install]').first().click();
    await page.locator(DIALOG).waitFor({ state: 'visible' });
    assert.match(await page.locator(DIALOG).innerText(), /설치를 시작/);
    // A shared origin must not turn the customer's installation event into an
    // "already installed" flag for the separate administrator application.
    await page.goto(ORIGIN + '/admin/');
    await page.locator('[data-install]').first().waitFor({ state: 'visible' });
    await page.locator('[data-install]').first().click();
    await page.locator(`${DIALOG} ${ACTION('chrome')}`).waitFor({ state: 'visible' });
    assert.match(await page.locator(DIALOG).innerText(), /관리자용/);
    pass('Customer installation event does not hide or mark the administrator app as installed');
  } finally { await context.close(); }
}

(async () => {
  browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox']
  });
  try {
    for (const app of APPS) for (const width of [320, 390]) await checkInitialHelp(app, width);
    for (const app of APPS) await checkReturnedAndReady(app);
    await checkDismissalAndFailures();
    for (const app of APPS) await checkPlatformStates(app);
    await checkFallbackAndManifests();
    await checkPerAppInstallState();
    console.log(`Install UX: ${passed} scenario groups passed. Chromium fixtures only; no native installation or production writes.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
