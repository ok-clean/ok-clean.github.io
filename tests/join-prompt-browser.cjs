const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base='http://127.0.0.1:8765';
const source=fs.readFileSync('index.html','utf8');
const home=source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,start,raw,end)=>{const cfg=JSON.parse(raw);cfg.firebase={apiKey:'fake-test-identifier',projectId:'fake-test-project'};cfg.memberBackendUrl='';cfg.kakao='https://example.test/chat';cfg.blog=[];return start+JSON.stringify(cfg).replace(/<\//g,'<\\/')+end;});
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
    const context=await browser.newContext({viewport,serviceWorkers:'block'});
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1')return route.abort();if(url.pathname==='/'||url.pathname==='/index.html')return route.fulfill({status:200,contentType:'text/html',body:home});if(url.pathname==='/cases.json')return route.fulfill({status:200,contentType:'application/json',body:'{"cases":[]}'});return route.continue();});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.name));await page.clock.install({time:new Date('2026-10-28T12:00:01Z')});await page.goto(base+'/?ref=OK-ABC234',{waitUntil:'load'});
    await page.clock.runFor(45000);assert.equal(await page.locator('#join').isVisible(),false,'paused signup must not auto-open');
    assert.equal(await page.evaluate(()=>localStorage.getItem('ref')),null);
    await page.locator('[data-join]').first().click();assert.equal(await page.locator('#join').isVisible(),true);assert.match(await page.locator('#joinDone').innerText(),/회원가입 일시 중지/);
    assert.equal(await page.locator('#join').getAttribute('role'),'dialog');assert.equal(await page.locator('#join').getAttribute('aria-modal'),'true');
    const labelled=await page.locator('#join').getAttribute('aria-labelledby');assert.equal(labelled,'joinPausedTitle');assert.equal(await page.locator('#'+labelled).isVisible(),true);
    assert.equal(await page.locator('#joinForm').isVisible(),false);assert.equal(await page.locator('#joinForm').evaluate(el=>el.inert),true);
    await page.locator('#join button.x').click();assert.equal(await page.locator('#join').isVisible(),false);assert.deepEqual(errors,[]);await context.close();
  }}finally{await browser.close();}
  console.log('Paused member notice accessible; unsolicited signup prompt disabled.');
})().catch(e=>{const at=typeof e?.stack==='string'?e.stack.match(/join-prompt-browser\.cjs:\d+:\d+/)?.[0]:'unknown';console.error('JOIN_PAUSED_TEST_FAILED',e?.name||'Error',at||'unknown');process.exit(1);});
