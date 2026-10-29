'use strict';
// Makes HTTP requests to the container and authenticates against the Firebase emulator.
const assert=require('node:assert/strict');
const admin=require('firebase-admin');
const project='demo-okclean-integration';
if(process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!==project)throw Error('Loopback demo emulators required');
const phase=process.argv[2];if(!['seed','verify'].includes(phase))throw Error('Expected seed or verify');
const password='synthetic-test-password',emails={customer:'container-user@example.test',other:'container-other@example.test',manager:'container-admin@example.test'};
async function main(){
 const app=admin.initializeApp({projectId:project}),auth=admin.auth(app),db=admin.firestore(app);
 try{
  if(phase==='seed'){
   for(const [uid,email] of Object.entries(emails))await auth.createUser({uid:uid==='manager'?'REPLACE_WITH_ADMIN_UID':'container-'+uid,email,password,emailVerified:true});
   await auth.setCustomUserClaims('REPLACE_WITH_ADMIN_UID',{admin:true});
  }
  const signIn=async email=>{const r=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=unused-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});const d=await r.json();assert.ok(d.idToken);return d.idToken;};
  const [customer,other,manager]=await Promise.all(Object.values(emails).map(signIn));
  const send=async(path,token,body)=>{const r=await fetch('http://127.0.0.1:8799'+path,{method:'POST',headers:{'content-type':'application/json',origin:'https://ok-clean.github.io',authorization:'Bearer '+token,'x-firebase-appcheck':'test-app-check'},body:JSON.stringify(body)});return {code:r.status,body:await r.json()};};
  const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
  const services=require('../config.json').services, {version}=require('../server/pricing.cjs');
  const service=services.find(s=>s.id==='move-in');assert.ok(service?.tiers?.length);
  const form={service:'입주·이사 청소',area:'춘천',size:20,date,name:'가상고객',phone:'01000000005',notes:'가상 요청',consent:true,consentVersion:'test-v1',pricing:{serviceId:'move-in',variant:0,tier:0,quantity:null,options:[],policyVersion:version(services)}};
  if(!service.tiers[0].quote){form.estimateMin=service.tiers[0].price;if(!service.kinds?.[0]?.open)form.estimateMax=service.tiers[0].price;}
  const req={requestId:'container-check',form};
  if(phase==='seed'){
   assert.equal((await send('/reservation/submit',customer,req)).code,200);
   assert.equal((await send('/reservation/submit',customer,req)).code,200);
   assert.equal((await db.collection('quote_requests').get()).size,1);
  }else{
   assert.equal((await send('/reservation/status',customer,{requestId:req.requestId})).code,200);
   assert.equal((await send('/reservation/status',other,{requestId:req.requestId})).code,404);
   assert.equal((await send('/reservation/submit',customer,req)).code,200);
   assert.equal((await send('/admin/list',customer,{})).code,403);
   assert.equal((await send('/admin/list',manager,{})).body.items.length,1);
   assert.equal((await send('/admin/status',manager,{requestId:req.requestId,status:'상담중'})).code,200);
   assert.equal((await db.collection('quote_requests').doc(req.requestId).get()).data().status,'상담중');
   assert.equal((await db.collection('quote_requests').get()).size,1);
  }
  console.log(`PASS container HTTP ${phase}: Auth/Firestore emulators; App Check stubbed`);
 }finally{await app.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
