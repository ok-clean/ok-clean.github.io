const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:8765';
const source = fs.readFileSync('index.html', 'utf8');
const home = source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_, start, raw, end) => {
  const cfg = JSON.parse(raw);
  cfg.firebase = {}; cfg.memberBackendUrl = ''; cfg.kakao = 'https://example.test/chat'; cfg.blog = [];
  return start + JSON.stringify(cfg).replace(/<\//g, '<\\/') + end;
});

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844}, {width:1440,height:900}]) {
      const context = await browser.newContext({viewport, serviceWorkers:'block'});
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
        window.copyMode = 'deny'; window.fakeClipboard = ''; window.execCount = 0;
        Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async text => {
          if(window.copyMode === 'hold') return await new Promise((resolve,reject) => {window.resolveCopy=resolve; window.rejectCopy=reject;});
          if(window.copyMode === 'deny' || window.copyMode === 'fallback' || window.copyMode === 'throw') throw Error('fake clipboard denied');
          window.fakeClipboard = text;
        }}});
        document.execCommand = command => {
          if(command !== 'copy') return false;
          window.execCount++;
          if(window.copyMode === 'throw') throw Error('fake fallback denied');
          if(window.copyMode === 'fallback') {window.fakeClipboard=document.activeElement.value; return true;}
          return false;
        };
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base+'/', {waitUntil:'load'});
      await page.evaluate(() => { window.SITE.kakao = 'https://example.test/chat'; });
      await page.locator('#qKakao').click();
      const sheet = page.locator('#sheet'), status = sheet.locator('[data-copy-status]'), again = sheet.locator('[data-copy-again]');
      await sheet.waitFor({state:'visible'});
      await page.waitForTimeout(100); // 대화상자의 초기 포커스 이동을 마친 뒤 검사합니다.
      assert.match(await status.innerText(), /자동 복사하지 못했어요/);
      assert.equal(await status.getAttribute('role'), 'status');
      assert.equal(await sheet.locator('a[href="https://example.test/chat"]').isVisible(), true);
      const original = await sheet.locator('.send-pre').innerText();
      assert.match(original, /견적 문의/);
      await again.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-copy-status]')?.textContent.startsWith('복사하지 못했어요.'));
      assert.match(await status.innerText(), /선택해 복사/);
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-copy-again')), true);
      assert.equal(await sheet.locator('.send-pre').innerText(), original);
      await page.evaluate(() => {window.copyMode='fallback';});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-copy-status]')?.textContent.includes('복사했어요'));
      assert.equal(await page.evaluate(() => window.fakeClipboard), original);
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-copy-again')), true);
      assert.equal(await again.isVisible(), true);
      assert.equal(await sheet.locator('a[href="https://example.test/chat"]').isVisible(), true);

      // 늦게 실패한 이전 재시도가 나중에 성공한 재시도의 상태를 덮지 않습니다.
      await page.evaluate(() => {window.copyMode='hold'; window.rejectCopy=null;});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => typeof window.rejectCopy === 'function');
      await page.evaluate(() => {window.copyMode='allow'; window.fakeClipboard='';});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.fakeClipboard !== '');
      const priorExec = await page.evaluate(() => window.execCount);
      await page.evaluate(() => {window.copyMode='fallback'; window.rejectCopy(Error('fake stale failure'));});
      await page.waitForTimeout(50);
      assert.match(await status.innerText(), /복사했어요/);
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-copy-again')), true);
      assert.equal(await page.evaluate(() => window.execCount), priorExec, 'stale failure must not execute fallback');

      await page.evaluate(() => {window.copyMode='throw';});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-copy-status]')?.textContent.includes('복사하지 못했어요.'));
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-copy-again')), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.closest('#sheet') !== null), true);
      await page.keyboard.press('Escape');
      assert.equal(await sheet.isHidden(), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'qKakao');

      // 가입 경로의 가짜 정보와 복사 실패 후 성공 흐름도 유지합니다.
      await page.locator('[data-join]').first().click();
      await page.locator('#jName').fill('가상고객'); await page.locator('#jPhone').fill('01000000000');
      await page.locator('#jAgree').check(); await page.locator('#jSubmit').click();
      await page.locator('#jKakao').click();
      await page.waitForTimeout(100);
      assert.match(await sheet.locator('.send-pre').innerText(), /가상고객/);
      await again.focus(); await page.evaluate(() => {window.copyMode='allow';});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-copy-status]')?.textContent.includes('복사했어요'));
      assert.match(await page.evaluate(() => window.fakeClipboard), /가상고객/);
      await page.keyboard.press('Escape');

      // 공통 공유 창에서 임시 복사 칸 사용 후에도 버튼 포커스를 유지합니다.
      await page.evaluate(() => {window.copyMode='deny';});
      await page.locator('[data-share]').first().click();
      await page.waitForTimeout(100);
      const shareCopy = sheet.locator('[data-copy-link]');
      await shareCopy.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-copy-link')), true);
      await page.keyboard.press('Escape');

      // 지연된 이전 실패가 새 모달의 상태·초점을 건드리지 않습니다.
      await page.evaluate(() => {window.copyMode='deny';});
      await page.locator('#qKakao').click(); await again.focus();
      await page.evaluate(() => {window.copyMode='hold'; window.resolveCopy=null; window.rejectCopy=null;});
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => typeof window.rejectCopy === 'function');
      await page.keyboard.press('Escape');
      await page.evaluate(async () => {window.copyMode='allow'; await window.kakaoSend('새 안내', '가짜 <내용> & 문자');});
      await sheet.waitFor({state:'visible'});
      await page.waitForTimeout(100);
      assert.equal(await sheet.locator('.send-pre').textContent(), '가짜 <내용> & 문자');
      assert.equal(await sheet.locator('.send-pre').locator('내용').count(), 0);
      const close = sheet.locator('.x'); await close.focus();
      const beforeLateExec = await page.evaluate(() => window.execCount);
      await page.evaluate(() => {window.copyMode='fallback'; window.rejectCopy(Error('fake late failure'));});
      await page.waitForTimeout(100);
      assert.match(await status.innerText(), /복사해 두었어요/);
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#sheet .x')), true);
      assert.equal(await page.evaluate(() => window.execCount), beforeLateExec, 'closed sheet must not execute fallback');
      await page.keyboard.press('Escape');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('kakao copy retry PASS ' + viewport.width);
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exit(1);});
