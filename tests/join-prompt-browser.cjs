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
  const context = await browser.newContext({viewport, serviceWorkers:'block'});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if(url.hostname !== '127.0.0.1') return route.abort();
    if(url.pathname === '/' || url.pathname === '/index.html') return route.fulfill({status:200,contentType:'text/html',body:home});
    if(url.pathname === '/cases.json') return route.fulfill({status:200,contentType:'application/json',body:'{"cases":[]}'});
    return route.continue();
  });
  await context.addInitScript(opts => {
    if(location.hostname !== '127.0.0.1') return;
    if(opts.member) localStorage.setItem('member', JSON.stringify({name:'가상고객',phone:'01000000000',code:'OK-ABC234',free:'가상'}));
    if(opts.later) localStorage.setItem('joinLater', JSON.stringify(Date.now()));
    if(opts.laterAge) localStorage.setItem('joinLater', JSON.stringify(Date.now() - opts.laterAge));
    if(opts.blockLater){
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value){ if(key === 'joinLater') throw Error('synthetic blocked storage'); return set.call(this,key,value); };
    }
    window.fakeHidden = !!opts.hidden;
    Object.defineProperty(document, 'hidden', {configurable:true,get(){return window.fakeHidden;}});
  }, options);
  const page = await context.newPage();
  await page.clock.install({time:new Date('2026-10-28T12:00:00Z')});
  const errors=[];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/' + (options.search || ''), {waitUntil:'load'});
  return {context,page,errors};
}
const visible = page => page.evaluate(() => !$('join').hidden);
const advance = (page, ms) => page.clock.runFor(ms);
const act = (page, kind, target='document') => page.evaluate(({kind,target}) => {
  const el = target === 'window' ? window : target === 'quote' ? $('quote') : document;
  el.dispatchEvent(new Event(kind, {bubbles:true}));
}, {kind,target});
async function done(s){ assert.deepEqual(s.errors, []); await s.context.close(); }

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]) {
      {
        const s = await session(browser,viewport);
        await advance(s.page,1000);
        // 고정된 스크롤 위치와 이벤트로 조기 팝업 조건을 재현합니다.
        // 실제 부드러운 스크롤 애니메이션은 뒤늦은 추가 scroll을 발생시켜
        // 가상 시계의 정확한 무활동 경계 테스트를 흔들 수 있습니다.
        await s.page.evaluate(() => Object.defineProperty(window, 'scrollY', {configurable:true, value:document.body.scrollHeight}));
        await act(s.page,'scroll','window');
        assert.equal(await visible(s.page),false, 'scroll must not trigger immediate popup');
        await advance(s.page,23000);
        await act(s.page,'pointerdown');
        await advance(s.page,1000);
        assert.equal(await visible(s.page),false, 'activity prevents popup at initial deadline');
        await advance(s.page,14000);
        assert.equal(await visible(s.page),true, 'popup opens after 15 seconds idle');
        assert.ok(await s.page.evaluate(() => Number(JSON.parse(localStorage.getItem('joinLater'))) > 0));
        await s.page.evaluate(() => closeModal($('join')));
        await advance(s.page,30000);
        assert.equal(await visible(s.page),false, 'popup opens only once per page');
        await done(s);
      }
      {
        const s = await session(browser,viewport,{search:'?ref=OK-ABC234'});
        await advance(s.page,3999);
        assert.equal(await visible(s.page),false);
        await advance(s.page,1);
        assert.equal(await visible(s.page),true, 'referral still opens at four seconds when idle');
        assert.match(await s.page.locator('#jRef').innerText(), /OK-ABC234/);
        await done(s);
      }
      {
        const s = await session(browser,viewport,{search:'?ref=OK-ABC234'});
        await advance(s.page,3000); await act(s.page,'input','quote');
        await advance(s.page,1000);
        assert.equal(await visible(s.page),false, 'quote use defers referral popup');
        await advance(s.page,14000);
        assert.equal(await visible(s.page),true);
        await done(s);
      }
      for(const kind of ['click','scroll']) {
        const s = await session(browser,viewport);
        await advance(s.page,24000);
        if(kind === 'click') await act(s.page,'click','quote');
        else await s.page.evaluate(() => $('quote').dispatchEvent(new Event('scroll')));
        await advance(s.page,1000);
        assert.equal(await visible(s.page),false, `${kind} interaction defers the popup`);
        await advance(s.page,14000);
        assert.equal(await visible(s.page),true);
        await done(s);
      }
      for(const option of [{member:true},{later:true},{search:'?src=app'}]) {
        const s = await session(browser,viewport,option);
        await advance(s.page,45000);
        assert.equal(await visible(s.page),false, 'member/later/app suppression');
        await done(s);
      }
      {
        const s = await session(browser,viewport,{laterAge:8*864e5});
        await advance(s.page,25000);
        assert.equal(await visible(s.page),true, 'popup returns after the seven-day postponement');
        await done(s);
      }
      for(const close of ['close','later']) {
        const s = await session(browser,viewport,{blockLater:true});
        await s.page.evaluate(() => document.querySelector('[data-join]').click());
        assert.equal(await visible(s.page),true, 'manual join remains available');
        await s.page.evaluate(mode => document.querySelector(mode === 'later' ? '#join [data-later]' : '#join [data-close]').click(), close);
        await advance(s.page,45000);
        assert.equal(await visible(s.page),false, 'manual join cancels pending automatic popup even if storage is blocked');
        await done(s);
      }
      {
        const s = await session(browser,viewport,{hidden:true});
        await advance(s.page,30000);
        assert.equal(await visible(s.page),false, 'hidden tab never opens popup');
        await s.page.evaluate(() => { window.fakeHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
        await advance(s.page,14999);
        assert.equal(await visible(s.page),false);
        await advance(s.page,1);
        assert.equal(await visible(s.page),true, 'visible tab gets a quiet period');
        await done(s);
      }
      {
        const s = await session(browser,viewport,{hidden:true});
        await advance(s.page,24000);
        await s.page.evaluate(() => { window.fakeHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
        await advance(s.page,1000);
        assert.equal(await visible(s.page),false, 'returning before deadline also starts a quiet period');
        await advance(s.page,14000);
        assert.equal(await visible(s.page),true);
        await done(s);
      }
      {
        const s = await session(browser,viewport);
        await s.page.evaluate(() => openModal('sheet'));
        await advance(s.page,45000);
        assert.equal(await visible(s.page),false, 'other dialog must not be covered');
        await s.page.evaluate(() => closeModal($('sheet')));
        await advance(s.page,45000);
        assert.equal(await visible(s.page),false, 'other dialog does not cause delayed surprise');
        await done(s);
      }
      for(const key of ['joinLater','member']) {
        const s = await session(browser,viewport);
        await s.page.evaluate(key => localStorage.setItem(key, JSON.stringify(key === 'joinLater' ? Date.now() : {name:'가상'})), key);
        await advance(s.page,45000);
        assert.equal(await visible(s.page),false, 'latest shared storage state is respected');
        await done(s);
      }
    }
    console.log('Join popup timing regression passed at mobile and desktop widths.');
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exit(1);});
