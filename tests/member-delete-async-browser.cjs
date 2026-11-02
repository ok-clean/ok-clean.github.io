const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base='http://127.0.0.1:8765';
const source=fs.readFileSync('index.html','utf8');
const home=source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,start,raw,end)=>{const cfg=JSON.parse(raw);cfg.firebase={};cfg.memberBackendUrl='';cfg.kakao='https://example.test/chat';cfg.blog=[];return start+JSON.stringify(cfg).replace(/<\//g,'<\\/')+end;});
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
    const context=await browser.newContext({viewport,serviceWorkers:'block'});
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname!=='127.0.0.1')return route.abort();if(url.pathname==='/'||url.pathname==='/index.html')return route.fulfill({status:200,contentType:'text/html',body:home});if(url.pathname==='/cases.json')return route.fulfill({status:200,contentType:'application/json',body:'{"cases":[]}'});return route.continue();});
    await context.addInitScript(()=>{if(location.hostname!=='127.0.0.1')return;localStorage.setItem('member',JSON.stringify({name:'가상고객',phone:'01000000000',code:'OK-ABC234'}));localStorage.setItem('quote',JSON.stringify({area:'가상지역'}));window.failMemberDelete=false;const original=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(key==='member'&&window.failMemberDelete)throw Error('synthetic delete failed');return original.call(this,key);};});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.name));await page.goto(base+'/',{waitUntil:'load'});
    const before=await page.evaluate(()=>({member:localStorage.getItem('member'),quote:localStorage.getItem('quote')}));await page.locator('[data-join]').first().click();
    page.once('dialog',dialog=>dialog.dismiss());await page.locator('#jClearPaused').click();assert.deepEqual(await page.evaluate(()=>({member:localStorage.getItem('member'),quote:localStorage.getItem('quote')})),before);
    await page.evaluate(()=>{window.failMemberDelete=true;});page.once('dialog',dialog=>dialog.accept());await page.locator('#jClearPaused').click();assert.equal(await page.evaluate(()=>localStorage.getItem('member')),before.member);assert.match(await page.locator('.toast').innerText(),/삭제에 실패/);
    await page.evaluate(()=>{window.failMemberDelete=false;});page.once('dialog',dialog=>dialog.accept());await page.locator('#jClearPaused').click();assert.equal(await page.evaluate(()=>localStorage.getItem('member')),null);assert.equal(await page.evaluate(()=>localStorage.getItem('quote')),before.quote);assert.match(await page.locator('.toast').innerText(),/저장된 회원정보를 지웠어요/);
    assert.equal(await page.locator('#joinForm').isVisible(),false);assert.deepEqual(errors,[]);await context.close();
  }}finally{await browser.close();}
  console.log('Explicit device deletion preserves data on cancel/failure.');
})().catch(e=>{const at=typeof e?.stack==='string'?e.stack.match(/member-delete-async-browser\.cjs:\d+:\d+/)?.[0]:'unknown';console.error('MEMBER_DELETE_PAUSED_TEST_FAILED',e?.name||'Error',at||'unknown');process.exit(1);});
