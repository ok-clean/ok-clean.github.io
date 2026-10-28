const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:8765';

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844}, {width:1440,height:900}]) {
      const context = await browser.newContext({viewport, serviceWorkers:'block'});
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await context.addInitScript(() => {
        if(location.hostname !== '127.0.0.1') return;
        localStorage.setItem('joinLater', JSON.stringify(Date.now()));
        history.replaceState({sentinel:'preserved'}, '', location.href);
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/');
      const seed = () => page.evaluate(() => localStorage.setItem('quote', JSON.stringify({svc:'move-in',v:0,t:0,qty:null,opts:[],area:'춘천',date:'2099-10-29'})));
      await seed();
      await page.goto(base + '/services/aircon.html');
      // 상세 페이지의 링크가 실제 견적 페이지로 이동해 스크립트 로드까지
      // 끝난 뒤 선택 상태를 확인합니다. 기대값이 나올 때까지 기다리지는 않습니다.
      await Promise.all([
        page.waitForURL(url => url.pathname === '/index.html' && url.hash === '#quote', {waitUntil:'load'}),
        page.getByRole('link', {name:'내 견적 계산하기'}).click()
      ]);
      await page.locator('#qSvc option').first().waitFor({state:'attached'});
      assert.equal(await page.locator('#qSvc').inputValue(), 'aircon');
      assert.equal(new URL(page.url()).searchParams.has('svc'), false);
      assert.equal(await page.locator('#qArea').inputValue(), '춘천');
      assert.equal(await page.locator('#qDate').inputValue(), '2099-10-29');
      await page.locator('#qSvc').selectOption('washer');
      await page.reload();
      assert.equal(await page.locator('#qSvc').inputValue(), 'washer');
      assert.equal(await page.locator('#qArea').inputValue(), '춘천');
      assert.equal(await page.locator('#qDate').inputValue(), '2099-10-29');
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {window.testCopy = text;}}}));
      await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.testCopy), /서비스: 세탁기 청소/);
      await seed();
      await page.goto(base + '/index.html?svc=aircon&area=' + encodeURIComponent('춘천') + '&ref=OK-ABC123&extra=keep#quote');
      assert.equal(await page.locator('#qSvc').inputValue(), 'aircon');
      assert.equal(await page.locator('#qArea').inputValue(), '춘천');
      const url = new URL(page.url());
      assert.equal(url.searchParams.has('svc'), false);
      assert.equal(url.searchParams.has('area'), false);
      assert.equal(url.searchParams.get('ref'), 'OK-ABC123');
      assert.equal(url.searchParams.get('extra'), 'keep');
      assert.equal(url.hash, '#quote');
      assert.equal(await page.evaluate(() => history.state.sentinel), 'preserved');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ref'))), 'OK-ABC123');
      for(const query of ['svc=', 'svc=missing', 'svc=aircon&svc=washer', 'svc=%3Cscript%3E']) {
        await seed();
        await page.goto(base + '/index.html?' + query + '#quote');
        assert.equal(await page.locator('#qSvc').inputValue(), 'move-in', query);
        assert.match(await page.locator('#qSvcLinkNote').innerText(), /서비스.*확인/);
        assert.equal(new URL(page.url()).searchParams.has('svc'), false);
        await page.locator('#qSvc').selectOption('washer');
        assert.equal(await page.locator('#qSvcLinkNote').count(), 0);
      }
      await seed();
      await page.goto(base + '/index.html#quote');
      await page.reload();
      assert.equal(await page.locator('#qSvc').inputValue(), 'move-in');
      assert.deepEqual(errors, []);
      await context.close();

      const failed = await browser.newContext({viewport, serviceWorkers:'block'});
      await failed.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await failed.addInitScript(() => {
        if(location.hostname !== '127.0.0.1') return;
        localStorage.setItem('joinLater', JSON.stringify(Date.now()));
        history.replaceState = () => {throw new Error('blocked');};
      });
      const p = await failed.newPage();
      await p.goto(base + '/index.html');
      await p.evaluate(() => localStorage.setItem('quote', JSON.stringify({svc:'washer',v:0,qty:1,opts:[],area:'춘천'})));
      await p.goto(base + '/index.html?svc=move-in#quote');
      assert.equal(await p.locator('#qSvc').inputValue(), 'washer');
      assert.match(await p.locator('#qSvcLinkNote').innerText(), /자동 선택하지 못했어요.*서비스를 확인/);
      await p.locator('#qSvc').selectOption('office');
      await p.reload();
      assert.equal(await p.locator('#qSvc').inputValue(), 'office');
      assert.match(await p.locator('#qSvcLinkNote').innerText(), /자동 선택하지 못했어요.*서비스를 확인/);
      await failed.close();

      const blocked = await browser.newContext({viewport, serviceWorkers:'block'});
      await blocked.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await blocked.addInitScript(() => {
        if(location.hostname !== '127.0.0.1') return;
        localStorage.setItem('joinLater', JSON.stringify(Date.now()));
        if(!localStorage.getItem('quote')) localStorage.setItem('quote', JSON.stringify({svc:'move-in',v:0,t:0,opts:[],area:'춘천'}));
        window.originalStorageSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if(key === 'quote') throw new Error('storage blocked');
          return window.originalStorageSetItem.call(this, key, value);
        };
      });
      const q = await blocked.newPage();
      await q.goto(base + '/index.html?svc=aircon#quote');
      assert.equal(await q.locator('#qSvc').inputValue(), 'aircon');
      assert.match(await q.locator('#qStorageNote').innerText(), /저장되지 않아.*새로고침/);
      await q.locator('#qSvc').selectOption('washer');
      await q.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {window.testCopy = text;}}}));
      await q.locator('#qCopy').click();
      assert.match(await q.evaluate(() => window.testCopy), /서비스: 세탁기 청소/);
      await q.reload();
      assert.equal(await q.locator('#qSvc').inputValue(), 'move-in');
      assert.match(await q.locator('#qStorageNote').innerText(), /저장되지 않아.*새로고침/);
      await q.evaluate(() => { Storage.prototype.setItem = window.originalStorageSetItem; });
      await q.locator('#qSvc').selectOption('washer');
      assert.equal(await q.locator('#qStorageNote').count(), 0);
      await blocked.close();
      console.log('service link PASS ' + viewport.width);
    }
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exit(1);});
