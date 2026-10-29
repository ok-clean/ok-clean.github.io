const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:8765';
const source = fs.readFileSync('index.html', 'utf8');
const home = source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_, start, raw, end) => {
  const cfg = JSON.parse(raw);
  cfg.firebase = {apiKey:'fake-test-identifier', projectId:'fake-test-project'};
  cfg.memberBackendUrl = ''; cfg.kakao = 'https://example.test/chat'; cfg.blog = [];
  return start + JSON.stringify(cfg).replace(/<\//g, '<\\/') + end;
});

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
      const context = await browser.newContext({viewport,serviceWorkers:'block',userAgent:'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'});
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if(url.hostname !== '127.0.0.1') return route.abort();
        if(url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({status:200,contentType:'text/html',body:home});
        if(url.pathname === '/cases.json') return route.fulfill({status:200,contentType:'application/json',body:'{"cases":[]}'});
        return route.continue();
      });
      await context.addInitScript(() => {
        if(location.hostname !== '127.0.0.1') return;
        localStorage.setItem('joinLater', JSON.stringify(Date.now()));
        Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {window.fakeCopy=text;}}});
      });
      const page = await context.newPage(), errors=[];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/', {waitUntil:'load'});
      await page.evaluate(() => {
        window.fakeKakao = null; window.fakeSms = null; window.fakeCopy = null;
        window.kakaoSend = (title, text) => {window.fakeKakao = text;};
        window.goSms = url => {window.fakeSms = url;};
      });
      await page.locator('#qSvc').selectOption('office');
      assert.equal(await page.locator('#qQty').inputValue(), '30', 'initial service default');
      await page.locator('#qQty').fill('');
      assert.equal(await page.locator('#qQty').inputValue(), '');
      assert.equal(await page.locator('#qQty').getAttribute('aria-invalid'), 'true');
      assert.match(await page.locator('#qQtyNote').innerText(), /입력/);
      assert.equal(await page.locator('#qV').innerText(), '수량 입력');
      assert.match(await page.locator('#qN').innerText(), /수량을 입력/);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('quote')).qty), '');
      await page.locator('#qOpt input').first().check();
      assert.equal(await page.locator('#qV').innerText(), '수량 입력', 'options do not produce a price without quantity');
      for(const button of ['#qCopy','#qKakao','#qSms']){
        await page.locator(button).click();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'qQty');
        assert.deepEqual(await page.evaluate(() => [window.fakeCopy,window.fakeKakao,window.fakeSms]), [null,null,null]);
      }
      await page.reload({waitUntil:'load'});
      assert.equal(await page.locator('#qSvc').inputValue(), 'office');
      assert.equal(await page.locator('#qQty').inputValue(), '', 'deliberately blank value persists');
      assert.equal(await page.locator('#qV').innerText(), '수량 입력');
      await page.evaluate(() => {window.fakeCopy=null;});
      // 정기 청소는 현장 견적이므로 숨겨진 수량 때문에 문의를 막지 않습니다.
      await page.locator('#qVar [data-v="1"]').click();
      assert.equal(await page.locator('#qQtyF').isHidden(), true);
      assert.equal(await page.locator('#qV').innerText(), '사진 보고 안내');
      await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.fakeCopy), /현장 사진/);
      // 수량형으로 되돌리면 사용자가 지운 수량이 유지됩니다.
      await page.locator('#qVar [data-v="0"]').click();
      assert.equal(await page.locator('#qQty').inputValue(), '');
      assert.equal(await page.locator('#qV').innerText(), '수량 입력');
      // 숫자 필드의 미완성 입력도 빈 수량으로 간주합니다.
      await page.locator('#qQty').focus();
      await page.keyboard.type('-');
      assert.equal(await page.locator('#qQty').inputValue(), '');
      assert.equal(await page.locator('#qV').innerText(), '수량 입력');
      await page.locator('#qQty').fill('8');
      assert.equal(await page.locator('#qQtyNote').count(), 0);
      assert.equal(await page.locator('#qQty').getAttribute('aria-invalid'), null);
      assert.notEqual(await page.locator('#qV').innerText(), '수량 입력');
      await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.fakeCopy), /8평/);
      // ±는 비운 입력에서 다시 1로 복구할 수 있습니다.
      await page.locator('#qQty').fill(''); await page.locator('#qPlus').click();
      assert.equal(await page.locator('#qQty').inputValue(), '1');
      await page.locator('#qQty').fill(''); await page.locator('#qMinus').click();
      assert.equal(await page.locator('#qQty').inputValue(), '1');
      // 현장 서비스 및 집 크기형은 수량과 무관하게 기존 문의가 됩니다.
      await page.locator('#qSvc').selectOption('special-home');
      assert.equal(await page.locator('#qQtyF').isHidden(), true);
      await page.evaluate(() => {window.fakeCopy=null;}); await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.fakeCopy), /현장 사진/);
      await page.locator('#qSvc').selectOption('move-in');
      assert.equal(await page.locator('#qQtyF').isHidden(), true);
      await page.evaluate(() => {window.fakeCopy=null;}); await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.fakeCopy), /예상 금액/);
      await page.locator('#qSvc').selectOption('regular');
      assert.equal(await page.locator('#qQty').inputValue(), '25', 'new service retains default quantity');
      await page.locator('#qQty').fill('');
      await page.evaluate(() => localStorage.setItem('member',JSON.stringify({name:'가상고객',code:'OK-ABC234',free:'가상'})));
      await page.reload({waitUntil:'load'});
      assert.equal(await page.locator('#qQty').inputValue(), '');
      assert.match(await page.locator('#qMem').innerText(), /수량을 입력하면 회원 쿠폰 적용 금액/);
      assert.equal(await page.locator('#qV').innerText(), '수량 입력');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`blank quantity PASS ${viewport.width}`);
    }
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exit(1);});
