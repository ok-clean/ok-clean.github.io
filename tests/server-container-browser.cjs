'use strict';
// Real production client in a browser, a locally built server container and Auth/Firestore emulators.
// App Check and network routing are test-only; no calls to production are allowed.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const {chromium}=require('playwright');const admin=require('firebase-admin');
const project='demo-okclean-integration',origin='https://ok-clean.github.io',api='https://reservation-integration.run.app';
if(process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!==project)throw Error('Loopback demo emulators required');
async function main(){
 execFileSync('python3',['tests/build-generated-fixture.py'],{stdio:'ignore'});
 const root=fs.readFileSync('/tmp/okclean-generated-root.txt','utf8').trim();if(!root.startsWith('/tmp/okclean-generated-'))throw Error('Unexpected fixture');
 fs.copyFileSync('reservation-api.js',path.join(root,'reservation-api-real.js'));
 fs.copyFileSync('member-sync.js',path.join(root,'member-sync.js'));
 fs.writeFileSync(path.join(root,'reservation-api.js'), `export * from './reservation-api-real.js'; import {login as realLogin} from './reservation-api-real.js'; export async function login(...args){try{return await realLogin(...args)}catch(e){console.log('TEST_LOGIN_ERROR', e?.code || e?.name || 'unknown');throw e}}`);fs.copyFileSync('/tmp/okclean-firebase-bundle.js',path.join(root,'firebase-bundle.js'));
 fs.mkdirSync(path.join(root,'admin'),{recursive:true});for(const name of ['admin.js','index.html'])fs.copyFileSync('admin/'+name,path.join(root,'admin',name));
 const configPath=path.join(root,'config.json'),cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
 cfg.services=JSON.parse(fs.readFileSync('config.json','utf8')).services;
 cfg.firebase={apiKey:'fake-test-identifier',authDomain:'localhost',projectId:project,appId:'1:123:web:fake'};
 cfg.reservation={enabled:true,withdrawalEnabled:true,withdrawalPolicyReviewed:true,memberLinkEnabled:true,memberLinkPolicyReviewed:true,memberLinkPolicyVersion:'test-member-v1',apiUrl:api,appCheckSiteKey:'synthetic-test-site-key',consentText:'가상 시험 동의',consentVersion:'test-v1',privacy:{operator:'가상 사업자',officer:'가상 책임자',retention:'시험 후 삭제',policyUrl:'https://ok-clean.github.io/privacy-test',reviewed:true}};
 fs.writeFileSync(configPath,JSON.stringify(cfg));execFileSync('python3',['-c','import build; build.run()'],{cwd:root,stdio:'ignore'});
 const fb=admin.initializeApp({projectId:project},'container-browser'),db=admin.firestore(fb);
 const browser=await chromium.launch({headless:true});
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json'};
 async function context({simulateMemberDenial=false}={}){
  const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await ctx.addInitScript(()=>{if(location.origin==='https://ok-clean.github.io')localStorage.setItem('joinLater',JSON.stringify(Date.now()));});
  await ctx.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.origin===origin && u.pathname==='/reservation-api.js'){const src=fs.readFileSync(path.join(root,'reservation-api.js'),'utf8').replace('export async function login(config,email,password,settings){const {auth}=await setup(config,settings);await signInWithEmailAndPassword(auth,email,password);return !!auth.currentUser?.emailVerified;}',"export async function login(config,email,password,settings){try{const {auth}=await setup(config,settings);await signInWithEmailAndPassword(auth,email,password);return !!auth.currentUser?.emailVerified;}catch(e){globalThis.__testAuthError=e.code||e.message||e.name;throw e;}}");return route.fulfill({status:200,contentType:'text/javascript',body:src});}
   if(u.origin===origin){const file=path.resolve(root,'.'+(u.pathname==='/'?'/index.html':u.pathname));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});return route.fulfill({status:200,contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});}
   if(u.origin===api){const response=await route.fetch({url:'http://127.0.0.1:8799'+u.pathname});return route.fulfill({response});}
   if(u.hostname==='127.0.0.1'&&u.port==='9099'){
    // Browser test origin is virtual HTTPS. Route to the real loopback Auth
    // emulator via Playwright, with explicit test-only CORS/PNA response headers.
    const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'content-type, x-client-version, x-firebase-client, x-firebase-gmpid, x-firebase-appcheck, authorization','Access-Control-Allow-Private-Network':'true'};
    if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
    const response=await route.fetch();return route.fulfill({response,headers:{...response.headers(),...headers}});
   }
   if(u.hostname==='127.0.0.1'&&u.port==='8085')return route.continue();
   if(u.origin==='https://www.gstatic.com'&&u.pathname==='/firebasejs/10.14.1/firebase-app-check.js')return route.fulfill({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:'export class ReCaptchaV3Provider {constructor(key){}} export function initializeAppCheck(){return {}} export async function getToken(){return {token:"test-app-check"}}'});
   if(u.origin==='https://www.gstatic.com'&&u.pathname==='/firebasejs/10.14.1/firebase-auth.js')return route.fulfill({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:`export * from '${origin}/firebase-bundle.js'; import {getAuth as real,connectAuthEmulator} from '${origin}/firebase-bundle.js'; const seen=new WeakSet(); export function getAuth(...args){const a=real(...args);if(!seen.has(a)){connectAuthEmulator(a,'http://127.0.0.1:9099',{disableWarnings:true});seen.add(a)}return a}`});
   if(u.origin==='https://www.gstatic.com'&&u.pathname==='/firebasejs/10.14.1/firebase-firestore.js'){
    const memberDenial=simulateMemberDenial ? `export function onSnapshot(...args){const fail=args[args.length-1];setTimeout(()=>fail({code:'permission-denied'}),0);return ()=>{};}` : '';
    return route.fulfill({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:`export * from '${origin}/firebase-bundle.js'; import {getFirestore as real,connectFirestoreEmulator} from '${origin}/firebase-bundle.js'; const seen=new WeakSet(); export function getFirestore(...args){const d=real(...args);if(!seen.has(d)){connectFirestoreEmulator(d,'127.0.0.1',8085);seen.add(d)}return d} ${memberDenial}`});
   }
   if(u.origin==='https://www.gstatic.com'&&u.pathname==='/firebasejs/10.14.1/firebase-app.js')return route.fulfill({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:`export * from '${origin}/firebase-bundle.js'`});
   return route.abort();
  });return ctx;
 }
 try{
  const ctx=await context(),page=await ctx.newPage();
  page.on('console',m=>{const x=m.text();if(x.startsWith('TEST_LOGIN_ERROR'))console.log(x);});
  page.on('pageerror',e=>console.log('TEST_PAGE_ERROR',e.name));
  page.on('requestfailed',r=>{const u=new URL(r.url());if(u.hostname==='127.0.0.1'||u.hostname==='www.gstatic.com')console.log('TEST_REQUEST_FAILED',u.hostname,u.port||'',r.failure()?.errorText||'unknown');});
  await page.goto(origin+'/',{waitUntil:'load'});
  // Same-page member creation is the only way to obtain a candidate. Existing
  // local membership data is never matched by phone or name.
  await page.locator('[data-join]').first().click();await page.locator('#jName').fill('가상회원');await page.locator('#jPhone').fill('01000000009');await page.locator('#jAgree').check();await page.locator('#jSubmit').click();
  await page.getByText('회원정보 접수 요청이 완료됐어요. 카톡으로 가입을 확인해 주세요.').waitFor({timeout:30000});await page.locator('#join [data-close]').click();
  await page.locator('#qArea').selectOption('춘천');await page.locator('#qDate').fill(new Date(Date.now()+7*86400000).toISOString().slice(0,10));await page.locator('#qReserve').click();
  await page.locator('#reserveEmail').fill('container-user@example.test');await page.locator('#reservePassword').fill('synthetic-test-password');await page.locator('#reserveLogin').click();try{await page.getByText('로그인했습니다.').waitFor({timeout:10000});}catch{throw Error('login failed: '+await page.locator('#reserveStatus').innerText()+' / '+await page.evaluate(()=>globalThis.__testAuthError||'no-auth-error'));}
  await page.locator('#reserveMemberLinkSubmit').click();await page.getByText('회원 계정 연결에 동의해 주세요.').waitFor({timeout:10000});
  await page.locator('#reserveMemberLinkConsent').check();await page.locator('#reserveMemberLinkSubmit').click();await page.getByText('회원가입 요청과 예약 계정이 연결되었습니다. 다른 저장 자료는 별도로 확인해 주세요.').waitFor({timeout:30000});
  assert.equal((await db.collection('account_member_links').doc('container-customer').get()).exists,true);
  await page.locator('#reserveName').fill('가상브라우저');await page.locator('#reservePhone').fill('01000000006');await page.locator('#reserveSize').fill('20');await page.locator('#reserveNotes').fill('가상 요청');await page.locator('#reserveConsent').check();
  // Make the real server commit, then deliberately lose the response at browser boundary.
  await ctx.route(api+'/reservation/submit',async route=>{const response=await route.fetch({url:'http://127.0.0.1:8799/reservation/submit'});if(route.request().method()==='OPTIONS')return route.fulfill({response});await route.abort();});
  await page.locator('#reserveSubmit').click();await page.getByText(/접수 결과를 확인하지 못했습니다/).waitFor({timeout:30000});
  const id=await page.evaluate(()=>sessionStorage.getItem('okclean-reservation-attempt-v1'));assert.ok(id);assert.ok((await db.collection('quote_requests').doc(id).get()).exists);
  await page.reload({waitUntil:'load'});await page.locator('#qReserve').click();await page.locator('#reserveRecover').click();await page.getByText('예약 접수 완료 · 접수번호: '+id).waitFor({timeout:30000});
  const next=await context(),p=await next.newPage();await p.goto(origin+'/',{waitUntil:'load'});await p.locator('#qReserve').click();
  await p.locator('#reserveEmail').fill('container-user@example.test');await p.locator('#reservePassword').fill('synthetic-test-password');await p.locator('#reserveLogin').click();await p.getByText('로그인했습니다.').waitFor();
  await p.locator('#reserveMemberLinkSubmit').click();await p.getByText('이 화면에서 방금 접수한 회원 기록이 없습니다. 기존 회원 기록은 상담으로 확인해 주세요.').waitFor({timeout:10000});
  await p.locator('#reserveReceipt').fill(id);await p.locator('#reserveRecover').click();await p.getByText('예약 접수 완료 · 접수번호: '+id).waitFor();
  assert.equal((await db.collection('quote_requests').doc(id).get()).exists,true);
  await p.locator('#reserveListMine').click();await p.locator('#reserveOwnList').getByText(id,{exact:false}).waitFor({timeout:30000});
  assert.doesNotMatch(await p.locator('#reserveOwnList').innerText(),/01000000006|가상 요청/,'list must not display contact details or notes');
  await p.locator('#withdrawPassword').fill('wrong-synthetic-password');await p.locator('#withdrawRequest').click();await p.getByText(/탈퇴 요청을 확인하지 못했습니다/).waitFor();
  assert.equal((await db.collection('account_lifecycle').doc('container-customer').get()).exists,false);
  await p.locator('#withdrawPassword').fill('synthetic-test-password');await p.locator('#withdrawRequest').click();await p.getByText(/예약 계정 탈퇴 요청이 접수되었습니다/).waitFor({timeout:30000});
  const withdrawalLife=(await db.collection('account_lifecycle').doc('container-customer').get()).data();assert.equal(withdrawalLife.status,'withdrawal_requested');assert.equal(withdrawalLife.sessionRevocation,'revoked');
  assert.equal(await p.evaluate(async()=>{const f=await import('/firebase-bundle.js');return f.getAuth(f.getApp('production-reservation')).currentUser===null;}),true,'customer browser signs out after accepted request');
  assert.ok((await db.collection('quote_requests').doc(id).get()).exists,'request must not delete reservations or auth account');
  assert.equal(await p.locator('#reserveListMine').isDisabled(),true);
  await p.reload({waitUntil:'load'});await p.locator('#qReserve').click();
  await p.locator('#reserveEmail').fill('container-user@example.test');await p.locator('#reservePassword').fill('synthetic-test-password');await p.locator('#reserveLogin').click();
  await p.getByText(/예약 계정 탈퇴 요청을 처리 중입니다/).waitFor({timeout:30000});assert.equal(await p.locator('#reserveSubmit').isDisabled(),true);
  await p.evaluate(async()=>{const f=await import('/firebase-bundle.js');await f.signOut(f.getAuth(f.getApp('production-reservation')));});
  await p.waitForFunction(()=>document.querySelector('#reserveOwnList').textContent==='');
  const outsider=await context(),op=await outsider.newPage();await op.goto(origin+'/',{waitUntil:'load'});await op.locator('#qReserve').click();
  await op.locator('#reserveEmail').fill('container-other@example.test');await op.locator('#reservePassword').fill('synthetic-test-password');await op.locator('#reserveLogin').click();await op.getByText('로그인했습니다.').waitFor();
  await op.locator('#reserveListMine').click();await op.locator('#reserveOwnList').getByText('조회된 예약이 없습니다.').waitFor({timeout:30000});
  assert.doesNotMatch(await op.locator('#reserveOwnList').innerText(),new RegExp(id));await outsider.close();
  const manager=await context(),mp=await manager.newPage();await mp.goto(origin+'/admin/index.html',{waitUntil:'load'});
  await mp.waitForFunction(async()=>{const f=await import('/firebase-bundle.js');return f.getApps().some(a=>a.name==='[DEFAULT]');});
  await mp.evaluate(async()=>{const f=await import('/firebase-bundle.js');await f.signInWithEmailAndPassword(f.getAuth(),'container-admin@example.test','synthetic-test-password');});
  const card=mp.locator('#reservationList article').filter({hasText:'가상브라우저'});await card.waitFor({timeout:30000});await card.locator('select').selectOption('상담중');await card.getByRole('button',{name:'상태 저장'}).click();await mp.getByText('상태가 저장되었습니다.').waitFor();
  assert.equal((await db.collection('quote_requests').doc(id).get()).data().status,'상담중');await card.getByRole('button',{name:'처리 이력'}).click();await card.getByText('신규 → 상담중').waitFor({timeout:30000});
  // A reservation-only admin must retain its server-backed reservation view when
  // Firestore member-list denial callback is explicitly simulated here; separate
  // emulator REST assertions exercise the actual rules with real test tokens.
  const reserveOnly=await context({simulateMemberDenial:true}),rp=await reserveOnly.newPage();await rp.goto(origin+'/admin/index.html',{waitUntil:'load'});
  await rp.waitForFunction(async()=>{const f=await import('/firebase-bundle.js');return f.getApps().some(a=>a.name==='[DEFAULT]');});
  await rp.evaluate(async()=>{const f=await import('/firebase-bundle.js');await f.signInWithEmailAndPassword(f.getAuth(),'container-reservation@example.test','synthetic-test-password');});
  const reserveCard=rp.locator('#reservationList article').filter({hasText:'가상브라우저'});await reserveCard.waitFor({timeout:30000});
  await rp.getByText(/회원 목록에 접근할 수 없습니다/).waitFor({timeout:30000});
  assert.equal(await rp.locator('#dashboard').isHidden(),true,'member ledger is not shown');
  assert.equal(await reserveCard.isVisible(),true,'reservation view survives independent member permission failure');
  await reserveCard.locator('select').selectOption('예약확정');await reserveCard.getByRole('button',{name:'상태 저장'}).click();await rp.getByText('상태가 저장되었습니다.').waitFor();
  assert.equal((await db.collection('quote_requests').doc(id).get()).data().status,'예약확정');
  await reserveOnly.close();await manager.close();await next.close();await ctx.close();console.log('PASS production client -> container server -> Firebase emulators, App Check test double');
 }finally{await browser.close();await fb.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
