// Auxiliary UI/controller checks only. Browser install events, installed-app
// signals and external handoffs below are fixtures, not actual phone installs.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ORIGIN = process.env.OKCLEAN_TEST_ORIGIN || 'http://127.0.0.1:8765';
assert(['127.0.0.1', 'localhost'].includes(new URL(ORIGIN).hostname), 'Tests require an isolated local server');
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';
const IN_APP_ANDROID = ANDROID + ' KAKAOTALK/26.0.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const APPS = [
  { key: 'customer', path: '/', installPath: '/app/', identity: '/', manifestPath: '/manifest.webmanifest', name: '오케이청소' },
  { key: 'admin', path: '/admin/', installPath: '/admin/', identity: '/admin/', manifestPath: '/admin/manifest.webmanifest', name: '오케이청소 관리자' }
];
const PANEL = '#okInstallPanel';
const ACTION = name => `[data-install-action="${name}"]`;
const button = page => page.locator('[data-install]').first();
let browser;
let passed = 0;
function pass(message) { passed++; console.log('PASS (fixture):', message); }

async function fixture(app, { width = 390, ua = ANDROID, query = '', standalone = false, iosStandalone = false, copyFails = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 820 }, userAgent: ua, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === ORIGIN ? route.continue() : route.abort());
  await context.addInitScript(({ standalone, iosStandalone, copyFails }) => {
    // Real installation is tested separately. No native prompt or live SDK call
    // may leak into this deterministic state-transition suite.
    window.addEventListener('beforeinstallprompt', event => {
      if (event.isTrusted) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async () => ({}) } });
    if (standalone) {
      const original = window.matchMedia.bind(window);
      window.matchMedia = query => query === '(display-mode: standalone)' ?
        { matches: true, media: query, addEventListener() {}, addListener() {} } : original(query);
    }
    if (iosStandalone) Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    if (copyFails) Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Fixture denied'); } } });
    window.fixtureHandoffs = [];
    document.addEventListener('click', event => {
      const link = event.target.closest('a[href^="intent://"]');
      if (!link) return;
      window.fixtureHandoffs.push({ href: link.href, trusted: event.isTrusted, activation: navigator.userActivation?.isActive === true });
      event.preventDefault(); // Record intent only; never launch an external app in a fixture.
    }, true);
  }, { standalone, iosStandalone, copyFails });
  const page = await context.newPage();
  await page.clock.install();
  const responses = new Map();
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === ORIGIN) responses.set(url.pathname, response.status()); });
  await page.goto(ORIGIN + app.path + query, { waitUntil: 'load' });
  await button(page).waitFor({ state: 'visible' });
  return { context, page, responses };
}

async function emitPrompt(page, { outcome = 'accepted', behavior = 'choice' } = {}) {
  return page.evaluate(({ outcome, behavior }) => {
    const record = window.installFixture ||= { events: [], totalCalls: 0 };
    const entry = { calls: 0, activation: [], prevented: false };
    record.events.push(entry);
    const heldChoice = new Promise(resolve => { entry.resolve = resolve; });
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.userChoice = behavior === 'held' || behavior === 'pending' ? heldChoice : Promise.resolve({ outcome });
    event.prompt = () => {
      entry.calls++; record.totalCalls++;
      entry.activation.push(navigator.userActivation?.isActive === true);
      if (entry.calls > 1) throw new Error('Consumed event reused');
      if (behavior === 'throw') throw new Error('Fixture prompt failure');
      if (behavior === 'reject') return Promise.reject(new Error('Fixture promise failure'));
      if (behavior === 'pending') return heldChoice;
      if (behavior === 'direct') return Promise.resolve({ outcome });
      return Promise.resolve();
    };
    window.dispatchEvent(event);
    entry.prevented = event.defaultPrevented;
    return record.events.length - 1;
  }, { outcome, behavior });
}
async function resolvePrompt(page, id, outcome) { await page.evaluate(({ id, outcome }) => window.installFixture.events[id].resolve({ outcome }), { id, outcome }); }
async function expectState(page, expected) { await page.waitForFunction(expected => window.OKCleanInstall.getState().state === expected, expected); assert.equal(await button(page).getAttribute('data-install-state'), expected); }
async function expectCalls(page, expected) { assert.equal(await page.evaluate(() => window.installFixture?.totalCalls || 0), expected); }
async function closePanel(page) {
  if (await page.locator(PANEL).isVisible()) {
    await page.locator(`${PANEL} ${ACTION('close')}`).click();
    await page.locator(PANEL).waitFor({ state: 'hidden' });
  }
}
async function assertNoDeviceClaim(page) {
  const current = await page.evaluate(() => window.OKCleanInstall.getState());
  assert.equal(current.deviceIconVerified, false, 'Page events never verify an OS icon or its launch');
  assert.doesNotMatch(await button(page).innerText(), /앱 사용 중|설치 완료/, 'Mode/acceptance must not claim completed installation');
}
async function assertNoSecondInstallButton(page) {
  assert.equal(await page.locator(`${PANEL} ${ACTION('install')}`).count(), 0, 'The status panel must not add a second install button');
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Installation status must not block the page with a modal');
}
function validateHandoff(href, app) {
  assert(href.startsWith(`intent://${new URL(ORIGIN).host}${app.installPath}?`));
  assert(href.includes('package=com.android.chrome;'));
  assert(href.includes('install=1'));
  const encoded = href.match(/S\.browser_fallback_url=([^;]+);/);
  assert(encoded);
  const fallback = new URL(decodeURIComponent(encoded[1]));
  assert.equal(fallback.pathname, app.installPath);
  assert.equal(fallback.searchParams.get('install'), '1');
  assert.equal(fallback.searchParams.get('install_fallback'), '1');
}

async function checkUnavailable(app, width) {
  const { context, page } = await fixture(app, { width });
  try {
    await expectState(page, 'checking');
    assert(!(await page.locator(PANEL).isVisible()));
    assert.doesNotMatch(await button(page).innerText(), /앱 설치/);
    await button(page).click();
    await page.locator(PANEL).waitFor({ state: 'visible' });
    await assertNoSecondInstallButton(page);
    assert.doesNotMatch(await page.locator(PANEL).innerText(), /주소 복사|⋮|설치 및 바로가기|설치 완료/);
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden');
    // Status is inline: real page controls remain reachable while it is open.
    if (app.key === 'admin') {
      await page.evaluate(() => document.querySelector('#loginBtn').addEventListener('click', () => { window.fixtureLoginClicked = true; }, { once: true }));
      await page.locator('#loginBtn').click();
      assert.equal(await page.evaluate(() => window.fixtureLoginClicked), true);
    } else {
      await page.locator('#qSvc option').first().waitFor({ state: 'attached' });
      await page.locator('#qSvc').selectOption({ index: 1 });
    }
    await page.clock.fastForward(8001);
    await expectState(page, 'unavailable');
    assert(await button(page).isEnabled());
    assert.doesNotMatch(await button(page).innerText(), /앱 설치/);
    const layout = await page.locator(PANEL).evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: innerWidth, content: element.scrollWidth, width: element.clientWidth, tapHeight: element.querySelector('[data-install-action="close"]').getBoundingClientRect().height };
    });
    assert(layout.left >= -1 && layout.right <= layout.viewport + 1 && layout.content <= layout.width + 1, 'Status must fit a narrow phone');
    assert(layout.tapHeight >= 44);
    if (width === 390) { fs.mkdirSync('test-results', { recursive: true }); await page.screenshot({ path: path.join('test-results', `install-${app.key}-status-390.png`), animations: 'disabled' }); }
    if (width === 320) await page.locator(`${PANEL} ${ACTION('close')}`).tap();
    else await closePanel(page);
    assert(await button(page).evaluate(element => element === document.activeElement));
    await assertNoDeviceClaim(page);
    pass(`${app.key}: no-event checking/unavailable, non-modal status, page controls, close/focus at ${width}px`);
  } finally { await context.close(); }
}

async function checkDirectPrompt(app, returnedStandalone) {
  const options = returnedStandalone ? { query: '?install=1&ref=fixture', standalone: true } : {};
  const { context, page } = await fixture(app, options);
  try {
    assert(!(await page.locator(PANEL).isVisible()), 'A return marker must not auto-open instructions');
    if (returnedStandalone) {
      await expectState(page, 'handoff-blocked');
      assert.equal(new URL(page.url()).searchParams.get('install'), null);
      assert.equal(new URL(page.url()).searchParams.get('ref'), 'fixture');
      await assertNoDeviceClaim(page);
    }
    const id = await emitPrompt(page, { behavior: 'held' });
    await expectState(page, 'ready');
    await expectCalls(page, 0);
    assert(!(await page.locator(PANEL).isVisible()), 'Readiness alone must not open UI or prompt');
    // A real user click must invoke the available prompt immediately, without a second dialog/button.
    await button(page).click();
    await expectState(page, 'prompting');
    await expectCalls(page, 1);
    const record = await page.evaluate(id => { const e = window.installFixture.events[id]; return { activation: e.activation, prevented: e.prevented }; }, id);
    assert.deepEqual(record, { activation: [true], prevented: true });
    assert(!(await page.locator(PANEL).isVisible()));
    await assertNoSecondInstallButton(page);
    await resolvePrompt(page, id, 'accepted');
    await expectState(page, 'requested');
    await assertNoDeviceClaim(page);
    assert.match(await page.locator(PANEL).innerText(), /아직 설치 완료 알림을 받지 못/);
    await button(page).click();
    await expectCalls(page, 1);
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expectState(page, 'installed-browser');
    const installed = await page.evaluate(() => window.OKCleanInstall.getState());
    assert.equal(installed.browserInstallEventReceived, true);
    assert.equal(installed.deviceIconVerified, false);
    assert.match(await page.locator(PANEL).innerText(), /아이콘 생성과 실행 여부는 이 페이지에서 확인할 수 없/);
    await page.reload({ waitUntil: 'load' });
    await button(page).waitFor({ state: 'visible' });
    const reloaded = await page.evaluate(() => window.OKCleanInstall.getState());
    assert.equal(reloaded.browserInstallEventReceived, false, 'Browser acknowledgement must not persist across page loads');
    assert(!['requested', 'installed-browser'].includes(reloaded.state));
    assert(!(await page.locator(PANEL).isVisible()));
    pass(`${app.key}: ${returnedStandalone ? 'returned standalone' : 'browser'} → direct prompt → request/event distinction → fresh reload`);
  } finally { await context.close(); }
}

async function checkCancellationAndNewEvent() {
  const { context, page } = await fixture(APPS[1]);
  try {
    await emitPrompt(page, { outcome: 'dismissed' });
    // This same-stack assertion checks there is no asynchronous boundary before prompt().
    const calls = await button(page).evaluate(element => { element.click(); return window.installFixture.totalCalls; });
    assert.equal(calls, 1);
    await expectState(page, 'unavailable');
    assert(await button(page).isEnabled());
    assert.match(await page.locator(PANEL).innerText(), /취소/);
    await button(page).click();
    await expectCalls(page, 1);
    const held = await emitPrompt(page, { behavior: 'held' });
    await button(page).click();
    await expectState(page, 'prompting');
    await emitPrompt(page, { behavior: 'direct' });
    await resolvePrompt(page, held, 'dismissed');
    await expectState(page, 'ready');
    assert(await button(page).isEnabled(), 'An old cancellation must not swallow a newer browser event');
    await button(page).click();
    await expectState(page, 'requested');
    await expectCalls(page, 3);
    pass('Cancellation consumes one event; a newer event survives an older pending result and prompts on one click');
  } finally { await context.close(); }
}

async function checkFailuresAndTimeout() {
  for (const behavior of ['throw', 'reject', 'pending']) {
    const { context, page } = await fixture(APPS[1]);
    try {
      const id = await emitPrompt(page, { behavior });
      await button(page).click();
      if (behavior === 'pending') { await expectState(page, 'prompting'); await page.clock.fastForward(45001); }
      await expectState(page, 'unavailable');
      assert(await button(page).isEnabled(), 'A thrown/rejected/abandoned prompt cannot leave the button dead');
      await assertNoDeviceClaim(page);
      await button(page).click();
      await expectCalls(page, 1);
      if (behavior === 'pending') {
        await resolvePrompt(page, id, 'accepted');
        await page.evaluate(() => Promise.resolve().then(() => Promise.resolve()));
        await expectState(page, 'unavailable');
      }
      await emitPrompt(page, { outcome: 'dismissed' });
      await expectState(page, 'ready');
      await button(page).click();
      await expectState(page, 'unavailable');
      await expectCalls(page, 2);
      pass(`Prompt ${behavior}: control recovers, no reuse or false completion, fresh event remains usable`);
    } finally { await context.close(); }
  }
}

async function checkInstalledRace() {
  const { context, page } = await fixture(APPS[1]);
  try {
    const id = await emitPrompt(page, { behavior: 'held' });
    await button(page).click();
    await expectState(page, 'prompting');
    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expectState(page, 'installed-browser');
    await resolvePrompt(page, id, 'dismissed');
    await page.evaluate(() => Promise.resolve().then(() => Promise.resolve()));
    await expectState(page, 'installed-browser');
    assert(await button(page).isEnabled());
    await assertNoDeviceClaim(page);
    pass('A late user-choice result cannot overwrite an appinstalled acknowledgement or claim an icon launch');
  } finally { await context.close(); }
}

async function checkHandoff(app, standalone) {
  const { context, page } = await fixture(app, { standalone, ua: standalone ? ANDROID : IN_APP_ANDROID, query: app.key === 'customer' ? '?ref=OK-TEST01' : '' });
  try {
    await expectState(page, 'handoff');
    assert.equal(await button(page).evaluate(element => element.tagName), 'A');
    const href = await button(page).getAttribute('href');
    validateHandoff(href, app);
    if (app.key === 'customer') assert(href.includes('ref=OK-TEST01'));
    assert(!(await page.locator(PANEL).isVisible()));
    await assertNoDeviceClaim(page);
    await button(page).click();
    await expectState(page, 'handoff-blocked');
    const attempts = await page.evaluate(() => window.fixtureHandoffs);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].trusted, true);
    assert.equal(attempts[0].activation, true);
    assert.equal(await button(page).evaluate(element => element.tagName), 'BUTTON');
    await button(page).click();
    assert.equal(await page.evaluate(() => window.fixtureHandoffs.length), 1, 'The same document must not repeat a handoff');
    assert.equal(await page.locator(`${PANEL} ${ACTION('chrome')}`).count(), 0);
    await page.reload({ waitUntil: 'load' });
    await expectState(page, 'handoff-blocked');
    assert(!(await page.locator(PANEL).isVisible()));
    await button(page).click();
    assert.equal(await page.evaluate(() => window.fixtureHandoffs.length), 0, 'Reload must not restore a blocked handoff in the same tab');
    await assertNoDeviceClaim(page);
    pass(`${app.key}: ${standalone ? 'app window' : 'known in-app browser'} direct Chrome link is user-initiated and guarded across reload`);
  } finally { await context.close(); }
}

async function checkReturnMarkersAndOptionalHandoff() {
  for (const standalone of [false, true]) {
    const { context, page } = await fixture(APPS[1], { standalone, query: '?install=1&install_fallback=1&ref=fixture' });
    try {
      await expectState(page, 'handoff-blocked');
      assert(!(await page.locator(PANEL).isVisible()));
      assert.equal(new URL(page.url()).searchParams.get('install'), null);
      assert.equal(new URL(page.url()).searchParams.get('install_fallback'), null);
      assert.equal(new URL(page.url()).searchParams.get('ref'), 'fixture');
      await button(page).click();
      assert.equal(await page.locator(`${PANEL} ${ACTION('chrome')}`).count(), 0);
      assert.equal(await page.locator(`${PANEL} ${ACTION('copy')}`).count(), 0);
      assert.doesNotMatch(await page.locator(PANEL).innerText(), /설치 및 바로가기|⋮/);
      await emitPrompt(page, { outcome: 'dismissed' });
      await expectState(page, 'ready');
      await button(page).click();
      await expectCalls(page, 1);
    } finally { await context.close(); }
  }
  const { context, page } = await fixture(APPS[0]);
  try {
    await page.clock.fastForward(8001);
    await button(page).click();
    const recovery = page.locator(`${PANEL} ${ACTION('chrome')}`);
    assert(!(await recovery.isVisible()), 'Unknown Custom Tab recovery must stay optional');
    await page.locator(`${PANEL} details summary`).click();
    validateHandoff(await recovery.getAttribute('href'), APPS[0]);
    await recovery.click();
    assert.equal(await page.evaluate(() => window.fixtureHandoffs.length), 1);
    await page.waitForFunction(() => !document.querySelector('#okInstallPanel [data-install-action="chrome"]'));
    pass('Returned/fallback URLs never auto-open help or repeat a handoff; genuine readiness still wins; optional Custom Tab escape is one attempt');
  } finally { await context.close(); }
}

async function checkIOS(app) {
  for (const iosStandalone of [false, true]) {
    const { context, page } = await fixture(app, { ua: IPHONE, iosStandalone, copyFails: true });
    try {
      await expectState(page, 'ios-manual');
      await button(page).click();
      await assertNoSecondInstallButton(page);
      await assertNoDeviceClaim(page);
      const text = await page.locator(PANEL).innerText();
      assert.match(text, /Safari/);
      assert.match(text, /공유/);
      assert.match(text, /홈 화면에 추가 → 추가/);
      assert.equal(await page.locator(`${PANEL} ${ACTION('chrome')}`).count(), 0);
      if (iosStandalone) {
        await page.locator(`${PANEL} details summary`).click();
        await page.locator(`${PANEL} ${ACTION('copy')}`).click();
        const field = page.locator(`${PANEL} [data-install-url]`);
        await field.waitFor({ state: 'visible' });
        assert.equal(new URL(await field.inputValue()).pathname, app.installPath);
        await page.clock.fastForward(8001);
        assert(await field.isVisible(), 'A routine status timer must not destroy manual fallback input or focus');
      } else assert.equal(await page.locator(`${PANEL} ${ACTION('copy')}`).count(), 0);
      await page.keyboard.press('Escape');
      assert(!(await page.locator(PANEL).isVisible()));
    } finally { await context.close(); }
  }
  pass(`${app.key}: iPhone minimal Safari flow, optional app-window fallback and no false installed claim`);
}

async function checkPerAppIdentity() {
  for (const standalone of [false, true]) {
    const { context, page } = await fixture(APPS[0], { standalone });
    try {
      await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
      await expectState(page, 'installed-browser');
      await page.goto(ORIGIN + APPS[1].path);
      await button(page).waitFor({ state: 'visible' });
      await expectState(page, standalone ? 'handoff' : 'checking');
      await assertNoDeviceClaim(page);
      assert.equal(await page.evaluate(() => window.OKCleanInstall.getState().browserInstallEventReceived), false);
      await page.evaluate(() => window.OKCleanInstall.openHelp());
      assert.match(await page.locator(PANEL).innerText(), /관리자용/);
      assert.equal(new URL(await page.locator(`${PANEL} img`).getAttribute('src')).pathname, '/admin/icon-192.png');
      pass(`Customer acknowledgement is not inherited by administrator in ${standalone ? 'standalone' : 'browser'} mode`);
    } finally { await context.close(); }
  }
}

async function checkCustomerEntryAndManifests() {
  const app = APPS[0];
  const { context, page, responses } = await fixture({ ...app, path: app.installPath }, { query: '?src=app&ref=OK-TEST01' });
  try {
    assert.equal(new URL(page.url()).pathname, app.installPath);
    for (const asset of ['/app.js', '/site.js', '/style.css', '/install.js', '/install.css', '/icon-192.png']) assert.equal(responses.get(asset), 200, asset);
    assert.equal(await page.locator('link[rel="manifest"]').evaluate(link => new URL(link.href).pathname), app.manifestPath);
    await page.locator('#qSvc option').first().waitFor({ state: 'attached' });
    const before = await page.locator('#qSvc').inputValue();
    await page.locator('#qSvc').selectOption({ index: 1 });
    const selected = await page.locator('#qSvc').inputValue();
    assert.notEqual(selected, before);
    await page.waitForFunction(value => JSON.parse(localStorage.getItem('quote'))?.svc === value, selected);
    assert((await page.locator('#qV').innerText()).trim());
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => new URL(entry.name).pathname.endsWith('/cases.json')));
    assert.equal(responses.get('/cases.json'), 200);
    assert(!responses.has('/app/cases.json'));
    await page.getByRole('link', { name: '상담용 견적 문의하기', exact: true }).click();
    await page.waitForFunction(() => location.hash === '#quote');
    assert.equal(new URL(page.url()).pathname, app.installPath);
    assert.equal(new URL(page.url()).searchParams.get('ref'), 'OK-TEST01');
    const ids = [], scopes = [];
    for (const target of APPS) {
      const url = ORIGIN + target.manifestPath;
      const response = await context.request.get(url);
      assert.equal(response.status(), 200);
      const manifest = await response.json();
      assert.equal(new URL(manifest.id, url).pathname, target.identity);
      assert.equal(new URL(manifest.start_url, url).pathname, target.installPath);
      assert.equal(new URL(manifest.scope, url).pathname, target.installPath);
      ids.push(new URL(manifest.id, url).href); scopes.push(new URL(manifest.scope, url).pathname);
    }
    assert.notEqual(ids[0], ids[1]);
    assert(!scopes[0].startsWith(scopes[1]) && !scopes[1].startsWith(scopes[0]));
    pass('Customer app entry, quote/case controls, scoped navigation/referral and existing separate manifest IDs/scopes are preserved');
  } finally { await context.close(); }
}

(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    for (const app of APPS) for (const width of [320, 390]) await checkUnavailable(app, width);
    for (const app of APPS) for (const returned of [false, true]) await checkDirectPrompt(app, returned);
    await checkCancellationAndNewEvent();
    await checkFailuresAndTimeout();
    await checkInstalledRace();
    for (const app of APPS) for (const standalone of [false, true]) await checkHandoff(app, standalone);
    await checkReturnMarkersAndOptionalHandoff();
    for (const app of APPS) await checkIOS(app);
    await checkPerAppIdentity();
    await checkCustomerEntryAndManifests();
    console.log(`Install state regression: ${passed} fixture scenario groups passed. No native phone installation or production writes.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
