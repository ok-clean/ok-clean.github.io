'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [320,390,1440]){
   const context=await browser.newContext({viewport:{width,height:844}}), requests=[];
   await context.route('**/*',route=>{
    const req=route.request(),url=new URL(req.url());
    requests.push({origin:url.origin,method:req.method()});
    return url.origin==='http://127.0.0.1:8765' && req.method()==='GET'?route.continue():route.abort();
   });
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:8765/prototype/comparison.html');
   assert.match(await page.locator('.notice').innerText(),/실제 견적이나 예약이 아닙니다/);
   await page.locator('[data-comparison-load]').click();
   await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='ready');
   assert.equal(await page.locator('.offer').count(),2);
   assert.match(await page.locator('.offer').first().innerText(),/가상 청소업체 A/);
   assert.match(await page.locator('.offer').first().innerText(),/250,000원/);
   assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-comparison-status')),true);
   if(process.env.EVIDENCE_DIR && [390,1440].includes(width)){
    fs.mkdirSync(process.env.EVIDENCE_DIR,{recursive:true});
    await page.screenshot({path:path.join(process.env.EVIDENCE_DIR,'comparison-'+width+'.png'),fullPage:true});
   }
   await page.locator('#demo-case').selectOption('empty');
   assert.equal(await page.locator('.offer').count(),0);
   await page.locator('[data-comparison-load]').click();
   await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='empty');
   await page.locator('#demo-case').selectOption('error');
   await page.locator('[data-comparison-load]').click();
   await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='unavailable');
   await page.locator('#demo-case').selectOption('delayed');
   await page.locator('[data-comparison-load]').click();
   await page.locator('#demo-case').selectOption('empty');
   await page.waitForTimeout(850);
   assert.equal(await page.locator('#comparison-root').getAttribute('data-state'),'idle');
   assert.equal(await page.locator('.offer').count(),0);
   await page.locator('#demo-case').selectOption('timeout');
   await page.locator('[data-comparison-load]').click();
   await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='unavailable');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'horizontal overflow');
   await page.evaluate(()=>{
    const old=document.querySelector('#comparison-root'),root=old.cloneNode(true);old.replaceWith(root);
    globalThis.OKCleanComparisonView.mount({root,loadOffers:async()=>[{company:'<img src=x onerror=window.attack=1>',price:100}]});
   });
   await page.locator('[data-comparison-load]').click();
   await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='ready');
   assert.match(await page.locator('.offer h3').innerText(),/<img src=x/);
   assert.equal(await page.locator('.offer img').count(),0);
   assert.equal(await page.evaluate(()=>window.attack),undefined);
   assert.deepEqual(errors,[]);
   assert.equal(requests.every(x=>x.origin==='http://127.0.0.1:8765' && x.method==='GET'),true);
   console.log('PASS comparison preview '+width+'px');await context.close();
  }
  const nojs=await browser.newContext({javaScriptEnabled:false});
  const page=await nojs.newPage();await page.goto('http://127.0.0.1:8765/prototype/comparison.html');
  assert.equal(await page.locator('[data-comparison-load]').isDisabled(),true);
  assert.match(await page.locator('noscript').innerText(),/자바스크립트/);
  await nojs.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
