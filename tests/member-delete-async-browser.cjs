const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:8765';
const source = fs.readFileSync('index.html', 'utf8');
const home = source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_, start, raw, end) => {
  const cfg = JSON.parse(raw); cfg.firebase = {}; cfg.memberBackendUrl = ''; cfg.kakao = 'https://example.test/chat'; cfg.blog = [];
  return start + JSON.stringify(cfg).replace(/<\//g, '<\\/') + end;
});

async function session(browser, viewport) {
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
    localStorage.setItem('member',JSON.stringify({name:'가상고객',phone:'01000000000',area:'가상',free:'가상',code:'OK-ABC234',ad:false}));
    window.copyMode='hold'; window.copyPending=[]; window.fakeClipboard=''; window.fakeExec=0;
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text => {
      if(window.copyMode==='hold') return new Promise((resolve,reject) => window.copyPending.push({resolve,reject}));
      window.fakeClipboard=text;
    }}});
    document.execCommand=() => { window.fakeExec++; return true; };
  });
  const page = await context.newPage(), errors=[]; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base+'/', {waitUntil:'load'});
  return {context,page,errors};
}
async function openJoin(p){await p.locator('[data-join]').first().click(); await p.locator('#jClearDevice').waitFor({state:'visible'});}
async function clear(p){let question='';p.once('dialog',d=>{question=d.message();d.accept();});await p.locator('#jClearDevice').click();assert.match(question,/클립보드.*지워지지/);}
const settle = p => p.waitForTimeout(80);
async function finish(s){assert.deepEqual(s.errors,[]);await s.context.close();}

(async () => {
  const browser=await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]) {
      // 삭제 중이던 브라우저 복사가 성공해도 이전 회원 안내를 열지 않습니다.
      {
        const s=await session(browser,viewport), p=s.page;
        await openJoin(p); await p.locator('#jKakao').click(); await p.waitForFunction(() => window.copyPending.length===1);
        await clear(p); assert.equal(await p.evaluate(() => localStorage.getItem('member')),null);
        await p.evaluate(() => window.copyPending[0].resolve()); await settle(p);
        assert.equal(await p.locator('#sheet').isHidden(),true); assert.doesNotMatch(await p.locator('#sheetB').innerText(),/가상고객/);
        assert.equal(await p.locator('#joinForm').isVisible(),true); await finish(s);
      }
      // 늦은 복사 거부 후에는 오래된 회원정보의 대체 복사도 실행하지 않습니다.
      {
        const s=await session(browser,viewport), p=s.page;
        await openJoin(p); await p.locator('#jKakao').click(); await p.waitForFunction(() => window.copyPending.length===1);
        await clear(p); await p.evaluate(() => window.copyPending[0].reject(Error('fake denied'))); await settle(p);
        assert.equal(await p.evaluate(() => window.fakeExec),0); assert.equal(await p.locator('#sheet').isHidden(),true); await finish(s);
      }
      // 같은 가입창을 닫았다 열어도 이전 복사는 새 방문을 덮지 않습니다.
      {
        const s=await session(browser,viewport), p=s.page;
        await openJoin(p); await p.locator('#jKakao').click(); await p.waitForFunction(() => window.copyPending.length===1);
        await p.keyboard.press('Escape'); await openJoin(p);
        await p.evaluate(() => window.copyPending[0].resolve()); await settle(p);
        assert.equal(await p.locator('#sheet').isHidden(),true); assert.equal(await p.locator('#joinDone').isVisible(),true); await finish(s);
      }
      // 같은 버튼의 새 요청이 먼저 완료되면 이전 요청은 화면을 다시 열지 않습니다.
      {
        const s=await session(browser,viewport), p=s.page;
        await openJoin(p); await p.locator('#jKakao').click(); await p.locator('#jKakao').click();
        await p.waitForFunction(() => window.copyPending.length===2);
        await p.evaluate(() => window.copyPending[1].resolve()); await p.locator('#sheet').waitFor({state:'visible'});
        await p.evaluate(() => {window.originalPre=document.querySelector('#sheetB pre');window.copyPending[0].reject(Error('fake old failure'));});
        await settle(p); assert.equal(await p.evaluate(() => window.fakeExec),0);
        assert.equal(await p.evaluate(() => window.originalPre===document.querySelector('#sheetB pre')),true); await finish(s);
      }
      // 숨겨진 이전 회원 안내는 지우되, 이후 새로운 회원 가입은 정상 동작합니다.
      {
        const s=await session(browser,viewport), p=s.page;
        await openJoin(p); await p.evaluate(() => {window.copyMode='allow';}); await p.locator('#jKakao').click();
        await p.locator('#sheet').waitFor({state:'visible'}); assert.match(await p.locator('#sheetB').innerText(),/가상고객/);
        await p.keyboard.press('Escape'); await openJoin(p); await clear(p);
        assert.doesNotMatch(await p.locator('#sheetB').textContent(),/가상고객|01000000000/);
        await p.locator('#jName').fill('새가상고객'); await p.locator('#jPhone').fill('01011112222'); await p.locator('#jAgree').check(); await p.locator('#jSubmit').click();
        await p.locator('#jKakao').click(); await p.locator('#sheet').waitFor({state:'visible'});
        assert.match(await p.locator('#sheetB').innerText(),/새가상고객/); await finish(s);
      }
      // 숨겨진 일반 카카오 안내는 회원정보 삭제 시 제거하지 않습니다.
      {
        const s=await session(browser,viewport), p=s.page;
        await p.evaluate(() => {window.copyMode='allow';});
        await p.evaluate(() => window.kakaoSend('가상 일반 안내','가상 일반 본문'));
        await p.locator('#sheet').waitFor({state:'visible'}); await p.keyboard.press('Escape');
        await openJoin(p); await clear(p);
        assert.match(await p.locator('#sheetB').textContent(),/가상 일반 본문/); await finish(s);
      }
      console.log('member delete async PASS ' + viewport.width);
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
