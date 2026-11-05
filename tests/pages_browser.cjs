const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
for(const width of [320,390,1440]){const page=await browser.newPage({viewport:{width,height:900}});
await page.route('**/*',async r=>{if(new URL(r.request().url()).hostname==='127.0.0.1')return r.continue();if(r.request().url().includes('firebase-app.js'))return r.fulfill({contentType:'text/javascript',body:'export const initializeApp=()=>({});'});
if(r.request().url().includes('firebase-auth.js'))return r.fulfill({contentType:'text/javascript',body:`export const getAuth=()=>({});export class GoogleAuthProvider{};let cb;export const onAuthStateChanged=(a,f)=>{cb=f;f(null)};export const signInWithPopup=async()=>cb({uid:'fixture'});export const signInWithRedirect=signInWithPopup;export const getRedirectResult=async()=>null;export const signOut=async()=>cb(null);`});
if(r.request().url().includes('firebase-firestore.js'))return r.fulfill({contentType:'text/javascript',body:`export const getFirestore=()=>({});export const collection=(...a)=>a;export const query=(...a)=>a;export const orderBy=(...a)=>a;export const limit=(...a)=>a;export const doc=(...a)=>a;export const updateDoc=async()=>{globalThis.fixtureSaved=true};export const onSnapshot=(q,f)=>{f({docs:[{id:'fixture',data:()=>({name:'TEST ONLY',phone:'000',area:'fixture',status:'신규',couponStatus:'미사용',freeStatus:'미제공'})}]});return ()=>{}};`});
return r.abort();});
await page.goto('http://127.0.0.1:8765/');await page.waitForSelector('#qSvc option',{state:'attached'});
assert(await page.locator('#qSvc option').count()>1);const before=await page.locator('#qSvc').inputValue();await page.locator('#qSvc').selectOption({index:1});assert.notEqual(await page.locator('#qSvc').inputValue(),before);
assert(await page.locator('body').innerText());
await page.goto('http://127.0.0.1:8765/admin/');await page.waitForSelector('#loginBtn');assert(await page.locator('#dashboard').isHidden());
assert(await page.locator('#loginBtn').isVisible());
await page.locator('#loginBtn').click();await page.waitForSelector('#dashboard', {state:'visible'});assert.equal(await page.locator('.person').count(),1);await page.locator('.person summary').click();await page.locator('[data-save]').click();await page.waitForFunction(()=>globalThis.fixtureSaved===true);await page.locator('#logout').click();assert(await page.locator('#dashboard').isHidden());await page.close();console.log('Homepage quote controls and admin fixture login/save/logout:',width,'PASS (mock SDK; no production writes)');}
await browser.close();})().catch(e=>{console.error(e.message);process.exit(1)});
