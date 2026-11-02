const {chromium} = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844}, {width:1440,height:900}]) {
      const context = await browser.newContext({viewport, serviceWorkers:'block'});
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await context.addInitScript(() => {
        if(location.hostname === '127.0.0.1') localStorage.setItem('joinLater', JSON.stringify(Date.now()));
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto((process.env.OKCLEAN_TEST_BASE || 'http://127.0.0.1:8765') + '/', {waitUntil:'load'});

      // 종류는 Tab으로 이동하여 Space로 선택하고 다음 선택지로 계속 이동할 수 있습니다.
      await page.locator('#qSvc').selectOption('move-in');
      await page.locator('#qSvc').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.v), '0');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.v), '1');
      await page.keyboard.press('Space');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.v), '1');
      assert.equal(await page.locator('#qVar [data-v="1"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#qVar [data-v="0"]').getAttribute('aria-pressed'), 'false');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.t), '0');

      // 집 크기는 Enter로 선택해도 같은 버튼에 남고, 선택값과 금액이 갱신됩니다.
      const beforePrice = await page.locator('#qV').innerText();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.t), '0');
      assert.equal(await page.locator('#qTier [data-t="0"]').getAttribute('aria-pressed'), 'true');
      assert.notEqual(await page.locator('#qV').innerText(), beforePrice);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.t), '1');
      await page.keyboard.press('Space');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.t), '1');
      assert.equal(await page.locator('#qTier [data-t="1"]').getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.t), '0');

      // 한 그룹 선택이 다른 그룹도 다시 그리므로, 그곳에 있던 포커스도 유지합니다.
      await page.locator('#qVar [data-v="0"]').evaluate(el => el.click());
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.t), '0');
      assert.equal(await page.locator('#qVar [data-v="0"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#qOpt [data-o="0"]').focus();
      await page.locator('#qTier [data-t="1"]').evaluate(el => el.click());
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.o), '0');
      assert.equal(await page.locator('#qTier [data-t="1"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#qMem [data-join]').focus();
      await page.locator('#qVar [data-v="1"]').evaluate(el => el.click());
      assert.equal(await page.evaluate(() => document.activeElement?.matches('#qMem [data-join]')), true);

      // 버튼 안의 글자를 마우스로 눌러도 일반적인 버튼 클릭과 같습니다.
      await page.locator('#qTier [data-t="2"] b').click();
      assert.equal(await page.locator('#qTier [data-t="2"]').getAttribute('aria-pressed'), 'true');

      // 다른 입력에 포커스가 있을 때 발생한 프로그래밍 클릭은 포커스를 빼앗지 않습니다.
      await page.locator('#qArea').focus();
      await page.locator('#qTier [data-t="2"]').evaluate(el => el.click());
      assert.equal(await page.evaluate(() => document.activeElement.id), 'qArea');
      assert.equal(await page.locator('#qTier [data-t="2"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#qVar [data-v="0"]').evaluate(el => el.click());
      assert.equal(await page.evaluate(() => document.activeElement.id), 'qArea');
      assert.equal(await page.locator('#qVar [data-v="0"]').getAttribute('aria-pressed'), 'true');

      // 다른 서비스로 바꾼 뒤 숨겨진 집 크기 그룹이 포커스를 가로채지 않습니다.
      await page.locator('#qSvc').selectOption('regular');
      await page.locator('#qVar [data-v="1"]').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.v), '1');
      assert.equal(await page.locator('#qVar [data-v="1"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#qTierF').isHidden(), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'qMinus');

      assert.deepEqual(errors, []);
      await context.close();
      console.log(`quote focus PASS ${viewport.width}`);
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exit(1);});
