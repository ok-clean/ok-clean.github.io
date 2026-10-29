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
        await page.evaluate(value => localStorage.setItem('quote', JSON.stringify({svc:'aircon', v:0, t:null, qty:value, opts:[]})), saved);
        await page.reload({waitUntil: 'domcontentloaded'});
        assert.equal(await page.locator('#qQty').inputValue(), expected);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('quote')).qty), Number(expected));
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
      let memberModuleRequested, releaseMemberModule;
      const memberModulePending = new Promise(resolve => { memberModuleRequested = resolve; });
      await page.route('**/member-sync.js', async route => {
        memberModuleRequested();
        await new Promise(resolve => { releaseMemberModule = resolve; });
        await route.fulfill({status: 200, contentType: 'application/javascript',
          body: 'export async function submitMember(config, member) { window.fakeSubmittedMember = member; }'});
      });
      await page.locator('[data-join]').first().click();
      await page.waitForFunction(() => document.activeElement.id === 'jName');
      await page.locator('#join button.x').focus();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('#join')), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.matches('#join button.x')), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.matches('[data-join]')), true);
      await page.locator('[data-join]').first().click();
      await page.locator('#jSubmit').click();
      assert.match(await page.locator('#jErr').innerText(), /이름/);
      await page.locator('#jName').fill('테스트');
      await page.locator('#jPhone').fill('01000000000');
      await page.locator('#jSubmit').click();
      assert.match(await page.locator('#jErr').innerText(), /동의/);
      await page.locator('#jAgree').check();
      await page.locator('#jSubmit').click();
      await page.locator('#joinDone').waitFor({state: 'visible'});
      await Promise.race([memberModulePending, new Promise((_, reject) => setTimeout(() => reject(new Error('member test module did not load')), 5000))]);
      assert.match(await page.locator('#joinDone').innerText(), /카톡.*가입.*확인|카톡.*가입.*완료|가입 내용을 카톡/);
      assert.match(await page.locator('#joinDone').innerText(), /1만원/);
      assert.ok((await page.locator('#jClearDevice').boundingBox()).height >= 44, 'mobile touch target');
      await page.screenshot({path: `/tmp/okclean-member-privacy-${viewport.width}.png`});
      await page.locator('#join button.x').click();
      await page.evaluate(() => Object.defineProperty(navigator, 'share', {
        configurable: true, value: async ({url}) => { window.fakeSharedUrl = url; }
      }));
      await page.locator('[data-share]').first().click();
      const savedCode = await page.evaluate(() => JSON.parse(localStorage.getItem('member')).code);
      assert.equal(await page.evaluate(() => new URL(window.fakeSharedUrl).searchParams.get('ref')), savedCode);
      await page.locator('[data-join]').first().click();
      await page.waitForFunction(() => document.activeElement.id === 'jKakao');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.matches('[data-join]')), true);

      // Clearing local member data is opt-in; it never claims to delete the server record.
      await page.locator('[data-join]').first().click();
      await page.waitForFunction(() => document.activeElement.id === 'jKakao');
      const savedMember = await page.evaluate(() => {
        localStorage.setItem('privacy-test-unrelated', 'keep');
        return localStorage.getItem('member');
      });
      let confirmation = '';
      page.once('dialog', dialog => { confirmation = dialog.message(); return dialog.dismiss(); });
      await page.locator('#jClearDevice').click();
      assert.match(confirmation, /관리자에게.*접수된 정보.*지워지지/);
      assert.equal(await page.evaluate(() => localStorage.getItem('member')), savedMember);
      assert.equal(await page.locator('#joinDone').isVisible(), true);

      await page.evaluate(() => {
        window.originalRemoveItem = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function(key) {
          if (key === 'member') throw new Error('storage blocked');
          return window.originalRemoveItem.call(this, key);
        };
      });
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#jClearDevice').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('member')), savedMember);
      assert.equal(await page.locator('#joinDone').isVisible(), true);
      await page.evaluate(() => { Storage.prototype.removeItem = window.originalRemoveItem; delete window.originalRemoveItem; });

      page.once('dialog', dialog => dialog.accept());
      await page.locator('#jClearDevice').click();
      assert.equal(await page.evaluate(() => localStorage.getItem('member')), null);
      assert.equal(await page.evaluate(() => localStorage.getItem('privacy-test-unrelated')), 'keep');
      assert.equal(await page.locator('#joinForm').isVisible(), true);
      assert.equal(await page.locator('#jName').inputValue(), '');
      assert.equal(await page.locator('#jPhone').inputValue(), '');
      assert.equal(await page.locator('#jAgree').isChecked(), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'jName');
      assert.match(await page.locator('#qMem').innerText(), /회원가입/);
      releaseMemberModule();
      await page.waitForFunction(() => !!window.fakeSubmittedMember);
      assert.equal(await page.evaluate(() => window.fakeSubmittedMember.name), '테스트');
      await page.waitForTimeout(50);
      assert.doesNotMatch(await page.locator('.toast').innerText(), /접수 요청이 완료/);
      await page.keyboard.press('Escape');
      await page.evaluate(() => { window.fakeSharedUrl = ''; });
      await page.locator('[data-share]').first().click();
      assert.equal(await page.evaluate(() => new URL(window.fakeSharedUrl).searchParams.get('ref')), null);
      assert.equal(await page.evaluate(() => new URL(window.fakeSharedUrl).searchParams.get('src')), 'share');
      await page.reload({waitUntil: 'domcontentloaded'});
      assert.equal(await page.evaluate(() => localStorage.getItem('member')), null);
      await page.locator('[data-join]').first().click();
      assert.equal(await page.locator('#joinForm').isVisible(), true);
      assert.equal(await page.locator('#jPhone').inputValue(), '');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal overflow');
      await page.goto('http://127.0.0.1:8765/privacy.html', {waitUntil: 'domcontentloaded'});
      const privacyText = await page.locator('main').innerText();
      if (config.member && config.firebase && config.firebase.apiKey && config.firebase.projectId) {
        assert.match(privacyText, /Firebase의 Cloud Firestore/);
      } else {
        assert.doesNotMatch(privacyText, /Firebase의 Cloud Firestore/);
      }
      if (config.member) assert.match(privacyText, /이 기기의 회원정보 지우기/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'privacy page overflow');
      await page.locator('main').screenshot({path: `/tmp/okclean-privacy-notice-${viewport.width}.png`});
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(err => {console.error(err);process.exit(1)});
