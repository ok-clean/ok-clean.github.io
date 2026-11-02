const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base='http://127.0.0.1:8765';
const source=fs.readFileSync('index.html','utf8');
const home=source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,start,raw,end)=>{
  const cfg=JSON.parse(raw);cfg.firebase={apiKey:'fake-test-identifier',projectId:'fake-test-project'};
  cfg.memberBackendUrl='https://script.google.com/macros/s/synthetic/exec';cfg.kakao='https://example.test/chat';cfg.blog=[];
  return start+JSON.stringify(cfg).replace(/<\//g,'<\\/')+end;
});
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
    const context=await browser.newContext({viewport,serviceWorkers:'block'}),requests=[];
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1'){requests.push(url.hostname);return route.abort();}if(url.pathname==='/'||url.pathname==='/index.html')return route.fulfill({status:200,contentType:'text/html',body:home});if(url.pathname==='/cases.json')return route.fulfill({status:200,contentType:'application/json',body:'{"cases":[]}'});return route.continue();});
    await context.addInitScript(()=>{if(location.hostname!=='127.0.0.1')return;localStorage.setItem('member',JSON.stringify({name:'가상고객',phone:'01000000000',area:'가상지역',code:'OK-ABC234'}));localStorage.setItem('quote',JSON.stringify({svc:'synthetic',area:'가상지역',date:'2099-01-01'}));localStorage.setItem('ref',JSON.stringify('OK-ABC234'));});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.name));
    await page.goto(base+'/',{waitUntil:'load'});const before=await page.evaluate(()=>({member:localStorage.getItem('member'),quote:localStorage.getItem('quote'),ref:localStorage.getItem('ref')}));
    await page.locator('[data-join]').first().click();assert.match(await page.locator('#joinDone').innerText(),/회원가입 일시 중지/);
    assert.equal(await page.locator('#joinForm').isVisible(),false);
    await page.evaluate(()=>document.querySelector('#jSubmit').click());
    assert.deepEqual(await page.evaluate(()=>({member:localStorage.getItem('member'),quote:localStorage.getItem('quote'),ref:localStorage.getItem('ref')})),before);
    assert.equal(await page.locator('#jKakao').count(),0);assert.equal(await page.locator('#joinDone .coupon').count(),0);
    await page.locator('#qSvc').first().count();assert.equal(requests.includes('script.google.com'),false);assert.equal(requests.includes('firestore.googleapis.com'),false);assert.deepEqual(errors,[]);
    await page.screenshot({path:`/tmp/okclean-member-storage-${viewport.width}.png`});await context.close();
  }}finally{await browser.close();}
  console.log('Paused membership preserves existing local data without submission.');
})().catch(e=>{const at=typeof e?.stack==='string'?e.stack.match(/member-storage-browser\.cjs:\d+:\d+/)?.[0]:'unknown';console.error('MEMBER_STORAGE_PAUSED_TEST_FAILED',e?.name||'Error',at||'unknown');process.exit(1);});
