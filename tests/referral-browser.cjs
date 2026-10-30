'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const base=process.env.OKCLEAN_TEST_BASE || 'http://127.0.0.1:8765';
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [390,1440]){
   for(const suffix of ['?ref=OK-ABC234&svc=aircon#quote','?ref=bad&ref=OK-ABC234','?src=app']){
    const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
    try{
     await context.route('**/*',route=>{const u=new URL(route.request().url());return u.hostname==='127.0.0.1'?route.continue():route.abort();});
     await context.addInitScript(()=>{
      localStorage.setItem('member',JSON.stringify({name:'synthetic',phone:'01000000000',code:'OK-ABC234'}));
      localStorage.setItem('ref',JSON.stringify('OK-OLD234'));
      Object.defineProperty(navigator,'share',{configurable:true,value:async x=>{window.shared=x;}});
     });
     const page=await context.newPage();await page.goto(base+'/index.html'+suffix,{waitUntil:'load'});
     assert.equal(await page.evaluate(()=>new URL(location.href).searchParams.has('ref')),false);
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ref'))),'OK-OLD234');
     assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('member')).code),'OK-ABC234');
     await page.locator('[data-share]:visible').first().click();
     const shared=await page.evaluate(()=>window.shared);
     assert.ok(shared?.url);assert.equal(new URL(shared.url).searchParams.has('ref'),false);
     assert.equal(shared.url.includes('OK-ABC234'),false);assert.equal(shared.url.includes('OK-OLD234'),false);
     await page.locator('[data-invite]:visible').first().click();
     assert.match(await page.locator('.toast').innerText(),/일시 중지/);
    }finally{await context.close();}
   }
  }
 }finally{await browser.close();}
 console.log('referral pause PASS');
})().catch(e=>{console.error(e.name);process.exitCode=1;});
