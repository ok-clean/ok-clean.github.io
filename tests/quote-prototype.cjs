const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch();
 try {
  for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
   const ctx = await browser.newContext({viewport}); let requests = [];
   await ctx.route('**/*', route => { const url = new URL(route.request().url()); requests.push({origin:url.origin,method:route.request().method()}); return url.hostname==='127.0.0.1'?route.continue():route.abort(); });
   const page=await ctx.newPage(); await page.goto('http://127.0.0.1:8765/prototype/quote-request.html');
   await page.locator('button[type=submit]').click(); assert.match(await page.locator('#error').innerText(),/청소 종류/);
   await page.locator('#service').selectOption({label:'입주·이사 청소'}); await page.locator('#area').selectOption({label:'춘천'});
   await page.locator('#size').fill('25'); await page.locator('#date').fill('2099-01-01');
   await page.locator('button[type=submit]').click(); assert.equal(await page.locator('#result').isVisible(),true);
   assert.equal(await page.locator('#r-area').innerText(),'춘천'); assert.equal(await page.locator('#r-size').innerText(),'25평');
   await page.locator('#date').fill('2000-01-01'); await page.locator('button[type=submit]').click();
   assert.match(await page.locator('#error').innerText(),/날짜/); assert.equal(await page.locator('#result').isVisible(),false);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.equal(requests.every(x=>x.origin==='http://127.0.0.1:8765' && x.method==='GET'),true);
   console.log('PASS '+viewport.width+'px'); await ctx.close();
  }
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
