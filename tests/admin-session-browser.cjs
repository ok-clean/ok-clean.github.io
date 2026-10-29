const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base='http://127.0.0.1:8765';
const modules={
 'firebase-app.js': `export const initializeApp = () => ({});`,
 'firebase-auth.js': `export class GoogleAuthProvider {};
 export const getAuth=()=>window.fake.authState;
 export const connectAuthEmulator=()=>{};
 export const signInWithPopup=()=>Promise.resolve();
 export const signInWithRedirect=()=>Promise.resolve();
 export const getRedirectResult=()=>Promise.resolve();
 export const onAuthStateChanged=(a,cb)=>{window.fake.auth=user=>{a.currentUser=user;cb(user)};queueMicrotask(()=>window.fake.auth(null));return ()=>{}};
 export const signOut=()=>new Promise((resolve,reject)=>{window.fake.signouts.push({resolve:()=>{window.fake.auth(null);resolve()},reject});});`,
 'firebase-firestore.js': `export const getFirestore=()=>({}); export const connectFirestoreEmulator=()=>{};
 export const collection=(_db,name)=>name; export const query=(...args)=>args;
 export const orderBy=(...args)=>args; export const limit=n=>n; export const doc=(_db,name,id)=>({name,id});
 export const onSnapshot=(_query,options,next,error)=>{const observer={options,next,error,unsubscribed:false};window.fake.observers.push(observer);return ()=>{observer.unsubscribed=true};};
 export const updateDoc=(doc,data)=>new Promise((resolve,reject)=>window.fake.updates.push({doc,data,resolve,reject}));`
};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
   const context=await browser.newContext({viewport,serviceWorkers:'block'});
   await context.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(u.hostname==='www.gstatic.com'){
     const key=u.pathname.split('/').pop();
     return key in modules?route.fulfill({status:200,contentType:'application/javascript',headers:{'access-control-allow-origin':'*'},body:modules[key]}):route.abort();
    }
    if(u.origin!==base)return route.abort();
    if(u.pathname==='/config.json')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({firebase:{apiKey:'fake',projectId:'fake-test'}})});
    return route.continue();
   });
   await context.addInitScript(()=>{
    window.fake={auth:null,authState:{currentUser:null},observers:[],updates:[],signouts:[]};
    window.fake.emit=(index,entries,fromCache=false,hasPendingWrites=false)=>window.fake.observers[index].next({metadata:{fromCache,hasPendingWrites},docs:entries.map(entry=>({id:entry.id,data:()=>entry.data}))});
    window.fake.fail=(index,code='permission-denied')=>window.fake.observers[index].error({code});
   });
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/admin/',{waitUntil:'load'});
   await page.waitForFunction(()=>typeof window.fake.auth==='function');
   const dashboard=page.locator('#dashboard'),members=page.locator('#members'),stats=page.locator('#stats'),search=page.locator('#search'),filter=page.locator('#statusFilter'),message=page.locator('#message');
   const row=(id,name)=>({id,data:{name,phone:'010-0000-0000',area:'가상 지역',code:'OK-ABC234',free:'가상',status:'신규',couponStatus:'미사용',freeStatus:'미제공',grade:'새싹',points:0,memo:'가상 메모'}});
   const a=row('fake-a','가상고객A'), b=row('fake-b','가상고객B');
   const hidden=async()=>{assert.equal(await dashboard.isHidden(),true);assert.equal(await members.textContent(),'');assert.equal(await stats.textContent(),'');assert.equal(await search.inputValue(),'');assert.equal(await filter.inputValue(),'');};
   assert.equal(await page.locator('#login').isVisible(),true);
   await page.evaluate(()=>window.fake.auth({uid:'fake-admin-a'}));
   assert.equal(await page.evaluate(()=>window.fake.observers[0].options.includeMetadataChanges),true);
   await hidden();
   await page.evaluate(a=>window.fake.emit(0,[a],true,false),a);
   await hidden();assert.match(await message.innerText(),/서버 확인 전/);
   // Same documents, only metadata changed: server-confirmed result becomes visible.
   await page.evaluate(a=>window.fake.emit(0,[a],false,false),a);
   assert.equal(await dashboard.isVisible(),true);assert.match(await members.innerText(),/가상고객A/);
   await search.fill('가상고객A');await filter.selectOption('신규');
   await members.locator('summary').click();await members.locator('textarea[name=memo]').fill('가상 수정');await members.locator('[data-save]').click();
   await page.waitForFunction(()=>window.fake.updates.length===1);
   // Pending local snapshots after this same session's confirmation must not discard search/inputs or display pending changes.
   const pending=row('fake-a','가상 미확정');
   await page.evaluate(p=>window.fake.emit(0,[p],false,true),pending);
   assert.equal(await dashboard.isVisible(),true);assert.equal(await search.inputValue(),'가상고객A');assert.match(await members.innerText(),/가상고객A/);assert.doesNotMatch(await members.innerText(),/가상 미확정/);
   // Firebase auth.currentUser may switch before the observer receives the change.
   await page.evaluate(()=>{window.fake.authState.currentUser={uid:'fake-admin-b'};});
   await page.evaluate(p=>window.fake.emit(0,[p],false,false),pending);
   await hidden();assert.match(await message.innerText(),/인증 상태/);
   // Different account: prior UI is removed immediately; stale callback and save cannot reappear.
   await page.evaluate(()=>window.fake.auth({uid:'fake-admin-b'}));await hidden();
   assert.equal(await page.evaluate(()=>window.fake.observers[0].unsubscribed),true);
   await page.evaluate(a=>{window.fake.emit(0,[a],false,false);window.fake.fail(0);window.fake.updates[0].resolve();},a);
   await hidden();assert.match(await message.innerText(),/서버에서/);
   await page.evaluate(a=>window.fake.emit(1,[a],true,false),a);await hidden();
   await page.evaluate(a=>window.fake.emit(1,[a],false,true),a);await hidden();
   await page.evaluate(b=>window.fake.emit(1,[b],false,false),b);
   assert.equal(await dashboard.isVisible(),true);assert.match(await members.innerText(),/가상고객B/);assert.doesNotMatch(await members.innerText(),/가상고객A/);
   await search.fill('가상고객B');await filter.selectOption('신규');
   // Cached/offline result removes a previously confirmed display and ignores late save feedback.
   await members.locator('summary').click();await members.locator('[data-save]').click();await page.waitForFunction(()=>window.fake.updates.length===2);
   await page.evaluate(b=>window.fake.emit(1,[b],true,false),b);await hidden();assert.match(await message.innerText(),/서버 확인 전/);
   await page.evaluate(()=>window.fake.updates[1].resolve());await hidden();assert.match(await message.innerText(),/서버 확인 전/);
   await page.evaluate(b=>window.fake.emit(1,[b],false,false),b);assert.equal(await dashboard.isVisible(),true);
   await page.evaluate(()=>window.fake.fail(1));await hidden();assert.match(await message.innerText(),/접근할 수 없습니다/);assert.equal(await page.locator('#logout').isVisible(),true);
   // The failed subscription cannot revive its old records.
   await page.evaluate(b=>window.fake.emit(1,[b],false,false),b);await hidden();
   // Test normal save and logout: hide immediately even if sign-out is delayed or fails.
   await page.evaluate(()=>window.fake.auth({uid:'fake-admin-c'}));await page.evaluate(b=>window.fake.emit(2,[b],false,false),b);
   await members.locator('summary').click();await members.locator('input[name=points]').fill('250');await members.locator('[data-save]').click();await page.waitForFunction(()=>window.fake.updates.length===3);
   assert.equal(await page.evaluate(()=>window.fake.updates[2].data.points),250);
   await page.evaluate(()=>window.fake.updates[2].resolve());await page.waitForFunction(()=>document.querySelector('#message').textContent==='저장되었습니다.');
   await search.fill('가상고객B');await page.locator('#logout').click();await hidden();assert.match(await message.innerText(),/로그아웃 중/);
   await page.evaluate(()=>window.fake.signouts[0].reject(Error('fake failure')));await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('다시 시도'));
   await hidden();assert.equal(await page.locator('#logout').isVisible(),true);
   await page.locator('#logout').click();await hidden();await page.evaluate(()=>window.fake.signouts[1].resolve());await page.waitForFunction(()=>!document.querySelector('#login').hidden);
   await hidden();assert.equal(await page.locator('#logout').isHidden(),true);
   assert.deepEqual(errors,[]);await context.close();console.log(`admin session PASS ${viewport.width}`);
  }
 } finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
