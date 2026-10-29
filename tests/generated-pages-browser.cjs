// Regress generated output with synthetic settings; never sends an external request.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.OKCLEAN_TEST_BASE || 'http://127.0.0.1:8766';
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]) {
      const context = await browser.newContext({viewport,serviceWorkers:'block'});
      await context.route('**/*', route => {
        const u = new URL(route.request().url());
        if(u.origin !== base) return route.abort();
        if(u.pathname === '/member-sync.js') return route.fulfill({status:200,contentType:'application/javascript',body:'export async function submitMember(config, member) { window.fakeSubmitted = member; }'});
        return route.continue();
      });
      await context.addInitScript(() => {
        if(location.hostname !== '127.0.0.1') return;
        localStorage.setItem('joinLater', JSON.stringify(Date.now()));
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text => {window.fakeCopy=text;}}});
      });
      const page = await context.newPage(), errors=[];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base+'/',{waitUntil:'load'});
      assert.match(await page.title(), /가상 청소 업체/);
      assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), 'https://example.test/');
      assert.equal(await page.locator('#qSvc').inputValue(), 'move-in');
      await page.locator('#qTier [data-t="0"]').click();
      assert.match(await page.locator('#qV').innerText(), /15만/);
      await page.locator('#qOpt input').first().check();
      assert.match(await page.locator('#qV').innerText(), /18만~20만/);
      await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.fakeCopy), /가상 옵션/);
      await page.locator('#qKakao').click();
      assert.equal(await page.locator('#sheet a.btn.glove').getAttribute('href'), 'https://example.test/chat');
      await page.keyboard.press('Escape');
      await page.locator('#caseList a.case').first().waitFor({state:'visible'});
      assert.equal(await page.locator('#caseList a.case').first().getAttribute('href'), 'https://example.test/case/1');
      await page.locator('[data-join]').first().click();
      await page.locator('#jName').fill('가상고객'); await page.locator('#jPhone').fill('01000000000');
      await page.locator('#jAgree').check(); await page.locator('#jSubmit').click();
      await page.waitForFunction(() => window.fakeSubmitted?.name === '가상고객');
      assert.match(await page.locator('#joinDone').innerText(), /1만원/);
      await page.locator('#jKakao').click();
      assert.match(await page.locator('#sheetB').innerText(), /가상고객/);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.goto(base+'/privacy.html',{waitUntil:'load'});
      assert.match(await page.locator('main').innerText(), /Firebase의 Cloud Firestore/);
      assert.match(await page.locator('main').innerText(), /이 기기의 회원정보 지우기/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors,[]);
      await context.close();
      console.log(`generated site PASS ${viewport.width}`);
    }
  } finally { await browser.close(); }
})().catch(e => {console.error(e);process.exit(1)});
