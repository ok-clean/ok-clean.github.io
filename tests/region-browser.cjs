const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:8765';
(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    for (const viewport of [{width:390,height:844}, {width:1440,height:900}]) {
      const context = await browser.newContext({viewport, serviceWorkers:'block'});
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/');
      const seed = () => page.evaluate(() => localStorage.setItem('quote', JSON.stringify({svc:'aircon', v:0, qty:2, opts:[], area:'원주'})));
      await seed();
      await page.goto(base + '/area/' + encodeURIComponent('춘천') + '.html');
      await page.getByRole('link', {name:'춘천 견적 계산하기'}).click();
      assert.equal(await page.locator('#qArea').inputValue(), '춘천');
      assert.equal(await page.locator('#qSvc').inputValue(), 'aircon');
      assert.equal(await page.locator('#qQty').inputValue(), '2');
      assert.equal(new URL(page.url()).searchParams.has('area'), false);
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async text => { window.copied = text; }}}));
      await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.copied), /지역: 춘천/);
      await page.locator('#qArea').selectOption('홍천');
      await page.reload();
      assert.equal(await page.locator('#qArea').inputValue(), '홍천');
      await seed();
      await page.goto(base + '/area/' + encodeURIComponent('강원도') + '.html');
      await page.getByRole('link', {name:'강원도 견적 계산하기'}).click();
      assert.equal(await page.locator('#qArea').inputValue(), '');
      assert.match(await page.locator('#qAreaLinkNote').innerText(), /세부 지역/);
      await page.locator('#qArea').selectOption('인제');
      assert.equal(await page.locator('#qAreaLinkNote').count(), 0);
      await page.reload();
      assert.equal(await page.locator('#qArea').inputValue(), '인제');
      await seed();
      await page.goto(base + '/index.html?area=' + encodeURIComponent('수도권') + '&svc=aircon&ref=OK-ABC123#quote');
      assert.equal(await page.locator('#qArea').inputValue(), '수도권');
      const parsed = new URL(page.url());
      assert.equal(parsed.searchParams.has('area'), false);
      assert.equal(parsed.searchParams.get('svc'), 'aircon');
      assert.equal(parsed.searchParams.get('ref'), 'OK-ABC123');
      assert.equal(parsed.hash, '#quote');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ref'))), 'OK-ABC123');
      for (const query of ['area=', 'area=' + encodeURIComponent('알수없음'), 'area=' + encodeURIComponent('춘천') + '&area=' + encodeURIComponent('원주'), 'area=%3Cscript%3E']) {
        await seed();
        await page.goto(base + '/index.html?' + query + '#quote');
        assert.equal(await page.locator('#qArea').inputValue(), '', query);
        assert.match(await page.locator('#qAreaLinkNote').innerText(), /지역을 선택/);
      }
      await seed();
      await page.goto(base + '/index.html#quote');
      assert.equal(await page.locator('#qArea').inputValue(), '원주');
      assert.deepEqual(errors, []);
      await context.close();
      const failed = await browser.newContext({viewport, serviceWorkers:'block'});
      await failed.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await failed.addInitScript(() => { history.replaceState = () => { throw new Error('blocked'); }; });
      const p = await failed.newPage();
      await p.goto(base + '/index.html');
      await p.evaluate(() => localStorage.setItem('quote', JSON.stringify({svc:'aircon', v:0, qty:2, opts:[], area:'원주'})));
      await p.goto(base + '/index.html?area=' + encodeURIComponent('춘천') + '#quote');
      assert.equal(await p.locator('#qArea').inputValue(), '');
      assert.match(await p.locator('#qAreaLinkNote').innerText(), /지역을 선택/);
      await p.locator('#qArea').selectOption('홍천');
      await p.reload();
      assert.equal(await p.locator('#qArea').inputValue(), '');
      await failed.close();
      console.log('region PASS ' + viewport.width);
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
