'use strict';
// Real browser + Firebase Auth/Firestore emulators only. No production projects.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const admin=require('firebase-admin');
const project='demo-okclean-integration';
if(process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099' ||
   process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085' ||
   process.env.GCLOUD_PROJECT!==project) throw new Error('Loopback emulators and demo project are mandatory');

async function main(){
  execFileSync('python3',['tests/build-generated-fixture.py'],{stdio:'ignore'});
  const root=fs.readFileSync('/tmp/okclean-generated-root.txt','utf8').trim();
  if(!root.startsWith('/tmp/okclean-generated-'))throw new Error('Unexpected fixture directory');
  for(const name of ['reservation-emulator.js','admin/admin.js','admin/index.html']){
    const dest=path.join(root,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(name,dest);
  }
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
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json'};
  const server=http.createServer((req,res)=>{
    let pathname;
    try {pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400);return res.end();}
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
    console.log('PASS: real browser reservation -> emulators -> admin status -> reload');
  }finally{
    await browser.close();await new Promise(resolve=>server.close(resolve));await app.delete();
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
