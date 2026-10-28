const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:8765';
const source = fs.readFileSync('index.html', 'utf8');
const home = source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_, start, raw, end) => {
  const cfg = JSON.parse(raw);
  cfg.firebase = {apiKey:'fake-test-identifier', projectId:'fake-test-project'};
  cfg.memberBackendUrl = '';
  cfg.kakao = 'https://example.test/chat';
  cfg.blog = [];
  return start + JSON.stringify(cfg).replace(/<\//g, '<\\/') + end;
});

async function session(browser, viewport, options={}) {
  const context = await browser.newContext({viewport,serviceWorkers:'block'});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if(url.hostname !== '127.0.0.1') return route.abort();
    if(url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({status:200,contentType:'text/html',body:home});
    if(url.pathname === '/cases.json') return route.fulfill({status:200,contentType:'application/json',body:'{"cases":[]}'});
    if(url.pathname === '/member-sync.js') return route.fulfill({status:200,contentType:'application/javascript',body:'export function submitMember(config, member){window.fakeMember=member;return Promise.resolve()}'});
    return route.continue();
  });
  await context.addInitScript(opts => {
    if(location.hostname !== '127.0.0.1') return;
    localStorage.setItem('joinLater', JSON.stringify(Date.now()));
    if(!sessionStorage.getItem('test-seeded')){
      if(opts.old) localStorage.setItem('ref', JSON.stringify(opts.old));
      if(opts.member) localStorage.setItem('member', JSON.stringify({name:'가상고객',phone:'01000000000',code:opts.member,free:'가상'}));
      sessionStorage.setItem('test-seeded', '1');
    }
    const set = Storage.prototype.setItem, get = Storage.prototype.getItem, remove = Storage.prototype.removeItem;
    window.refReadBlocked = !!opts.blockRead;
    Storage.prototype.setItem = function(key,value){ if(key === 'ref' && opts.blockWrite) throw Error('fake write denied'); return set.call(this,key,value); };
    Storage.prototype.getItem = function(key){ if(key === 'ref' && window.refReadBlocked) throw Error('fake read denied'); return get.call(this,key); };
    Storage.prototype.removeItem = function(key){ if(key === 'ref' && opts.blockRemove) throw Error('fake remove denied'); return remove.call(this,key); };
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.fakeCopy=text;}}});
  }, options);
  const page = await context.newPage(), errors=[];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/' + (options.search || ''), {waitUntil:'load'});
  return {context,page,errors};
}
async function finish(s){assert.deepEqual(s.errors, []);await s.context.close();}
async function openJoin(page){await page.locator('[data-join]').first().click();await page.locator('#joinForm').waitFor({state:'visible'});}
async function submit(page){
  await page.locator('#jName').fill('가상고객');
  await page.locator('#jPhone').fill('01000000000');
  await page.locator('#jAgree').check();
  await page.locator('#jSubmit').click();
  await page.waitForFunction(() => !!window.fakeMember);
}

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]) {
      // 새 링크 쓰기 실패와 이전값 삭제 실패: 기존 코드가 현재 문의·가입에 섞이지 않습니다.
      {
        const s=await session(browser,viewport,{old:'OK-OLD234',search:'?ref=OK-NEW234',blockWrite:true,blockRemove:true});
        assert.match(await s.page.locator('#qRefNote').innerText(), /저장했는지 확인하지 못했어요.*이전 코드/s);
        await s.page.locator('#qCopy').click();
        assert.match(await s.page.evaluate(() => window.fakeCopy), /추천인 코드: OK-NEW234/);
        assert.doesNotMatch(await s.page.evaluate(() => window.fakeCopy), /OK-OLD234/);
        await openJoin(s.page);
        assert.match(await s.page.locator('#jRef').innerText(), /OK-NEW234.*가입 요청에 함께 담겨요/s);
        assert.match(await s.page.locator('#jRef').innerText(), /저장했는지 확인하지 못했어요/);
        await s.page.reload({waitUntil:'load'});
        await s.page.locator('#qCopy').click();
        assert.match(await s.page.evaluate(() => window.fakeCopy), /추천인 코드: OK-NEW234/);
        await openJoin(s.page);
        assert.match(await s.page.locator('#jRef').innerText(), /OK-NEW234/);
        await submit(s.page);
        assert.equal(await s.page.evaluate(() => window.fakeMember.ref), 'OK-NEW234');
        assert.equal(await s.page.evaluate(() => JSON.parse(localStorage.getItem('member')).ref), 'OK-NEW234');
        await s.page.locator('#jKakao').click();
        assert.match(await s.page.evaluate(() => window.fakeCopy), /추천인 코드: OK-NEW234/);
        assert.doesNotMatch(await s.page.evaluate(() => window.fakeCopy), /OK-OLD234/);
        await finish(s);
      }
      // 읽기·쓰기 모두 차단돼도 현재 링크를 사용하고, 저장 불가를 알립니다.
      {
        const s=await session(browser,viewport,{old:'OK-OLD234',search:'?ref=OK-NEW234',blockWrite:true,blockRead:true,blockRemove:true});
        await s.page.locator('#qCopy').click();
        assert.match(await s.page.evaluate(() => window.fakeCopy), /추천인 코드: OK-NEW234/);
        assert.match(await s.page.locator('#qRefNote').innerText(), /이전 코드/);
        await openJoin(s.page); await submit(s.page);
        assert.equal(await s.page.evaluate(() => window.fakeMember.ref), 'OK-NEW234');
        await finish(s);
      }
      // 새 링크 저장 실패지만 옛값 제거는 가능한 경우: 다음 화면에 과거값이 남지 않습니다.
      {
        const s=await session(browser,viewport,{old:'OK-OLD234',search:'?ref=OK-NEW234',blockWrite:true});
        assert.equal(await s.page.evaluate(() => localStorage.getItem('ref')), null);
        assert.match(await s.page.locator('#qRefNote').innerText(), /다른 페이지로 이동하면 코드가 사라질 수/);
        assert.doesNotMatch(await s.page.locator('#qRefNote').innerText(), /이전 코드/);
        await s.page.goto(base + '/', {waitUntil:'load'});
        await s.page.locator('#qCopy').click();
        assert.doesNotMatch(await s.page.evaluate(() => window.fakeCopy), /추천인 코드/);
        await finish(s);
      }
      // 쓰기는 되나 읽기가 막힌 경우: 새 코드 삭제 없이 현재 요청에 사용하고 불확실성을 알립니다.
      {
        const s=await session(browser,viewport,{old:'OK-OLD234',search:'?ref=OK-NEW234',blockRead:true});
        assert.match(await s.page.locator('#qRefNote').innerText(), /저장했는지 확인하지 못했어요/);
        await s.page.evaluate(() => {window.refReadBlocked=false;});
        assert.equal(await s.page.evaluate(() => JSON.parse(localStorage.getItem('ref'))), 'OK-NEW234');
        await openJoin(s.page); await submit(s.page);
        assert.equal(await s.page.evaluate(() => window.fakeMember.ref), 'OK-NEW234');
        await finish(s);
      }
      // 정상 저장 후 URL 없는 재방문에도 적용됩니다.
      {
        const s=await session(browser,viewport,{search:'?ref=ok-new234'});
        assert.equal(await s.page.locator('#qRefNote').count(), 0);
        assert.equal(await s.page.evaluate(() => JSON.parse(localStorage.getItem('ref'))), 'OK-NEW234');
        await s.page.goto(base + '/', {waitUntil:'load'});
        await s.page.locator('#qCopy').click();
        assert.match(await s.page.evaluate(() => window.fakeCopy), /추천인 코드: OK-NEW234/);
        await finish(s);
      }
      // 비었거나 형식이 틀렸거나 중복된 URL은 이전 값으로 몰래 대체하지 않습니다.
      for(const search of ['?ref=', '?ref=invalid', '?ref=OK-NEW234&ref=OK-OLD234']) {
        const s=await session(browser,viewport,{old:'OK-OLD234',search});
        await s.page.locator('#qCopy').click();
        assert.doesNotMatch(await s.page.evaluate(() => window.fakeCopy), /추천인 코드/);
        assert.match(await s.page.locator('#qRefNote').innerText(), /확인할 수 없어요.*이전 코드/s);
        assert.equal(await s.page.evaluate(() => JSON.parse(localStorage.getItem('ref'))), 'OK-OLD234');
        await openJoin(s.page); await submit(s.page);
        assert.equal(await s.page.evaluate(() => window.fakeMember.ref), '');
        await finish(s);
      }
      // 본인 링크는 보류하며 삭제 후 가입을 진행해도 그 링크가 추천되지 않습니다.
      {
        const s=await session(browser,viewport,{old:'OK-OLD234',member:'OK-NEW234',search:'?ref=OK-NEW234'});
        assert.match(await s.page.locator('#qRefNote').innerText(), /본인의 추천인 코드는 적용할 수 없어요/);
        await s.page.locator('[data-join]').first().click();
        s.page.once('dialog', dialog => dialog.accept());
        await s.page.locator('#jClearDevice').click();
        await submit(s.page);
        assert.equal(await s.page.evaluate(() => window.fakeMember.ref), '');
        await finish(s);
      }
      // URL 없는 방문에서 저장된 코드가 현재 회원 자신의 코드라면 적용하지 않습니다.
      {
        const s=await session(browser,viewport,{old:'OK-NEW234',member:'OK-NEW234'});
        await s.page.locator('[data-join]').first().click();
        s.page.once('dialog', dialog => dialog.accept());
        await s.page.locator('#jClearDevice').click();
        await submit(s.page);
        assert.equal(await s.page.evaluate(() => window.fakeMember.ref), '');
        await finish(s);
      }
      // 잘못된 링크는 이전 값을 유지하고, 링크 없는 새 방문에서만 다시 복원합니다.
      {
        const s=await session(browser,viewport,{old:'OK-OLD234',search:'?ref=invalid'});
        assert.match(await s.page.locator('#qRefNote').innerText(), /이전 코드/);
        await s.page.goto(base + '/', {waitUntil:'load'});
        await s.page.locator('#qCopy').click();
        assert.match(await s.page.evaluate(() => window.fakeCopy), /추천인 코드: OK-OLD234/);
        await finish(s);
      }
      // URL 없는 방문은 유효한 예전 코드만 사용합니다.
      for(const [old,expected] of [['OK-OLD234',true],['junk',false],['',false]]) {
        const s=await session(browser,viewport,{old});
        await s.page.locator('#qCopy').click();
        assert.equal(/추천인 코드:/.test(await s.page.evaluate(() => window.fakeCopy)), expected);
        await finish(s);
      }
      console.log('referral PASS ' + viewport.width);
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
