'use strict';
const {test,before,beforeEach,after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {initializeTestEnvironment,assertFails} = require('@firebase/rules-unit-testing');
const {doc,getDocFromServer,getDocs,collection,setDoc,updateDoc,Timestamp} = require('firebase/firestore');
const {assignPartnerAsAdmin,revokeAssignmentAsAdmin,reviewPartnerAsAdmin,submitAssignedOffer} = require('./partner-matching-service.cjs');
const {createComparisonReader} = require('./comparison-reader.cjs');
const {createComparisonHandler} = require('./comparison-handler.cjs');
let env,admin,partner1,partner2,customer,compare,reader,allow,reads;
const account={email_verified:true,firebase:{sign_in_provider:'password'}};
const profile={company:'가상 업체 하나',areas:['춘천'],specialties:['입주·이사 청소'],status:'승인',approvalVersion:1};
async function seed(callback){return env.withSecurityRulesDisabled(c=>callback(c.firestore()));}
const call=(idToken='owner',requestId='r')=>compare({idToken,requestId});
before(async()=>{
 env=await initializeTestEnvironment({projectId:'demo-okclean-matching',firestore:{rules:fs.readFileSync('prototype/security/firestore.rules','utf8')}});
 admin=env.authenticatedContext('admin',{admin:true}).firestore();
 partner1=env.authenticatedContext('p1',account).firestore();
 partner2=env.authenticatedContext('p2',account).firestore();
 customer=env.authenticatedContext('customer',account).firestore();
 reader=createComparisonReader(admin);
});
beforeEach(async()=>{
 await env.clearFirestore(); allow=true; reads=0;
 await seed(async db=>{
  await setDoc(doc(db,'quote_requests','r'),{service:'입주·이사 청소',area:'춘천',size:25,date:Timestamp.fromMillis(Date.now()+7*86400000),status:'신규',ownerUid:'customer',name:'PRIVATE-CUSTOMER',phone:'01000000000'});
  await setDoc(doc(db,'partner_profiles','p1'),profile);
  await setDoc(doc(db,'partner_profiles','p2'),{...profile,company:'가상 업체 둘'});
 });
 compare=createComparisonHandler({
  verifyIdToken:async token=>{
   if(token==='invalid') throw Error('SECRET TOKEN');
   if(token==='anonymous')return {uid:'customer',firebase:{sign_in_provider:'anonymous'}};
   if(token==='unverified')return {uid:'customer',email_verified:false,firebase:{sign_in_provider:'password'}};
   return {uid:token==='owner'?'customer':'other',...account};
  },
  enforceRateLimit:async()=>allow,
  loadOwnedComparison:async(...args)=>{reads++;return reader(...args);}
 });
});
after(async()=>{if(env)await env.cleanup();});

test('owner receives only approved, assigned offers without PII or internal IDs',async()=>{
 const a=await assignPartnerAsAdmin(admin,'r','p1');
 const b=await assignPartnerAsAdmin(admin,'r','p2');
 await submitAssignedOffer(partner1,'r',a.grantId,{price:250000,note:'PRIVATE-NOTE'});
 await submitAssignedOffer(partner2,'r',b.grantId,{price:300000,note:'PRIVATE-NOTE'});
 const result=await call();
 assert.deepEqual(result,{httpStatus:200,body:{status:'ok',offers:[{company:'가상 업체 하나',price:250000},{company:'가상 업체 둘',price:300000}]}});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|01000000000|p1|p2|grant|ownerUid/);
 await assertFails(getDocFromServer(doc(customer,'quote_requests','r')));
 await assertFails(getDocs(collection(customer,'quote_requests','r','offers')));
});
test('other and missing requests are indistinguishable',async()=>{
 await assignPartnerAsAdmin(admin,'r','p1');
 assert.deepEqual(await call('other','r'),await call('owner','missing'));
 assert.deepEqual(await call('other','r'),{httpStatus:404,body:{status:'unavailable'}});
});
test('invalid, anonymous, unverified and rate-limited callers never reach reader',async()=>{
 assert.equal((await call('invalid')).httpStatus,401);
 assert.equal((await call('anonymous')).httpStatus,403);
 assert.equal((await call('unverified')).httpStatus,403);
 assert.equal((await call('owner','../bad')).httpStatus,400);
 allow=false;assert.equal((await call()).httpStatus,429);
 assert.equal(reads,0);
});
test('no offers or a pending offer returns an empty list',async()=>{
 await assignPartnerAsAdmin(admin,'r','p1');
 assert.deepEqual((await call()).body,{status:'ok',offers:[]});
});
test('withdrawal and reapproval do not revive old offer',async()=>{
 const a=await assignPartnerAsAdmin(admin,'r','p1');
 await submitAssignedOffer(partner1,'r',a.grantId,{price:250000});
 await reviewPartnerAsAdmin(admin,'p1','반려');
 assert.deepEqual((await call()).body.offers,[]);
 await reviewPartnerAsAdmin(admin,'p1','승인');
 assert.deepEqual((await call()).body.offers,[]);
});
test('new grant after reassignment shows only new offer',async()=>{
 const a=await assignPartnerAsAdmin(admin,'r','p1');
 await submitAssignedOffer(partner1,'r',a.grantId,{price:250000});
 await revokeAssignmentAsAdmin(admin,'r','p1');
 const b=await assignPartnerAsAdmin(admin,'r','p1');
 assert.deepEqual((await call()).body.offers,[]);
 await submitAssignedOffer(partner1,'r',b.grantId,{price:350000});
 assert.deepEqual((await call()).body.offers,[{company:'가상 업체 하나',price:350000}]);
});
test('closed or expired request does not return offers',async()=>{
 await assignPartnerAsAdmin(admin,'r','p1');
 await updateDoc(doc(admin,'quote_requests','r'),{status:'예약확정'});
 assert.equal((await call()).httpStatus,404);
 await seed(db=>updateDoc(doc(db,'quote_requests','r'),{status:'신규',date:Timestamp.fromMillis(Date.now()-1000)}));
 assert.equal((await call()).httpStatus,404);
});
test('broken slot or grant fails closed without error details',async()=>{
 await assignPartnerAsAdmin(admin,'r','p1');
 await seed(db=>updateDoc(doc(db,'quote_requests','r','slots','0'),{grantId:'forged'}));
 assert.deepEqual(await call(),{httpStatus:503,body:{status:'unavailable'}});
});
test('handler exposes only allowed fields and rejects invalid upstream output',async()=>{
 const mk=loadOwnedComparison=>createComparisonHandler({verifyIdToken:async()=>({uid:'customer',...account}),enforceRateLimit:async()=>true,loadOwnedComparison});
 const h=mk(async()=>[{company:'가상 업체',price:100,phone:'PRIVATE',uid:'private-id',note:'private-note'}]);
 assert.deepEqual(await h({idToken:'x',requestId:'r'}),{httpStatus:200,body:{status:'ok',offers:[{company:'가상 업체',price:100}]}});
 for(const data of [[{company:'가상',price:0}],Array(4).fill({company:'가상',price:100}),'bad']){
  assert.equal((await mk(async()=>data)({idToken:'x',requestId:'r'})).httpStatus,503);
 }
 assert.equal((await mk(async()=>{throw Error('SECRET DB')})({idToken:'x',requestId:'r'})).httpStatus,503);
 assert.throws(()=>createComparisonHandler({}),TypeError);
});
