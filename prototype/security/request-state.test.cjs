'use strict';
// Real Firestore emulator, synthetic account claims and request records only.
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {once}=require('node:events');
const {chromium}=require('playwright');
const {initializeTestEnvironment,assertFails}=require('@firebase/rules-unit-testing');
const {doc,setDoc,updateDoc,getDocFromServer,Timestamp}=require('firebase/firestore');
const {createRequestStateHandler}=require('./request-state-handler.cjs');
const {createRequestStateReader}=require('./request-state-reader.cjs');
const {createCancelHandler}=require('./request-cancel-handler.cjs');
const {createCancellationStore}=require('./request-cancel-store.cjs');
const account={email_verified:true,firebase:{sign_in_provider:'password'}};
const args={idToken:'test-owner',requestId:'r'};
const unavailable=code=>({httpStatus:code,body:{status:'unavailable'}});
const result=state=>({httpStatus:200,body:{status:'ok',state}});
let env,admin,owner,other,anon,stateHandler,cancelHandler;
const quote=db=>doc(db,'quote_requests','r');
const seed=fn=>env.withSecurityRulesDisabled(c=>fn(c.firestore()));
async function fakeVerify(token) {
 if(token==='test-owner')return {uid:'customer',...account};
 if(token==='test-other')return {uid:'other',...account};
 if(token==='test-unverified')return {uid:'customer',email_verified:false,firebase:{sign_in_provider:'password'}};
 if(token==='test-anonymous')return {uid:'customer',firebase:{sign_in_provider:'anonymous'}};
 throw Error('PRIVATE TOKEN');
}
before(async()=>{
 env=await initializeTestEnvironment({projectId:'demo-okclean-matching',firestore:{rules:fs.readFileSync('prototype/security/firestore.rules','utf8')}});
 admin=env.authenticatedContext('admin',{admin:true}).firestore();
 owner=env.authenticatedContext('customer',account).firestore();
 other=env.authenticatedContext('other',account).firestore();
 anon=env.authenticatedContext('customer',{firebase:{sign_in_provider:'anonymous'}}).firestore();
 stateHandler=createRequestStateHandler({verifyIdToken:fakeVerify,enforceRateLimit:async()=>true,readOwnedState:createRequestStateReader(admin)});
 cancelHandler=createCancelHandler({verifyIdToken:fakeVerify,enforceRateLimit:async()=>true,cancelOwned:createCancellationStore(admin)});
});
beforeEach(async()=>{
 await env.clearFirestore();
 await seed(db=>setDoc(quote(db),{service:'입주·이사 청소',area:'춘천',size:25,date:Timestamp.fromMillis(Date.now()+7*86400000),
  status:'신규',ownerUid:'customer',name:'PRIVATE-NAME',phone:'PRIVATE-PHONE'}));
});
after(async()=>{if(env)await env.cleanup();});

test('maps only known states and never returns customer details',async()=>{
 for(const [source,expected] of [
  ['신규','processing'],['검토중','processing'],['상담중','processing'],
  ['취소','cancelled'],['예약확정','booked'],['작업완료','completed'],['종료','closed']
 ]) {
  await seed(db=>updateDoc(quote(db),{status:source}));
  const response=await stateHandler(args);
  assert.deepEqual(response,result(expected));
  assert.doesNotMatch(JSON.stringify(response),/PRIVATE|customer|ownerUid|test-owner|phone|name/);
 }
});
test('direct customer reads stay forbidden; trusted reader checks ownership',async()=>{
 for(const db of [owner,other,anon])await assertFails(getDocFromServer(quote(db)));
 assert.deepEqual(await stateHandler(args),result('processing'));
 const nonPrivilegedHandler=createRequestStateHandler({
  verifyIdToken:fakeVerify,enforceRateLimit:async()=>true,readOwnedState:createRequestStateReader(owner)
 });
 assert.deepEqual(await nonPrivilegedHandler(args),unavailable(503));
});
test('other and missing records produce the same response',async()=>{
 const foreign=await stateHandler({idToken:'test-other',requestId:'r'});
 const missing=await stateHandler({idToken:'test-owner',requestId:'missing'});
 assert.deepEqual(foreign,missing);assert.deepEqual(missing,unavailable(404));
});
test('anonymous, unverified and invalid tokens cannot inspect state',async()=>{
 for(const [token,code] of [['test-anonymous',403],['test-unverified',403],['test-invalid',401]])
  assert.deepEqual(await stateHandler({idToken:token,requestId:'r'}),unavailable(code));
});
test('unknown state fails closed and does not echo database content',async()=>{
 await seed(db=>updateDoc(quote(db),{status:'PRIVATE-UNKNOWN'}));
 const response=await stateHandler(args);
 assert.deepEqual(response,unavailable(503));assert.doesNotMatch(JSON.stringify(response),/PRIVATE/);
});
test('after successful cancellation the owner sees cancelled while the request remains stored',async()=>{
 assert.deepEqual(await stateHandler(args),result('processing'));
 assert.deepEqual(await cancelHandler(args),{httpStatus:200,body:{status:'cancelled'}});
 assert.deepEqual(await stateHandler(args),result('cancelled'));
 assert.equal((await getDocFromServer(quote(admin))).exists(),true);
});
test('a read racing a cancellation is a snapshot, not a final outcome', {timeout:60000},async()=>{
 const [read,cancel]=await Promise.all([stateHandler(args),cancelHandler(args)]);
 assert.deepEqual(cancel,{httpStatus:200,body:{status:'cancelled'}});
 assert.ok(['processing','cancelled'].includes(read.body.state));assert.equal(read.httpStatus,200);
 assert.deepEqual(await stateHandler(args),result('cancelled'));
});
test('test-only browser bridge displays the owner state without customer data or external requests', {timeout:60000},async()=>{
 const files=new Map([
  ['/prototype/cancellation-status.html',['prototype/cancellation-status.html','text/html']],
  ['/prototype/cancellation-status.css',['prototype/cancellation-status.css','text/css']],
  ['/prototype/cancellation-demo.js',['prototype/cancellation-demo.js','application/javascript']],
  ['/prototype/security/cancellation-view.js',['prototype/security/cancellation-view.js','application/javascript']]
 ]);
 const server=http.createServer((req,res)=>{
  const file=files.get(req.url);
  if(req.method!=='GET' || !file){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8','Cache-Control':'no-store'});
  res.end(fs.readFileSync(path.join(process.cwd(),file[0])));
 });
 let browser;
 try {
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const width of [390,1440]) {
   await seed(db=>updateDoc(quote(db),{status:'신규'}));
   const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
   const page=await context.newPage(),seen=[],errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());seen.push({origin:url.origin,method:route.request().method()});
    return url.origin===base && route.request().method()==='GET'?route.continue():route.abort();
   });
   await page.exposeFunction('testReadState',token=>stateHandler({idToken:token,requestId:'r'}));
   try {
    await page.goto(base+'/prototype/cancellation-status.html');
    await page.evaluate(()=>{
     const old=document.querySelector('#cancellation-root'),root=old.cloneNode(true);
     old.replaceWith(root);window.testIdentity='test-owner';
     window.fixtureView=OKCleanCancellationView.mount({root,loadState:async()=>{
      const response=await window.testReadState(window.testIdentity);
      return response.httpStatus===200?response.body.state:'unavailable';
     }});
    });
    await page.locator('[data-status-check]').click();
    await page.waitForFunction(()=>document.querySelector('#cancellation-root').dataset.state==='processing');
    assert.deepEqual(await cancelHandler(args),{httpStatus:200,body:{status:'cancelled'}});
    await page.evaluate(()=>window.fixtureView.reset({focus:false}));
    await page.locator('[data-status-check]').click();
    await page.waitForFunction(()=>document.querySelector('#cancellation-root').dataset.state==='cancelled');
    assert.match(await page.locator('[data-status-message]').innerText(),/가상 요청이 취소/);
    assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE|test-owner|customer/);
    await page.evaluate(()=>{window.fixtureView.reset({focus:false});window.testIdentity='test-other';});
    await page.locator('[data-status-check]').click();
    await page.waitForFunction(()=>document.querySelector('#cancellation-root').dataset.state==='unavailable');
    assert.deepEqual(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie})),{local:0,session:0,cookie:''});
    assert.ok(seen.every(x=>x.origin===base && x.method==='GET'));assert.deepEqual(errors,[]);
   } finally {await context.close();}
  }
 } finally {
  if(browser)await browser.close();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
 }
});
