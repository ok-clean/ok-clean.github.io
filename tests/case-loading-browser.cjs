const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const home = fs.readFileSync('index.html', 'utf8');
const linkFixtures = JSON.parse(fs.readFileSync('tests/case-link-fixtures.json', 'utf8'));
const url = 'http://127.0.0.1:8765/';
const fakeCases = Array.from({length: 10}, (_, i) => ({
  title: `가상 청소 사례 ${i + 1}`, link: `https://example.test/${i}`, date: `2026-01-${String(i + 1).padStart(2,'0')}`,
  svc: i === 0 ? 'washer' : 'aircon', region: '춘천', kind: 'case'
}));
fakeCases.push({title:'가상 청소 팁', link:'https://example.test/tip', date:'2026-01-11', kind:'tip'});

function withBlogs(blogs) {
  return home.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_, start, raw, end) => {
    const cfg = JSON.parse(raw);
    cfg.blog = blogs;
    cfg.sample = false;
    return start + JSON.stringify(cfg).replace(/<\//g, '<\\/') + end;
  });
}

async function visit(browser, viewport, payload, blogs = ['safe_blog', 'safe-blog2']) {
  const context = await browser.newContext({viewport, serviceWorkers:'block'});
  // 사례 스크롤 검사는 기존 회원가입 팝업과 독립적으로 실행합니다.
  await context.addInitScript(() => {
    if(location.hostname === '127.0.0.1') localStorage.setItem('joinLater', JSON.stringify(Date.now()));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', async route => {
    const parsed = new URL(route.request().url());
    if(parsed.hostname !== '127.0.0.1') return route.abort();
    if(parsed.pathname === '/') return route.fulfill({status:200, contentType:'text/html', body:withBlogs(blogs)});
    if(parsed.pathname === '/cases.json') {
      if(payload === 'network') return route.abort();
      if(payload === 'http') return route.fulfill({status:500, contentType:'text/plain', body:'unavailable'});
      if(payload === 'bad-json') return route.fulfill({status:200, contentType:'application/json', body:'{' });
      return route.fulfill({status:200, contentType:'application/json', body:JSON.stringify(payload)});
    }
    return route.continue();
  });
  await page.goto(url, {waitUntil:'domcontentloaded'});
  return {context, page, errors};
}

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:390,height:844}, {width:1440,height:900}]) {
      for(const payload of ['network', 'http', 'bad-json', {}, {cases:{}}, {cases:[null]}, {cases:[{title:42,link:'https://example.test'}]}, {cases:[{title:'가상',link:'https://example.test',date:42}]}]) {
        const {context, page, errors} = await visit(browser, viewport, payload, ['safe_blog','https://evil.test','bad/escape','evil" onclick="alert(1)','safe-blog2']);
        const notice = page.locator('#caseList [role="status"]');
        await notice.waitFor({state:'visible'});
        assert.match(await notice.innerText(), /불러오지 못했어요/);
        assert.deepEqual(await notice.locator('a').evaluateAll(a => a.map(x => x.href)), ['https://blog.naver.com/safe_blog', 'https://blog.naver.com/safe-blog2']);
        assert.equal(await notice.locator('img').count(), 0);
        assert.equal(await notice.locator('a').first().getAttribute('rel'), 'noopener noreferrer');
        assert.deepEqual(errors, []);
        await context.close();
      }
      {
        const {context, page} = await visit(browser, viewport, 'http', ['bad/id']);
        await page.locator('#caseList [role="status"]').waitFor({state:'visible'});
        assert.equal(await page.locator('#caseList a').count(), 0);
        await context.close();
      }
      {
        const {context, page} = await visit(browser, viewport, {cases:[]});
        await page.waitForFunction(() => document.querySelector('#cases').hidden);
        assert.equal(await page.locator('#caseList [role="status"]').count(), 0);
        await context.close();
      }
      {
        const {context, page} = await visit(browser, viewport, {cases:[fakeCases[10]]});
        await page.waitForFunction(() => document.querySelector('#cases').hidden && !document.querySelector('#tips').hidden);
        assert.match(await page.locator('#tipList').innerText(), /가상 청소 팁/);
        await context.close();
      }
      {
        const unsafe = linkFixtures.filter(x => !x.valid && typeof x.url === 'string')
          .flatMap((x, i) => ['case','tip'].map(kind => ({title:'위험한 링크 ' + i, link:x.url, kind, svc:'aircon', region:'춘천'})));
        const {context, page, errors} = await visit(browser, viewport, {cases:[...fakeCases, ...unsafe]});
        for(const item of linkFixtures) {
          assert.equal(await page.evaluate(url => safeCaseLink(url), item.url), item.valid, String(item.url));
        }
        await page.locator('#caseMore').waitFor({state:'visible'});
        assert.equal(await page.locator('#caseList a.case').count(), 8);
        await page.locator('#caseMore').click();
        assert.equal(await page.locator('#caseList a.case').count(), 10);
        await page.locator('#caseChips [data-f="washer"]').click();
        assert.equal(await page.locator('#caseList a.case').count(), 1);
        assert.match(await page.locator('#tipList').innerText(), /가상 청소 팁/);
        assert.doesNotMatch(await page.locator('#cases').innerText(), /위험한 링크/);
        assert.doesNotMatch(await page.locator('#tips').innerText(), /위험한 링크/);
        assert.deepEqual(errors, []);
        await context.close();
      }
      console.log('case loading PASS ' + viewport.width);
    }
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exit(1);});
