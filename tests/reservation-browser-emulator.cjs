'use strict';
// Real browser + Firebase Auth/Firestore emulators only. No production projects.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const admin=require('firebase-admin');
const {createVerifiedReservationHandler}=require('../prototype/security/verified-reservation-handler.cjs');
const {createReceiptStatusHandler}=require('../prototype/security/receipt-status-handler.cjs');
const project='demo-okclean-integration';
if(process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099' ||
   process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085' ||
   process.env.GCLOUD_PROJECT!==project) throw new Error('Loopback emulators and demo project are mandatory');

async function main(){
  execFileSync('python3',['tests/build-generated-fixture.py'],{stdio:'ignore'});
  const root=fs.readFileSync('/tmp/okclean-generated-root.txt','utf8').trim();
  if(!root.startsWith('/tmp/okclean-generated-'))throw new Error('Unexpected fixture directory');
  for(const name of ['reservation-emulator.js','verified-reservation-emulator.js','admin/admin.js','admin/index.html']){
    const dest=path.join(root,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(name,dest);
  }
  fs.copyFileSync('reservation-emulator.js',path.join(root,'reservation-real.js'));
  fs.copyFileSync('/tmp/okclean-firebase-bundle.js',path.join(root,'firebase-bundle.js'));
  const configPath=path.join(root,'config.json');
  const cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
  cfg.firebase={apiKey:'fake-test-identifier',authDomain:'localhost',projectId:project,appId:'1:123:web:fake'};
  cfg.reservation={emulator:true};
  fs.writeFileSync(configPath,JSON.stringify(cfg));
  execFileSync('python3',['-c','import build; build.run()'],{cwd:root,stdio:'ignore'});

  const app=admin.initializeApp({projectId:project});
  const auth=admin.auth(app), db=admin.firestore(app);
  const uid='REPLACE_WITH_ADMIN_UID', email='admin@example.test', password='test-password-123';
  await auth.createUser({uid,email,password,emailVerified:true});
  await auth.setCustomUserClaims(uid,{admin:true});
  const verifiedCustomer='customer@example.test', otherCustomer='other@example.test', customerPassword='test-password-123';
  await auth.createUser({uid:'verified-customer',email:verifiedCustomer,password:customerPassword,emailVerified:true});
  await auth.createUser({uid:'verified-other',email:otherCustomer,password:customerPassword,emailVerified:true});
  const verifyIdToken=token=>auth.verifyIdToken(token,true);
  const submitVerified=createVerifiedReservationHandler({verifyIdToken,db,enforceRateLimit:async()=>true});
  const receiptStatus=createReceiptStatusHandler({verifyIdToken,loadRequest:async id=>{const s=await db.collection('quote_requests').doc(id).get();return s.exists?s.data():null;},enforceRateLimit:async()=>true});
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json'};
  const server=http.createServer((req,res)=>{
    let pathname;
    try {pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400);return res.end();}
    if(req.method==='POST' && ['/emulator/reservation/submit','/emulator/reservation/status'].includes(pathname)){
      let body='';req.on('data',chunk=>{body+=chunk;if(body.length>8192)req.destroy();});req.on('end',async()=>{
        try{const data=JSON.parse(body), idToken=(req.headers.authorization||'').replace(/^Bearer /,'');
          const result=pathname.endsWith('/submit')?await submitVerified({idToken,requestId:data.requestId,form:data.form}):await receiptStatus({idToken,requestId:data.requestId});
          res.writeHead(result.httpStatus,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result.body));
        }catch{res.writeHead(400);res.end();}
      });return;
    }
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
    fs.readFile(file,(err,data)=>{
      if(err){res.writeHead(404);return res.end();}
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Access-Control-Allow-Origin':'*'});res.end(data);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true});
  async function context(){
    const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    await ctx.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(u.origin===base || (u.hostname==='127.0.0.1' && ['8085','9099'].includes(u.port)))return route.continue();
      if(u.origin==='https://www.gstatic.com' && /^\/firebasejs\/10\.14\.1\/firebase-(app|auth|firestore)\.js$/.test(u.pathname))
        return route.fulfill({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:`export * from "${base}/firebase-bundle.js";`});
      return route.abort();
    });
    await ctx.addInitScript(()=>{if(location.hostname==='127.0.0.1')localStorage.setItem('joinLater',JSON.stringify(Date.now()));});
    return ctx;
  }
  try{
    const customer=await context(), page=await customer.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/',{waitUntil:'load'});
    await page.locator('#qArea').selectOption('춘천');
    const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    await page.locator('#qDate').fill(date);
    const price=await page.locator('#qV').innerText();
    await page.locator('#qReserve').click();
    await page.locator('#reserveName').fill('가상고객');
    await page.locator('#reservePhone').fill('01000000000');
    await page.locator('#reserveSize').fill('25');
    await page.locator('#reserveNotes').fill('가상 요청사항');
    await page.locator('#reserveConsent').check();
    await page.locator('#reserveSubmit').click();
    await page.waitForFunction(()=>document.querySelector('#reserveStatus').textContent.includes('시험 접수 완료'),null,{timeout:30000});
    const status=await page.locator('#reserveStatus').innerText();
    const id=status.match(/접수번호: ([a-f0-9-]+)/)?.[1];
    assert.ok(id,'saved receipt id');assert.ok(price);
    const saved=await db.collection('quote_requests').doc(id).get();
    assert.ok(saved.exists,'Firestore emulator contains request');
    assert.equal(saved.data().notes,'가상 요청사항');assert.ok(Number.isInteger(saved.data().estimateMin));
    const rounded=Math.round(saved.data().estimateMin/1000)*1000;
    const displayed=rounded>=10000 ? String(+(rounded/10000).toFixed(1))+'만' : rounded.toLocaleString('ko-KR');
    assert.ok(price.includes(displayed),'saved estimate must match displayed calculator result');
    assert.equal(saved.data().name,'가상고객');
    assert.equal(await page.locator('#reserveSubmit').isDisabled(),true,'double click remains blocked');
    const replayData={id,date,estimateMin:saved.data().estimateMin,estimateMax:saved.data().estimateMax ?? null};
    const sameRequest=await page.evaluate(async data=>{
      const f=await import('/firebase-bundle.js'), app=f.getApp('reservation-emulator'), auth=f.getAuth(app), db=f.getFirestore(app);
      const payload={service:'입주·이사 청소',area:'춘천',size:25,date:new Date(data.date+'T14:59:59.999Z'),
        name:'가상고객',phone:'01000000000',notes:'가상 요청사항',consentVersion:'test-v1',
        consentAt:f.serverTimestamp(),createdAt:f.serverTimestamp(),ownerUid:auth.currentUser.uid,status:'신규',estimateMin:data.estimateMin};
      if(data.estimateMax!==null)payload.estimateMax=data.estimateMax;
      try{await f.setDoc(f.doc(db,'quote_requests',data.id),payload);return false;}catch(e){return e.code==='permission-denied';}
    },replayData);
    assert.equal(sameRequest,true,'repeat write with the same receipt ID must be rejected');
    const other=await context(), otherPage=await other.newPage();
    await otherPage.goto(base+'/',{waitUntil:'load'});
    const otherReplay=await otherPage.evaluate(async data=>{
      const f=await import('/firebase-bundle.js');
      const app=f.initializeApp({apiKey:'fake-test-identifier',projectId:'demo-okclean-integration'},'other-customer');
      const auth=f.getAuth(app);f.connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
      await f.signInAnonymously(auth);
      const db=f.getFirestore(app);f.connectFirestoreEmulator(db,'127.0.0.1',8085);
      const payload={service:'입주·이사 청소',area:'춘천',size:25,date:new Date(data.date+'T14:59:59.999Z'),
        name:'가상고객',phone:'01000000000',notes:'가상 요청사항',consentVersion:'test-v1',
        consentAt:f.serverTimestamp(),createdAt:f.serverTimestamp(),ownerUid:auth.currentUser.uid,status:'신규',estimateMin:data.estimateMin};
      if(data.estimateMax!==null)payload.estimateMax=data.estimateMax;
      try{await f.setDoc(f.doc(db,'quote_requests',data.id),payload);return false;}catch(e){return e.code==='permission-denied';}
    },replayData);
    assert.equal(otherReplay,true,'new session cannot overwrite an existing request ID');
    assert.equal((await db.collection('quote_requests').get()).size,1,'replays do not create a second request');
    await other.close();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('okclean-reservation-attempt-v1')),null,'acknowledged ID is removed');
    await page.locator('#reserveNew').click();
    await page.locator('#reserveName').fill('가상두번째');
    await page.locator('#reservePhone').fill('01000000001');
    await page.locator('#reserveSize').fill('20');
    await page.locator('#reserveNotes').fill('가상 두번째 요청');
    await page.locator('#reserveConsent').check();
    await page.locator('#reserveSubmit').click();
    await page.waitForFunction(()=>document.querySelector('#reserveStatus').textContent.includes('시험 접수 완료'),null,{timeout:30000});
    const second=(await page.locator('#reserveStatus').innerText()).match(/접수번호: ([a-f0-9-]+)/)?.[1];
    assert.ok(second && second!==id,'a deliberate new reservation gets a new ID');
    assert.equal((await db.collection('quote_requests').get()).size,2);
    const denied=await page.evaluate(async()=>{
      const f=await import('/firebase-bundle.js'), app=f.getApp('reservation-emulator');
      try{await f.getDocs(f.collection(f.getFirestore(app),'quote_requests'));return false;}catch(e){return e.code==='permission-denied';}
    });
    assert.equal(denied,true,'customer must not list requests');
    assert.deepEqual(errors,[]);
    const manager=await context(), adminPage=await manager.newPage(),adminErrors=[];
    adminPage.on('pageerror',e=>adminErrors.push(e.message));
    await adminPage.goto(base+'/admin/index.html',{waitUntil:'load'});
    await adminPage.waitForFunction(async()=>{const f=await import('/firebase-bundle.js');return f.getApps().some(a=>a.name==='[DEFAULT]');});
    await adminPage.evaluate(async ({email,password})=>{
      const f=await import('/firebase-bundle.js');await f.signInWithEmailAndPassword(f.getAuth(),email,password);
    },{email,password});
    const card=adminPage.locator('#reservationList article').filter({hasText:'가상고객'});
    await card.waitFor({state:'visible',timeout:30000});
    assert.match(await card.innerText(),/가상 요청사항/);
    await card.locator('select').selectOption('상담중');
    await card.getByRole('button',{name:'상태 저장'}).click();
    await adminPage.getByText('상태가 저장되었습니다.').waitFor();
    assert.equal((await db.collection('quote_requests').doc(id).get()).data().status,'상담중');
    await adminPage.reload({waitUntil:'load'});
    const restored=adminPage.locator('#reservationList article').filter({hasText:'가상고객'});
    await restored.waitFor({state:'visible',timeout:30000});
    assert.equal(await restored.locator('select').inputValue(),'상담중');
    assert.deepEqual(adminErrors,[]);
    await manager.close();await customer.close();
    // A write with its Firestore network blocked remains uncertain across reload.
    const interrupted=await context(), interruptedPage=await interrupted.newPage();
    await interruptedPage.goto(base+'/',{waitUntil:'load'});
    await interruptedPage.locator('#qArea').selectOption('춘천');
    await interruptedPage.locator('#qDate').fill(date);
    await interruptedPage.locator('#qReserve').click();
    await interruptedPage.locator('#reserveName').fill('가상대기');
    await interruptedPage.locator('#reservePhone').fill('01000000002');
    await interruptedPage.locator('#reserveSize').fill('15');
    await interruptedPage.locator('#reserveNotes').fill('가상 대기 요청');
    await interruptedPage.locator('#reserveConsent').check();
    await interrupted.route('http://127.0.0.1:8085/**',route=>route.abort());
    await interruptedPage.locator('#reserveSubmit').click();
    const pending=await interruptedPage.evaluate(()=>sessionStorage.getItem('okclean-reservation-attempt-v1'));
    assert.match(pending,/^[a-f0-9-]{36}$/);
    const storage=await interruptedPage.evaluate(()=>JSON.stringify({...sessionStorage}));
    assert.doesNotMatch(storage,/가상대기|01000000002|가상 대기 요청/);
    await interruptedPage.reload({waitUntil:'load'});
    await interruptedPage.locator('#qReserve').click();
    assert.equal(await interruptedPage.locator('#reserveSubmit').isDisabled(),true);
    assert.match(await interruptedPage.locator('#reserveStatus').innerText(),/확인되지 않았어요/);
    assert.equal(await interruptedPage.evaluate(()=>sessionStorage.getItem('okclean-reservation-attempt-v1')),pending);
    assert.equal((await db.collection('quote_requests').get()).size,2,'blocked in-flight attempt did not create another document');
    await interrupted.close();
    // Real SDK writes to the emulator; a test wrapper withholds its success
    // result from the UI, representing a lost/delayed application response.
    const lost=await context();
    await lost.route('**/reservation-emulator.js',route=>route.fulfill({
      status:200,contentType:'text/javascript',
      body:`import {submitReservation as real} from "${base}/reservation-real.js"; export async function submitReservation(...args){await real(...args);return new Promise(()=>{});}`
    }));
    const lostPage=await lost.newPage();
    await lostPage.goto(base+'/',{waitUntil:'load'});
    await lostPage.locator('#qArea').selectOption('춘천');
    await lostPage.locator('#qDate').fill(date);
    await lostPage.locator('#qReserve').click();
    await lostPage.locator('#reserveName').fill('가상응답지연');
    await lostPage.locator('#reservePhone').fill('01000000003');
    await lostPage.locator('#reserveSize').fill('15');
    await lostPage.locator('#reserveNotes').fill('가상 응답 지연');
    await lostPage.locator('#reserveConsent').check();
    await lostPage.locator('#reserveSubmit').click();
    const lostId=await lostPage.evaluate(()=>sessionStorage.getItem('okclean-reservation-attempt-v1'));
    assert.match(lostId,/^[a-f0-9-]{36}$/);
    let written;
    for(let i=0;i<100;i++){
      written=await db.collection('quote_requests').doc(lostId).get();
      if(written.exists)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(written.exists,'write reached emulator despite withheld UI result');
    assert.doesNotMatch(await lostPage.locator('#reserveStatus').innerText(),/접수 완료/);
    await lostPage.reload({waitUntil:'load'});
    await lostPage.locator('#qReserve').click();
    assert.equal(await lostPage.locator('#reserveSubmit').isDisabled(),true);
    assert.equal(await lostPage.evaluate(()=>sessionStorage.getItem('okclean-reservation-attempt-v1')),lostId);
    assert.equal((await db.collection('quote_requests').get()).size,3,'lost response plus reload must not duplicate');
    await lost.close();

    // Verified flow: real Auth/Firestore emulators and actual website form.
    cfg.reservation.verifiedEmulator=true;fs.writeFileSync(configPath,JSON.stringify(cfg));
    execFileSync('python3',['-c','import build; build.run()'],{cwd:root,stdio:'ignore'});
    const verified=await context(), vp=await verified.newPage();
    await vp.goto(base+'/',{waitUntil:'load'});await vp.locator('#qArea').selectOption('춘천');await vp.locator('#qDate').fill(date);await vp.locator('#qReserve').click();
    await vp.locator('#reserveEmail').fill(verifiedCustomer);await vp.locator('#reservePassword').fill(customerPassword);await vp.locator('#reserveLogin').click();
    await vp.getByText('시험 계정으로 로그인했습니다.').waitFor();
    await vp.locator('#reserveName').fill('검증고객');await vp.locator('#reservePhone').fill('01000000004');await vp.locator('#reserveSize').fill('25');await vp.locator('#reserveNotes').fill('검증 예약');await vp.locator('#reserveConsent').check();
    let capturedForm;await verified.route('**/emulator/reservation/submit',async route=>{capturedForm=route.request().postDataJSON().form;await route.fetch();await route.abort();});
    await vp.locator('#reserveSubmit').click();await vp.getByText(/접수 결과를 확인하지 못했습니다/).waitFor({timeout:30000});
    const verifiedId=await vp.evaluate(()=>sessionStorage.getItem('okclean-reservation-attempt-v1'));
    assert.ok((await db.collection('quote_requests').doc(verifiedId).get()).exists);
    await vp.reload({waitUntil:'load'});await vp.locator('#qReserve').click();await vp.locator('#reserveRecover').click();
    await vp.getByText('시험 접수 완료 · 접수번호: '+verifiedId).waitFor({timeout:30000});
    const newSession=await context(), np=await newSession.newPage();await np.goto(base+'/',{waitUntil:'load'});await np.locator('#qReserve').click();
    await np.locator('#reserveEmail').fill(verifiedCustomer);await np.locator('#reservePassword').fill(customerPassword);await np.locator('#reserveLogin').click();await np.getByText('시험 계정으로 로그인했습니다.').waitFor();
    await np.locator('#reserveReceipt').fill(verifiedId);await np.locator('#reserveRecover').click();await np.getByText('시험 접수 완료 · 접수번호: '+verifiedId).waitFor();
    const retry=await np.evaluate(async ({id,form})=>{const f=await import('/firebase-bundle.js'),a=f.getAuth(f.getApp('verified-reservation-emulator'));const token=await a.currentUser.getIdToken();const send=body=>fetch('/emulator/reservation/submit',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(body)}).then(r=>r.status);return [await send({requestId:id,form}),await send({requestId:id,form:{...form,notes:'변경'}})];},{id:verifiedId,form:capturedForm});
    assert.deepEqual(retry,[200,409],'same request succeeds; changed payload is rejected');
    const bad=await context(), bp=await bad.newPage();await bp.goto(base+'/',{waitUntil:'load'});await bp.locator('#qReserve').click();
    await bp.locator('#reserveEmail').fill(otherCustomer);await bp.locator('#reservePassword').fill(customerPassword);await bp.locator('#reserveLogin').click();await bp.getByText('시험 계정으로 로그인했습니다.').waitFor();
    await bp.locator('#reserveReceipt').fill(verifiedId);await bp.locator('#reserveRecover').click();await bp.getByText(/접수 여부를 확인하지 못했습니다/).waitFor();
    assert.equal((await db.collection('quote_requests').get()).size,4,'verified lost response recovered without duplicate');
    const manager2=await context(), mp=await manager2.newPage();await mp.goto(base+'/admin/index.html',{waitUntil:'load'});
    await mp.waitForFunction(async()=>{const f=await import('/firebase-bundle.js');return f.getApps().some(a=>a.name==='[DEFAULT]');});
    await mp.evaluate(async ({email,password})=>{const f=await import('/firebase-bundle.js');await f.signInWithEmailAndPassword(f.getAuth(),email,password);},{email,password});
    const vc=mp.locator('#reservationList article').filter({hasText:'검증고객'});await vc.waitFor({timeout:30000});await vc.locator('select').selectOption('상담중');await vc.getByRole('button',{name:'상태 저장'}).click();await mp.getByText('상태가 저장되었습니다.').waitFor();
    assert.equal((await db.collection('quote_requests').doc(verifiedId).get()).data().status,'상담중');
    await manager2.close();await bad.close();await newSession.close();await verified.close();
    console.log('PASS: verified server, lost response, reload, new session, access isolation and manager');
    console.log('PASS: real browser reservation -> emulators -> admin status -> reload');
  }finally{
    await browser.close();await new Promise(resolve=>server.close(resolve));await app.delete();
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
