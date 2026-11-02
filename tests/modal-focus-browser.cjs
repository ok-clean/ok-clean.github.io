'use strict';
// Synthetic membership only. Control the actual delayed modal focus callback.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    for(const width of [390,1440]){
      const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
      await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      await context.addInitScript(()=>localStorage.setItem('joinLater',JSON.stringify(Date.now())));
      const page=await context.newPage();
      await page.clock.install();
      await page.goto('http://127.0.0.1:8765/',{waitUntil:'load'});
      await page.clock.pauseAt(await page.evaluate(()=>Date.now()+1000));
      const open=()=>page.evaluate(()=>{const opener=document.querySelector('[data-join]');opener.focus();openJoin();});
      const close=()=>page.evaluate(()=>closeModal(document.querySelector('#join')));
      await open();await page.clock.runFor(50);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'jName','untouched modal receives initial focus');
      await close();
      await open();
      await page.locator('#jName').fill('가상테스트');await page.locator('#jPhone').fill('01000000000');
      await page.clock.runFor(50);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'jPhone','pending initial focus must not steal the selected input');
      assert.equal(await page.locator('#jPhone').inputValue(),'010-0000-0000');
      assert.equal(await page.locator('#jName').inputValue(),'가상테스트');
      await close();await open();await page.clock.runFor(25);await close();await open();
      await page.clock.runFor(25);
      assert.equal(await page.evaluate(()=>document.activeElement.matches('[data-join]')),true,'old modal session must not focus a reopened dialog early');
      await page.clock.runFor(25);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'jName','new session keeps its own initial focus');
      await context.close();console.log('modal focus PASS '+width);
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
