'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const origin='http://127.0.0.1:8765';
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  for(const width of [320,390,1440]) {
   const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'}),requests=[];
   await context.route('**/*',route=>{
    const req=route.request(),url=new URL(req.url());requests.push({origin:url.origin,method:req.method()});
    return url.origin===origin && req.method()==='GET'?route.continue():route.abort();
   });
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin+'/prototype/cancellation-status.html?endpoint=https://evil.invalid&token=private-demo');
   assert.match(await page.locator('.notice').first().innerText(),/실제 취소나 실제 상태 조회가 아닙니다/);
   assert.equal(await page.locator('input,textarea,form').count(),0);
   assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),/connect-src 'none'/);
   assert.equal(await page.locator('[data-status-message]').getAttribute('aria-live'),'polite');
   for(const selector of ['[data-status-check]','[data-status-clear]','#demo-case'])
    assert.ok((await page.locator(selector).boundingBox()).height>=44,'touch target '+selector);

   await page.locator('[data-status-check]').focus();await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.querySelector('#cancellation-root').dataset.state==='processing');
   let text=await page.locator('[data-status-message]').innerText();
   assert.match(text,/조회 시점/);assert.match(text,/나중에 완료될 수/);assert.match(text,/성공이나 실패를 뜻하지/);
   assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-status-message')),true);
   if(process.env.EVIDENCE_DIR && [390,1440].includes(width)) {
    fs.mkdirSync(process.env.EVIDENCE_DIR,{recursive:true});
    await page.screenshot({path:path.join(process.env.EVIDENCE_DIR,'cancellation-'+width+'.png'),fullPage:true});
   }
   for(const [scenario,expected,word] of [
    ['cancelled','cancelled',/가상 요청이 취소/],
    ['booked','booked',/가상 요청은 예약 확정/],
    ['completed','completed',/가상 작업이 완료/],
    ['closed','closed',/종료가 취소와 같다는 뜻은 아닙니다/],
    ['unavailable','unavailable',/실제 취소 여부를 알 수 없/],
    ['error','unavailable',/실제 취소 여부를 알 수 없/]
   ]) {
    await page.locator('#demo-case').selectOption(scenario);
    assert.equal(await page.locator('#cancellation-root').getAttribute('data-state'),'idle');
    await page.locator('[data-status-check]').click();
    await page.waitForFunction(value=>document.querySelector('#cancellation-root').dataset.state===value,expected);
    assert.match(await page.locator('[data-status-message]').innerText(),word);
    assert.match(await page.locator('[data-status-message]').innerText(),/가상/);
   }
   await page.locator('#demo-case').selectOption('delayed');
   await page.locator('[data-status-check]').click();
   await page.waitForFunction(()=>document.querySelector('#cancellation-root').dataset.state==='checking');
   assert.equal(await page.locator('#cancellation-root').getAttribute('aria-busy'),'true');
   await page.locator('[data-status-clear]').click();
   await page.waitForTimeout(850);
   assert.equal(await page.locator('#cancellation-root').getAttribute('data-state'),'idle');
   assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-status-check')),true);

   await page.locator('#demo-case').selectOption('delayed');
   await page.locator('[data-status-check]').click();
   await page.locator('#demo-case').selectOption('processing');
   await page.locator('[data-status-check]').click();
   await page.waitForFunction(()=>document.querySelector('#cancellation-root').dataset.state==='processing');
   await page.waitForTimeout(850);
   assert.equal(await page.locator('#cancellation-root').getAttribute('data-state'),'processing');

   await page.locator('#demo-case').selectOption('timeout');
   await page.locator('[data-status-check]').click();
   await page.waitForFunction(()=>document.querySelector('#cancellation-root').dataset.state==='unavailable');
   assert.match(await page.locator('[data-status-message]').innerText(),/실제 취소 여부를 알 수 없/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'horizontal overflow');
   assert.deepEqual(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie})),{local:0,session:0,cookie:''});
   assert.doesNotMatch(await page.locator('body').innerText(),/private-demo|evil\.invalid/);

   await page.evaluate(()=>{
    const old=document.querySelector('#cancellation-root'),root=old.cloneNode(true);old.replaceWith(root);
    window.testCalls=0;
    window.testView=OKCleanCancellationView.mount({root,timeoutMs:1000,loadState:()=>{window.testCalls++;return new Promise(resolve=>{window.finishStatus=resolve;});}});
   });
   await page.locator('[data-status-check]').click();
   await page.evaluate(()=>document.querySelector('[data-status-check]').dispatchEvent(new MouseEvent('click',{bubbles:true})));
   assert.equal(await page.evaluate(()=>window.testCalls),1);
   await page.locator('[data-status-clear]').click();
   await page.evaluate(()=>window.finishStatus('cancelled'));
   await page.waitForTimeout(50);
   assert.equal(await page.locator('#cancellation-root').getAttribute('data-state'),'idle');
   assert.equal(await page.evaluate(()=>window.testCalls),1);
   await page.evaluate(()=>{
    window.testView.destroy();
    const root=document.querySelector('#cancellation-root');
    window.testView=OKCleanCancellationView.mount({root,loadState:async()=>'<img src=x onerror=window.attack=1>'});
   });
   await page.locator('[data-status-check]').click();
   await page.waitForFunction(()=>document.querySelector('#cancellation-root').dataset.state==='unavailable');
   assert.equal(await page.locator('[data-status-message] img').count(),0);
   assert.equal(await page.evaluate(()=>window.attack),undefined);
   await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
   assert.equal(await page.locator('#cancellation-root').getAttribute('data-state'),'idle');
   assert.deepEqual(errors,[]);
   assert.equal(requests.every(x=>x.origin===origin && x.method==='GET'),true);
   console.log('PASS cancellation status preview '+width+'px');
   await context.close();
  }
  const nojs=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
  const page=await nojs.newPage();await page.goto(origin+'/prototype/cancellation-status.html');
  assert.equal(await page.locator('[data-status-check]').isDisabled(),true);
  assert.equal(await page.locator('[data-status-clear]').isDisabled(),true);
  assert.match(await page.locator('noscript').innerText(),/자바스크립트/);
  await nojs.close();
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
