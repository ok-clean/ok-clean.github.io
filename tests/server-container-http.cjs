'use strict';
// Makes HTTP requests to the container and authenticates against the Firebase emulator.
const assert=require('node:assert/strict');
const admin=require('firebase-admin');
const project='demo-okclean-integration';
if(process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!==project)throw Error('Loopback demo emulators required');
const phase=process.argv[2];if(!['seed','verify'].includes(phase))throw Error('Expected seed or verify');
const password='synthetic-test-password',emails={customer:'container-user@example.test',other:'container-other@example.test',manager:'container-admin@example.test',reservation:'container-reservation@example.test',member:'container-member@example.test',withdraw:'container-withdraw@example.test'};
async function main(){
 const app=admin.initializeApp({projectId:project}),auth=admin.auth(app),db=admin.firestore(app);
 try{
  if(phase==='seed'){
   for(const [uid,email] of Object.entries(emails))await auth.createUser({uid:uid==='manager'?'REPLACE_WITH_ADMIN_UID':'container-'+uid,email,password,emailVerified:true});
   await auth.setCustomUserClaims('REPLACE_WITH_ADMIN_UID',{admin:true});
   await auth.setCustomUserClaims('container-reservation',{reservation_admin:true});
   await auth.setCustomUserClaims('container-member',{member_admin:true});
   await db.collection('member_requests').doc('container-fixture').set({name:'가상회원',joined:new Date()});
  }
  const signIn=async email=>{const r=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=unused-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});const d=await r.json();assert.ok(d.idToken);return d.idToken;};
  const [customer,other,manager,reservation,member,withdraw]=await Promise.all(Object.values(emails).map(signIn));
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
   // Query the real Firestore emulator as the synthetic users; never Admin SDK.
   const memberDoc='http://127.0.0.1:8085/v1/projects/'+project+'/databases/(default)/documents/member_requests/container-fixture';
   const readMember=token=>fetch(memberDoc,{headers:{authorization:'Bearer '+token}}).then(r=>r.status);
   assert.equal(await readMember(reservation),403,'reservation-only admin must not read member data');
   assert.equal(await readMember(customer),403,'customer must not read member data');
   assert.equal(await readMember(member),200,'member admin can read member data');
   assert.equal((await send('/admin/list',customer,{})).code,403);
   assert.equal((await send('/admin/list',member,{})).code,403);
   assert.equal((await send('/admin/list',reservation,{})).code,200);
   // The same still-valid token must lose access when current Auth claims are removed.
   await auth.setCustomUserClaims('container-reservation',{});
   assert.equal((await send('/admin/list',reservation,{})).code,403);
   assert.equal((await send('/admin/history',reservation,{requestId:req.requestId})).code,403);
   assert.equal((await send('/admin/status',reservation,{requestId:req.requestId,status:'상담중'})).code,403);
   await auth.setCustomUserClaims('container-reservation',{reservation_admin:true});
   assert.equal((await send('/admin/list',manager,{})).body.items.length,1);
   assert.equal((await send('/admin/status',manager,{requestId:req.requestId,status:'상담중'})).code,200);
   assert.equal((await db.collection('quote_requests').doc(req.requestId).get()).data().status,'상담중');
   assert.equal((await db.collection('quote_requests').get()).size,1);
   assert.equal((await send('/reservation/withdraw',manager,{})).code,403,'administrators are protected');
   assert.equal((await send('/reservation/submit',withdraw,{requestId:'withdraw-booking',form})).code,200);
   // Separate Auth token issuance from revocation by at least one second.
   await new Promise(resolve=>setTimeout(resolve,1100));
   assert.equal((await send('/reservation/withdraw',withdraw,{})).body.status,'pending');
   assert.equal((await db.collection('account_lifecycle').doc('container-withdraw').get()).data().sessionRevocation,'revoked');
   await assert.rejects(()=>auth.verifyIdToken(withdraw,true));
   assert.notEqual((await send('/reservation/list',withdraw,{})).code,200,'the revoked session must not access reservations');
   const freshWithdraw=await signIn(emails.withdraw);
   assert.equal((await send('/reservation/list',freshWithdraw,{})).code,403);
   assert.equal((await send('/reservation/status',freshWithdraw,{requestId:'withdraw-booking'})).code,404);
   assert.equal((await send('/reservation/submit',freshWithdraw,{requestId:'withdraw-after',form})).code,409);
   assert.equal((await send('/reservation/withdraw',freshWithdraw,{})).body.status,'pending');
   assert.ok((await db.collection('quote_requests').doc('withdraw-booking').get()).exists,'no reservation deleted');
   assert.ok(await auth.getUser('container-withdraw'),'no Auth account deleted');
   // Run the freeze against an actual Firestore transaction concurrently with
   // the real container's admin status writer. Only one order may win.
   const probe=db.collection('quote_requests').doc('freeze-probe');
   const freeze=db.collection('account_lifecycle').doc('synthetic-freeze-owner');
   await probe.create({ownerUid:'synthetic-freeze-owner',status:'신규'});
   const [_,during]=await Promise.all([
    db.runTransaction(async tx=>{await tx.get(freeze);tx.set(freeze,{status:'withdrawal_requested',dataMutationFrozen:true});}),
    send('/admin/status',manager,{requestId:'freeze-probe',status:'상담중'})
   ]);
   assert.ok([200,409].includes(during.code));
   const historyCount=(await probe.collection('status_history').get()).size;
   assert.equal((await send('/admin/status',manager,{requestId:'freeze-probe',status:'예약확정'})).code,409);
   assert.equal((await probe.collection('status_history').get()).size,historyCount,'no related history after account freeze');
   // Race the retention parent's freeze with the real container admin writer.
   // Only known server writers are covered; direct Admin SDK writers remain a
   // production blocker and are deliberately simulated separately below.
   const retained=db.collection('quote_requests').doc('retention-freeze-probe');
   await retained.create({ownerUid:'synthetic-retention-owner',status:'종료',legalHold:false,name:'가상보존'});
   await retained.collection('status_history').doc('terminal').create({to:'종료',at:new Date('2020-01-01T00:00:00Z')});
   const retention=require('../server/retention.cjs').createRetentionService({db,projectId:project,firestoreHost:'127.0.0.1:8085',policy:{reservationDays:30,historyDays:90},clock:()=>new Date('2030-03-01T00:00:00Z'),authorize:async()=>true});
   let retainedPlan=await retention.process(retained.id);
   assert.equal(retainedPlan.result,'would_redact');
   const doFreeze=plan=>retention.freeze(retained.id,{expectedAction:'redacted',expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence:async()=>true});
   const [freezeOutcome,adminRace]=await Promise.all([doFreeze(retainedPlan),send('/admin/status',manager,{requestId:retained.id,status:'예약확정'})]);
   assert.ok(['frozen','changed'].includes(freezeOutcome.result));
   if(freezeOutcome.result==='frozen')assert.equal(adminRace.code,409);
   else {assert.equal(adminRace.code,200);retainedPlan=await retention.process(retained.id);assert.equal(retainedPlan.result,'would_redact');assert.equal((await doFreeze(retainedPlan)).result,'frozen');}
   const retainedHistoryCount=(await retained.collection('status_history').get()).size;
   assert.equal((await send('/admin/status',manager,{requestId:retained.id,status:'작업완료'})).code,409);
   assert.equal((await retained.collection('status_history').get()).size,retainedHistoryCount);
   // A synthetic Admin SDK bypass can still add an unknown subcollection. It
   // is detected on the subsequent scan and deletion stays blocked.
   await retained.collection('unknown-related-data').doc('synthetic').create({synthetic:true});
   assert.equal((await retention.process(retained.id,{apply:true,transactionFence:async()=>true})).result,'blocked_dependencies');
   assert.equal((await retained.get()).data().name,'가상보존');
   // A still-valid privileged ID token must not bypass an actor's lifecycle gate.
   const adminLife=db.collection('account_lifecycle').doc('REPLACE_WITH_ADMIN_UID');
   await adminLife.create({status:'withdrawal_requested'});
   assert.equal((await send('/admin/list',manager,{})).code,403);
   assert.equal((await send('/admin/history',manager,{requestId:req.requestId})).code,403);
   assert.equal((await send('/admin/status',manager,{requestId:req.requestId,status:'예약확정'})).code,403);
   await adminLife.delete();
   assert.equal((await send('/admin/list',manager,{})).code,200);
  }
  console.log(`PASS container HTTP ${phase}: Auth/Firestore emulators; App Check stubbed`);
 }finally{await app.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
