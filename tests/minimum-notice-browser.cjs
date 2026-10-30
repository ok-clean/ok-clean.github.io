const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync('index.html', 'utf8');
const home = source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_, start, raw, end) => {
  const cfg = JSON.parse(raw);
  cfg.firebase = {}; cfg.memberBackendUrl = ''; cfg.kakao = 'https://example.test/chat'; cfg.blog = [];
  return start + JSON.stringify(cfg).replace(/<\//g, '<\\/') + end;
});
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
      const context = await browser.newContext({viewport,serviceWorkers:'block'});
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
        localStorage.setItem('member', JSON.stringify({name:'가상고객',phone:'01000000000',code:'OK-ABC234',free:'가상'}));
        Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {window.fakeCopy=text;}}});
      });
      const page = await context.newPage(), errors=[];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://127.0.0.1:8765/',{waitUntil:'load'});
      await page.locator('#qSvc').selectOption('regular');
      await page.locator('#qQty').fill('1');
      assert.equal((await page.locator('#qV').innerText()).replace(/\s/g,''), '15만원');
      assert.match(await page.locator('#qN').innerText(), /옵션을 선택해도 표시 금액이 그대로일 수/);
      await page.locator('#qOpt input').first().check();
      assert.equal((await page.locator('#qV').innerText()).replace(/\s/g,''), '15만원');
      assert.match(await page.locator('#qN').innerText(), /할인 전 예상 금액은 기본 금액과 금액이 표시된 추가 옵션.*최소 금액 15만원.*옵션을 선택해도 표시 금액이 그대로일 수/s);
      assert.match(await page.locator('#qMem').innerText(), /회원가입 일시 중지/);
      await page.locator('#quote').screenshot({path:`/tmp/okclean-minimum-notice-${viewport.width}.png`});
      await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.fakeCopy), /추가: 냉장고 내부/);
      assert.match(await page.evaluate(() => window.fakeCopy), /예상 금액: 15만원/);
      assert.match(await page.evaluate(() => window.fakeCopy), /계산 안내: 할인 전 기본 금액과 금액이 표시된 옵션을 합산한 뒤 최소 금액 15만원/);
      // 상한은 최소금액을 초과할 수 있습니다.
      await page.locator('#qQty').fill('10');
      assert.equal((await page.locator('#qV').innerText()).replace(/\s/g,''), '15만~17만원');
      assert.match(await page.locator('#qN').innerText(), /그대로일 수/);
      // 합산한 하한이 정확히 최소금액인 경우에도 잘못된 원인 단정 없이 안내합니다.
      await page.locator('#qQty').fill('12');
      assert.equal((await page.locator('#qV').innerText()).replace(/\s/g,''), '15만~19.6만원');
      assert.match(await page.locator('#qN').innerText(), /합산한 뒤 최소 금액/);
      // 최소 기준을 넘어가면 안내가 사라지고 합산 금액이 표시됩니다.
      await page.locator('#qQty').fill('20');
      assert.equal((await page.locator('#qV').innerText()).replace(/\s/g,''), '23만~30만원');
      assert.doesNotMatch(await page.locator('#qN').innerText(), /할인 전 예상 금액은/);
      await page.locator('#qCopy').click();
      assert.doesNotMatch(await page.evaluate(() => window.fakeCopy), /계산 안내:/);
      // 현장견적 옵션은 추가 금액 합산이 아닌 별도 안내를 유지합니다.
      await page.locator('#qSvc').selectOption('office'); await page.locator('#qQty').fill('1');
      await page.locator('#qOpt input').first().check();
      assert.equal((await page.locator('#qV').innerText()).replace(/\s/g,''), '20만원~');
      assert.match(await page.locator('#qN').innerText(), /별도 현장 견적/);
      assert.match(await page.locator('#qN').innerText(), /할인 전 예상 금액은 기본 금액에 최소 금액 20만원/);
      assert.doesNotMatch(await page.locator('#qN').innerText(), /옵션을 선택해도 표시 금액/);
      await page.locator('#qCopy').click();
      assert.match(await page.evaluate(() => window.fakeCopy), /바닥 왁스 코팅 별도/);
      assert.doesNotMatch(await page.evaluate(() => window.fakeCopy), /계산 안내:/);
      // 수량 공란, 전체 현장견적과 정액형은 최소금액 설명을 보여주지 않습니다.
      await page.locator('#qQty').fill('');
      assert.match(await page.locator('#qN').innerText(), /수량을 입력/);
      assert.doesNotMatch(await page.locator('#qN').innerText(), /할인 전 예상 금액은/);
      await page.locator('#qSvc').selectOption('special-home');
      assert.doesNotMatch(await page.locator('#qN').innerText(), /할인 전 예상 금액은/);
      await page.locator('#qSvc').selectOption('move-in');
      assert.doesNotMatch(await page.locator('#qN').innerText(), /할인 전 예상 금액은/);
      assert.deepEqual(errors, []); await context.close();
      console.log(`minimum notice PASS ${viewport.width}`);
    }
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1);});
