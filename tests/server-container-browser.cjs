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
 fs.writeFileSync(path.join(root,'reservation-api.js'), `export * from './reservation-api-real.js'; import {login as realLogin} from './reservation-api-real.js'; export async function login(...args){try{return await realLogin(...args)}catch(e){console.log('TEST_LOGIN_ERROR', e?.code || e?.name || 'unknown');throw e}}`);fs.copyFileSync('/tmp/okclean-firebase-bundle.js',path.join(root,'firebase-bundle.js'));
 fs.mkdirSync(path.join(root,'admin'),{recursive:true});for(const name of ['admin.js','index.html'])fs.copyFileSync('admin/'+name,path.join(root,'admin',name));
 const configPath=path.join(root,'config.json'),cfg=JSON.parse(fs.readFileSync(configPath,'utf8'));
 cfg.services=JSON.parse(fs.readFileSync('config.json','utf8')).services;
 cfg.firebase={apiKey:'fake-test-identifier',authDomain:'localhost',projectId:project,appId:'1:123:web:fake'};
 cfg.reservation={enabled:true,apiUrl:api,appCheckSiteKey:'synthetic-test-site-key',consentText:'가상 시험 동의',consentVersion:'test-v1',privacy:{operator:'가상 사업자',officer:'가상 책임자',retention:'시험 후 삭제',policyUrl:'https://ok-clean.github.io/privacy-test',reviewed:true}};
 fs.writeFileSync(configPath,JSON.stringify(cfg));execFileSync('python3',['-c','import build; build.run()'],{cwd:root,stdio:'ignore'});
 const fb=admin.initializeApp({projectId:project},'container-browser'),db=admin.firestore(fb);
 const browser=await chromium.launch({headless:true});
 const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.json':'application/json'};
 async function context(){
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
   if(u.origin==='https://www.gstatic.com'&&u.pathname==='/firebasejs/10.14.1/firebase-firestore.js')return route.fulfill({status:200,contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'},body:`export * from '${origin}/firebase-bundle.js'; import {getFirestore as real,connectFirestoreEmulator} from '${origin}/firebase-bundle.js'; const seen=new WeakSet(); export function getFirestore(...args){const d=real(...args);if(!seen.has(d)){connectFirestoreEmulator(d,'127.0.0.1',8085);seen.add(d)}return d}`});
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
  await page.locator('#qArea').selectOption('춘천');await page.locator('#qDate').fill(new Date(Date.now()+7*86400000).toISOString().slice(0,10));await page.locator('#qReserve').click();
  await page.locator('#reserveEmail').fill('container-user@example.test');await page.locator('#reservePassword').fill('synthetic-test-password');await page.locator('#reserveLogin').click();try{await page.getByText('로그인했습니다.').waitFor({timeout:10000});}catch{throw Error('login failed: '+await page.locator('#reserveStatus').innerText()+' / '+await page.evaluate(()=>globalThis.__testAuthError||'no-auth-error'));}
  await page.locator('#reserveName').fill('가상브라우저');await page.locator('#reservePhone').fill('01000000006');await page.locator('#reserveSize').fill('20');await page.locator('#reserveNotes').fill('가상 요청');await page.locator('#reserveConsent').check();
  // Make the real server commit, then deliberately lose the response at browser boundary.
  await ctx.route(api+'/reservation/submit',async route=>{const response=await route.fetch({url:'http://127.0.0.1:8799/reservation/submit'});if(route.request().method()==='OPTIONS')return route.fulfill({response});await route.abort();});
  await page.locator('#reserveSubmit').click();await page.getByText(/접수 결과를 확인하지 못했습니다/).waitFor({timeout:30000});
  const id=await page.evaluate(()=>sessionStorage.getItem('okclean-reservation-attempt-v1'));assert.ok(id);assert.ok((await db.collection('quote_requests').doc(id).get()).exists);
  await page.reload({waitUntil:'load'});await page.locator('#qReserve').click();await page.locator('#reserveRecover').click();await page.getByText('예약 접수 완료 · 접수번호: '+id).waitFor({timeout:30000});
  const next=await context(),p=await next.newPage();await p.goto(origin+'/',{waitUntil:'load'});await p.locator('#qReserve').click();
  await p.locator('#reserveEmail').fill('container-user@example.test');await p.locator('#reservePassword').fill('synthetic-test-password');await p.locator('#reserveLogin').click();await p.getByText('로그인했습니다.').waitFor();
  await p.locator('#reserveReceipt').fill(id);await p.locator('#reserveRecover').click();await p.getByText('예약 접수 완료 · 접수번호: '+id).waitFor();
  assert.equal((await db.collection('quote_requests').doc(id).get()).exists,true);
  const manager=await context(),mp=await manager.newPage();await mp.goto(origin+'/admin/index.html',{waitUntil:'load'});
  await mp.waitForFunction(async()=>{const f=await import('/firebase-bundle.js');return f.getApps().some(a=>a.name==='[DEFAULT]');});
  await mp.evaluate(async()=>{const f=await import('/firebase-bundle.js');await f.signInWithEmailAndPassword(f.getAuth(),'container-admin@example.test','synthetic-test-password');});
  const card=mp.locator('#reservationList article').filter({hasText:'가상브라우저'});await card.waitFor({timeout:30000});await card.locator('select').selectOption('상담중');await card.getByRole('button',{name:'상태 저장'}).click();await mp.getByText('상태가 저장되었습니다.').waitFor();
  assert.equal((await db.collection('quote_requests').doc(id).get()).data().status,'상담중');await card.getByRole('button',{name:'처리 이력'}).click();await card.getByText('신규 → 상담중').waitFor({timeout:30000});
  await manager.close();await next.close();await ctx.close();console.log('PASS production client -> container server -> Firebase emulators, App Check test double');
 }finally{await browser.close();await fb.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
