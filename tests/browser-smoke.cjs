const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const viewport of [{width: 390, height: 844}, {width: 1440, height: 900}]) {
      const context = await browser.newContext({viewport});
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== '127.0.0.1') return route.abort();
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://127.0.0.1:8765/', {waitUntil: 'domcontentloaded'});
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
      await page.locator('#qKakao').click();
      await page.locator('#sheet').waitFor({state: 'visible'});
      assert.match(await page.locator('#sheetB').innerText(), /에어컨 청소/);
      assert.equal(await page.locator('#sheetB a').getAttribute('href'), 'https://open.kakao.com/o/s3TIhwSi');
      await page.locator('#sheet [data-close]').first().click();
      await page.locator('[data-join]').first().click();
      await page.locator('#jSubmit').click();
      assert.match(await page.locator('#jErr').innerText(), /이름/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal overflow');
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(err => {console.error(err);process.exit(1)});
