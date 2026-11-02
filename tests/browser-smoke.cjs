const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const viewport of [{width: 390, height: 844}, {width: 1440, height: 900}]) {
      const context = await browser.newContext({viewport, serviceWorkers: 'block'});
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1') return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://127.0.0.1:8765/', {waitUntil: 'domcontentloaded'});
      for (const [saved, expected] of [[1000, '999'], [-5, '1'], [2.9, '2']]) {
        await page.evaluate(value => { localStorage.removeItem('quote_public_selection_v1'); localStorage.setItem('quote', JSON.stringify({svc:'aircon', v:0, t:null, qty:value, opts:[]})); }, saved);
        await page.reload({waitUntil: 'domcontentloaded'});
        assert.equal(await page.locator('#qQty').inputValue(), expected);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('quote')).qty), saved);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('quote_public_selection_v1')).qty), Number(expected));
      }
      await page.locator('#qSvc').selectOption('move-in');
      await page.locator('#qTier [data-t="0"]').click();
      assert.match(await page.locator('#qV').innerText(), /15만/);
      await page.locator('#qOpt input[data-o="0"]').check();
      assert.match(await page.locator('#qV').innerText(), /18만~20만/);
      await page.locator('#qSvc').selectOption('aircon');
      await page.locator('#qQty').fill('1000');
      assert.equal(await page.locator('#qQty').inputValue(), '999');
      await page.locator('#qDate').fill('2000-01-01');
      await page.locator('#qDate').dispatchEvent('change');
      assert.equal(await page.locator('#qDate').inputValue(), '');
      for (const button of ['#qCopy', '#qSms', '#qKakao']) {
        await page.evaluate(() => { document.querySelector('#qDate').value = '2000-01-01'; });
        await page.locator(button).click();
        assert.equal(await page.locator('#qDate').inputValue(), '');
        assert.match(await page.locator('.toast').innerText(), /지난 날짜/);
        assert.equal(await page.locator('#sheet').isVisible(), false);
      }
      await page.locator('#qKakao').click();
      await page.locator('#sheet').waitFor({state: 'visible'});
      assert.match(await page.locator('#sheetB').innerText(), /에어컨 청소/);
      assert.equal(await page.locator('#sheetB a').getAttribute('href'), 'https://open.kakao.com/o/s3TIhwSi');
      await page.waitForFunction(() => document.activeElement.matches('#sheetB a'));
      await page.locator('#sheet button.x').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('#sheet')), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.matches('#sheet button.x')), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'qKakao');
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async () => {throw new Error('denied');}}});
        document.execCommand = () => false;
      });
      await page.locator('#qCopy').click();
      assert.match(await page.locator('.toast').innerText(), /복사하지 못했어요/);
      await page.locator('#qSms').click();
      assert.match(await page.locator('.toast').innerText(), /복사하지 못했어요/);
      assert.doesNotMatch(await page.locator('.toast').innerText(), /복사했어요/);
      // Existing data is preserved; paused signup does not expose or send it.
      const existing = JSON.stringify({name:'Synthetic Member',phone:'01000001111',code:'OK-ABC123',free:'가상 서비스'});
      await page.evaluate(value => { localStorage.setItem('member', value); localStorage.setItem('ref', JSON.stringify('OK-ABC123')); }, existing);
      await page.reload({waitUntil:'domcontentloaded'});
      let moduleRequested = false;
      await page.route('**/member-sync.js', async route => { moduleRequested = true; await route.abort(); });
      await page.locator('[data-join]:visible').first().click();
      assert.match(await page.locator('#joinDone').innerText(), /회원가입 일시 중지/);
      assert.equal(await page.locator('#joinForm').isVisible(), false);
      assert.equal(await page.locator('#joinForm').evaluate(e => e.inert), true);
      await page.locator('#join button.x').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('#join')), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.matches('#join button.x')), true);
      // Hidden legacy entry points cannot submit even if invoked by a script.
      await page.evaluate(() => { const b=document.querySelector('#jSubmit'); b.dispatchEvent(new MouseEvent('click',{bubbles:true})); if(typeof b.onclick==='function') b.onclick(); });
      assert.equal(await page.evaluate(() => localStorage.getItem('member')), existing);
      assert.equal(moduleRequested, false);
      await page.screenshot({path: `/tmp/okclean-member-privacy-${viewport.width}.png`});
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.matches('[data-join]')), true);
      await page.evaluate(() => Object.defineProperty(navigator, 'share', {
        configurable: true, value: async ({url}) => { window.fakeSharedUrl = url; }
      }));
      await page.locator('[data-share]:visible').first().click();
      const shared = await page.evaluate(() => ({ref:new URL(window.fakeSharedUrl).searchParams.get('ref'),src:new URL(window.fakeSharedUrl).searchParams.get('src')}));
      assert.equal(shared.ref, null);
      assert.equal(shared.src, 'share');
      assert.equal(await page.evaluate(() => localStorage.getItem('member')), existing);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ref'))), 'OK-ABC123');
      await page.reload({waitUntil:'domcontentloaded'});
      assert.equal(await page.evaluate(() => localStorage.getItem('member')), existing);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal overflow');
      await page.goto('http://127.0.0.1:8765/privacy.html', {waitUntil: 'domcontentloaded'});
      const privacyText = await page.locator('main').innerText();
      assert.match(privacyText, /신규 회원가입 접수는 일시 중지/);
      assert.doesNotMatch(privacyText, /마지막 이용 후 2년이 지나면 파기/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'privacy page overflow');
      await page.locator('main').screenshot({path: `/tmp/okclean-privacy-notice-${viewport.width}.png`});
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(err => {console.error(err);process.exit(1)});

