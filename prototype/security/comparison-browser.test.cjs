'use strict';
// Test-only browser -> loopback HTTPS -> fake auth -> emulator-backed comparison.
const assert=require('node:assert/strict');
const https=require('node:https');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');
const {initializeTestEnvironment}=require('@firebase/rules-unit-testing');
const {doc,setDoc,Timestamp}=require('firebase/firestore');
const {createComparisonHttpHandler}=require('./comparison-http-adapter.cjs');
const {createComparisonHandler}=require('./comparison-handler.cjs');
const {createComparisonReader}=require('./comparison-reader.cjs');
const {assignPartnerAsAdmin,reviewPartnerAsAdmin,submitAssignedOffer}=require('./partner-matching-service.cjs');
const root=path.resolve(__dirname,'../..');
const files=new Map([
 ['/prototype/comparison.html',['prototype/comparison.html','text/html']],
 ['/prototype/comparison.css',['prototype/comparison.css','text/css']],
 ['/prototype/security/comparison-view.js',['prototype/security/comparison-view.js','application/javascript']],
 ['/prototype/security/comparison-client.js',['prototype/security/comparison-client.js','application/javascript']]
]);
const account={email_verified:true,firebase:{sign_in_provider:'password'}};
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'okclean-comparison-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(tmp,'key.pem'),'-out',path.join(tmp,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
 const env=await initializeTestEnvironment({projectId:'demo-okclean-matching',firestore:{rules:fs.readFileSync('prototype/security/firestore.rules','utf8')}});
 let browser,server,rateAllowed=true;
 try{
  await env.clearFirestore();
  const admin=env.authenticatedContext('admin',{admin:true}).firestore();
  const partner=env.authenticatedContext('p1',account).firestore();
  await env.withSecurityRulesDisabled(async c=>{
   const db=c.firestore();
   await setDoc(doc(db,'quote_requests','r'),{service:'입주·이사 청소',area:'춘천',size:25,date:Timestamp.fromMillis(Date.now()+7*86400000),status:'신규',ownerUid:'customer',name:'PRIVATE-NAME',phone:'PRIVATE-PHONE'});
   await setDoc(doc(db,'partner_profiles','p1'),{company:'가상업체',areas:['춘천'],specialties:['입주·이사 청소'],status:'승인',approvalVersion:1});
  });
  const assignment=await assignPartnerAsAdmin(admin,'r','p1');
  await submitAssignedOffer(partner,'r',assignment.grantId,{price:250000,note:'PRIVATE-NOTE'});
  const reader=createComparisonReader(admin);
  const lookup=createComparisonHandler({
   verifyIdToken:async token=>{
    if(token==='test-invalid')throw Error('PRIVATE TOKEN');
    if(token==='test-anonymous')return {uid:'customer',firebase:{sign_in_provider:'anonymous'}};
    return {uid:token==='test-owner'?'customer':'other',...account};
   },
   enforceRateLimit:async()=>rateAllowed,loadOwnedComparison:reader
  });
  let adapter;const requests=[];
  server=https.createServer({key:fs.readFileSync(path.join(tmp,'key.pem')),cert:fs.readFileSync(path.join(tmp,'cert.pem'))},(req,res)=>{
   if(req.url==='/api/offer-comparison'){
    const entry={method:req.method,authorization:req.headers.authorization,cookie:req.headers.cookie,body:''};requests.push(entry);
    req.on('data',b=>{entry.body+=b.toString();});
    Promise.resolve(adapter(req,res)).catch(()=>res.destroy());return;
   }
   const url=new URL(req.url,'https://127.0.0.1');
   if(req.method!=='GET'){res.writeHead(404);res.end();return;}
   if(url.pathname==='/prototype/comparison-demo.js'){
    res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
    res.end("window.identity='test-owner';window.delayIdentity=false;window.testView=OKCleanComparisonView.mount({root:document.getElementById('comparison-root'),timeoutMs:3000,loadOffers:OKCleanComparisonClient.createComparisonClient({endpoint:location.origin+'/api/offer-comparison',getIdToken:async()=>{const old=window.identity;if(window.delayIdentity)await new Promise(r=>setTimeout(r,400));return old;},getRequestId:async()=> 'r',timeoutMs:2500})});");return;
   }
   const file=files.get(url.pathname);if(!file){res.writeHead(404);res.end();return;}
   let data=fs.readFileSync(path.join(root,file[0]),'utf8');
   if(url.pathname==='/prototype/comparison.html'){
    // The committed demo keeps connect-src none. Only this loopback fixture enables same-origin fetch.
    data=data.replace("connect-src 'none'","connect-src 'self'").replace('<script src="comparison-demo.js" defer></script>','<script src="security/comparison-client.js" defer></script><script src="comparison-demo.js" defer></script>');
   }
   res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8','Cache-Control':'no-store'});res.end(data);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='https://127.0.0.1:'+server.address().port;
  adapter=createComparisonHttpHandler({allowedOrigins:[base],lookupComparison:lookup});
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const width of [390,1440]){
   const context=await browser.newContext({viewport:{width,height:844},ignoreHTTPSErrors:true,serviceWorkers:'block'});
   const page=await context.newPage(),errors=[],seen=[];page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',route=>{
    const req=route.request(),url=new URL(req.url());seen.push({origin:url.origin,method:req.method()});
    return url.origin===base?route.continue():route.abort();
   });
   try{
    await page.goto(base+'/prototype/comparison.html?endpoint=https://evil.invalid&token=ignored');
    const before=requests.length;assert.equal(await page.locator('.offer').count(),0);
    const ownerResponse=page.waitForResponse(response=>response.url()===base+'/api/offer-comparison' && response.request().method()==='POST');
    await page.locator('[data-comparison-load]').click();
    await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='ready');
    assert.equal(requests.length,before+1);assert.equal(requests.at(-1).authorization,'Bearer test-owner');
    assert.deepEqual(JSON.parse(requests.at(-1).body),{requestId:'r'});assert.equal(requests.at(-1).cookie,undefined);
    const received=await ownerResponse;assert.equal(received.status(),200);assert.match(received.headers()['cache-control'],/no-store/);
    assert.match(await page.locator('.offer').innerText(),/가상업체/);assert.match(await page.locator('.offer').innerText(),/250,000원/);
    assert.doesNotMatch(await page.locator('body').innerText(),/PRIVATE|test-owner|p1/);
    const beforeReset=requests.length;
    await page.evaluate(()=>{window.testView.reset({focus:false});window.delayIdentity=true;});
    await page.locator('[data-comparison-load]').click();
    await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='loading');
    await page.evaluate(()=>{window.testView.reset({focus:false});window.identity='test-other';});
    await page.waitForTimeout(550);
    assert.equal(requests.length,beforeReset);
    assert.equal(await page.locator('#comparison-root').getAttribute('data-state'),'idle');
    await page.evaluate(()=>{window.delayIdentity=false;});
    for(const identity of ['test-other','test-invalid','test-anonymous']){
     await page.evaluate(v=>{window.testView.reset({focus:false});window.identity=v;},identity);
     await page.locator('[data-comparison-load]').click();
     await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='unavailable');
     assert.equal(await page.locator('.offer').count(),0);
    }
    rateAllowed=false;await page.evaluate(()=>{window.testView.reset({focus:false});window.identity='test-owner';});
    const rateResponse=page.waitForResponse(response=>response.url()===base+'/api/offer-comparison' && response.request().method()==='POST');
    await page.locator('[data-comparison-load]').click();await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='unavailable');
    assert.equal((await rateResponse).status(),429);rateAllowed=true;
    assert.deepEqual(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie})),{local:0,session:0,cookie:''});
    assert.equal(seen.every(x=>x.origin===base),true);assert.deepEqual(errors,[]);
   }finally{rateAllowed=true;await context.close();}
  }
  await reviewPartnerAsAdmin(admin,'p1','반려');
  const context=await browser.newContext({viewport:{width:390,height:844},ignoreHTTPSErrors:true,serviceWorkers:'block'});
  try{
   const page=await context.newPage();await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
   await page.goto(base+'/prototype/comparison.html');await page.locator('[data-comparison-load]').click();
   await page.waitForFunction(()=>document.querySelector('#comparison-root').dataset.state==='empty');
   assert.equal(await page.locator('.offer').count(),0);
  }finally{await context.close();}
  console.log('PASS browser -> HTTPS -> fake identity -> Firestore emulator -> owner-only comparison, 390/1440px and revocation');
 }finally{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await env.cleanup();fs.rmSync(tmp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
