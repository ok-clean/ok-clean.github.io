const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
for(const width of [320,390,1440]){const page=await browser.newPage({viewport:{width,height:900}});
await page.route('**/*',async r=>{if(new URL(r.request().url()).hostname==='127.0.0.1')return r.continue();return r.abort();});
await page.goto('http://127.0.0.1:8765/');await page.waitForSelector('#qSvc option');
assert(await page.locator('#qSvc option').count()>1);const before=await page.locator('#qSvc').inputValue();await page.locator('#qSvc').selectOption({index:1});assert.notEqual(await page.locator('#qSvc').inputValue(),before);
assert(await page.locator('body').innerText());
await page.goto('http://127.0.0.1:8765/admin/');await page.waitForSelector('#loginBtn');assert(await page.locator('#dashboard').isHidden());
assert(await page.locator('#loginBtn').isVisible());await page.close();console.log('Homepage quote controls and admin signed-out shell:',width,'PASS (external auth blocked)');}
await browser.close();})().catch(e=>{console.error(e.message);process.exit(1)});
