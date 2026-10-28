const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const base = 'http://127.0.0.1:8765';
const source = fs.readFileSync('index.html', 'utf8');
const home = source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_, start, raw, end) => {
  const cfg = JSON.parse(raw);
  cfg.firebase = {apiKey:'fake-test-identifier', projectId:'fake-test-project'};
  cfg.memberBackendUrl = '';
  cfg.kakao = 'https://example.test/chat';
  cfg.blog = [];
  return start + JSON.stringify(cfg).replace(/<\//g, '<\\/') + end;
});

async function session(browser, viewport, initialBlocked) {
  const context = await browser.newContext({viewport, serviceWorkers:'block'});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if(url.hostname !== '127.0.0.1') return route.abort();
    if(url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({status:200,contentType:'text/html',body:home});
    if(url.pathname === '/cases.json') return route.fulfill({status:200,contentType:'application/json',body:'{"cases":[]}'});
    if(url.pathname === '/member-sync.js') return route.fulfill({status:200,contentType:'application/javascript',body:
      'export function submitMember(){window.fakeSubmitStarted=true;return new Promise((resolve,reject)=>{window.fakeSubmitDone=resolve;window.fakeSubmitFail=()=>reject(new Error("synthetic backend failure"))})}'});
    return route.continue();
  });
  await context.addInitScript(blocked => {
    if(location.hostname !== '127.0.0.1') return;
    localStorage.setItem('joinLater', JSON.stringify(Date.now()));
    window.blockMemberStorage = blocked;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if(key === 'member' && window.blockMemberStorage) throw new Error('synthetic storage failure');
      return original.call(this, key, value);
    };
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async text => {window.fakeCopy = text;}}});
  }, initialBlocked);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/', {waitUntil:'load'});
  return {context, page, errors};
}

async function submit(page) {
  await page.locator('[data-join]').first().click();
  await page.locator('#jName').fill('가상고객');
  await page.locator('#jPhone').fill('01000000000');
  await page.locator('#jAgree').check();
  await page.locator('#jSubmit').click();
  await page.locator('#joinDone').waitFor({state:'visible'});
  await page.waitForFunction(() => window.fakeSubmitStarted && typeof window.fakeSubmitDone === 'function');
  return page.locator('#joinDone .coupon code').innerText();
}

async function reopen(page) {
  await page.locator('#join button.x').click();
  await page.locator('[data-join]').first().click();
  await page.locator('#joinDone').waitFor({state:'visible'});
}

async function clickKakao(page) {
  await page.locator('#jKakao').click();
  await page.locator('#sheet').waitFor({state:'visible'});
}

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844}, {width:1440,height:900}]) {
      {
        const {context,page,errors} = await session(browser, viewport, true);
        const code = await submit(page);
        assert.match(code, /^OK-[A-Z2-9]{6}$/);
        assert.equal(await page.evaluate(() => localStorage.getItem('member')), null);
        await page.locator('#jStorageNote').waitFor({state:'visible'});
        assert.match(await page.locator('#jStorageNote').innerText(), /기기에 저장하지 못했어요.*쿠폰 정보가 사라질 수/s);
        await page.screenshot({path:`/tmp/okclean-member-storage-${viewport.width}.png`});
        await page.evaluate(() => window.fakeSubmitDone());
        assert.match(await page.locator('.toast').innerText(), /접수 요청이 완료/);
        assert.equal(await page.locator('#jStorageNote').isVisible(), true);
        await reopen(page);
        assert.equal(await page.locator('#jStorageNote').isVisible(), true);
        assert.equal(await page.locator('#joinDone .coupon code').innerText(), code);
        await page.reload({waitUntil:'load'});
        await page.locator('[data-join]').first().click();
        assert.equal(await page.locator('#joinForm').isVisible(), true);
        assert.equal(await page.locator('#joinDone').isVisible(), false);
        assert.deepEqual(errors, []);
        await context.close();
      }
      {
        const {context,page,errors} = await session(browser, viewport, true);
        const code = await submit(page);
        await page.evaluate(() => {window.blockMemberStorage = false;});
        await clickKakao(page);
        assert.equal(await page.locator('#sheet .err').filter({hasText:'최근 회원정보'}).count(), 0);
        assert.match(await page.evaluate(() => window.fakeCopy), new RegExp('쿠폰번호: ' + code));
        assert.doesNotMatch(await page.evaluate(() => window.fakeCopy), /저장하지 못했어요/);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('member')).code), code);
        await page.locator('#sheet button.x').click();
        await page.locator('[data-join]').first().click();
        assert.equal(await page.locator('#jStorageNote').isVisible(), false);
        assert.equal(await page.locator('#joinDone .coupon code').innerText(), code);
        await page.reload({waitUntil:'load'});
        await page.locator('[data-join]').first().click();
        assert.equal(await page.locator('#joinDone .coupon code').innerText(), code);
        assert.deepEqual(errors, []);
        await context.close();
      }
      {
        const {context,page,errors} = await session(browser, viewport, false);
        const code = await submit(page);
        assert.equal(await page.locator('#jStorageNote').isVisible(), false);
        await page.evaluate(() => {window.blockMemberStorage = true;});
        await clickKakao(page);
        const warning = page.locator('#sheet .err').filter({hasText:'최근 회원정보'});
        await warning.waitFor({state:'visible'});
        assert.match(await warning.innerText(), /최근 회원정보.*저장하지 못했어요.*사라질 수/s);
        await page.screenshot({path:`/tmp/okclean-member-sheet-${viewport.width}.png`});
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('member')).code), code);
        assert.match(await page.evaluate(() => window.fakeCopy), new RegExp('쿠폰번호: ' + code));
        assert.doesNotMatch(await page.evaluate(() => window.fakeCopy), /저장하지 못했어요/);
        await page.locator('#sheet button.x').click();
        await page.locator('[data-join]').first().click();
        assert.equal(await page.locator('#jStorageNote').isVisible(), true);
        await page.evaluate(() => window.fakeSubmitDone());
        assert.equal(await page.locator('#jStorageNote').isVisible(), true);
        assert.deepEqual(errors, []);
        await context.close();
      }
      {
        const {context,page,errors} = await session(browser, viewport, true);
        await submit(page);
        page.once('dialog', dialog => dialog.accept());
        await page.locator('#jClearDevice').click();
        assert.equal(await page.locator('#joinForm').isVisible(), true);
        assert.equal(await page.evaluate(() => localStorage.getItem('member')), null);
        await page.evaluate(() => window.fakeSubmitDone());
        assert.doesNotMatch(await page.locator('.toast').innerText(), /접수 요청이 완료/);
        assert.deepEqual(errors, []);
        await context.close();
      }
      {
        const {context,page,errors} = await session(browser, viewport, true);
        await submit(page);
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async () => {throw new Error('clipboard denied');}}});
          document.execCommand = () => false;
        });
        await clickKakao(page);
        const warning = page.locator('#sheet .err').filter({hasText:'최근 회원정보'});
        assert.equal(await warning.isVisible(), true);
        assert.match(await page.locator('#sheet [data-copy-status]').innerText(), /자동 복사하지 못했어요/);
        assert.match(await page.locator('#sheetB').innerText(), /길게 눌러 복사/);
        assert.equal(await page.locator('#sheet [data-copy-again]').isVisible(), true);
        await page.evaluate(() => window.fakeSubmitFail());
        await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('자동 접수가 되지 않았어요'));
        assert.equal(await warning.isVisible(), true);
        assert.deepEqual(errors, []);
        await context.close();
      }
      console.log('member storage PASS ' + viewport.width);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
