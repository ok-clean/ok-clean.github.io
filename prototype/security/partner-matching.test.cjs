'use strict';
// REAL Firestore emulator rules tests; synthetic identities and records only.
const {test,before,after,beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {initializeTestEnvironment,assertFails,assertSucceeds} = require('@firebase/rules-unit-testing');
const {doc,collection,getDocFromServer,getDocs,setDoc,updateDoc,deleteDoc,writeBatch,serverTimestamp,Timestamp} = require('firebase/firestore');
const {reviewPartnerAsAdmin,assignPartnerAsAdmin,revokeAssignmentAsAdmin,readAssignedQuote,submitAssignedOffer} = require('./partner-matching-service.cjs');
let env,admin,p1,p2,pending,anon,stranger,requestData;
const account = {email_verified:true,firebase:{sign_in_provider:'password'}};
const profile = {company:'가상업체',areas:['춘천'],specialties:['입주·이사 청소'],status:'승인',approvalVersion:1};
const ref = (db,kind,id) => doc(db,'quote_requests','r',kind,id);
const rawOffer = price => ({price,note:'시험용',createdAt:serverTimestamp()});
async function seed(callback) { await env.withSecurityRulesDisabled(async c=>callback(c.firestore())); }
async function assign() {return (await assignPartnerAsAdmin(admin,'r','p1')).grantId;}
function rawAssign(db,uid,grantId,extra={},pointerExtra={}) {
 const batch = writeBatch(db);
 batch.set(ref(db,'grants',grantId),{partnerUid:uid,approvalVersion:1,service:requestData.service,area:requestData.area,size:requestData.size,date:requestData.date,createdAt:serverTimestamp(),...extra});
 batch.set(ref(db,'assignments',uid),{grantId,...pointerExtra});
 return batch.commit();
}
before(async()=>{
 env = await initializeTestEnvironment({projectId:'demo-okclean-matching',firestore:{rules:fs.readFileSync('prototype/security/firestore.rules','utf8')}});
 admin=env.authenticatedContext('admin',{admin:true}).firestore();
 p1=env.authenticatedContext('p1',account).firestore();p2=env.authenticatedContext('p2',account).firestore();
 pending=env.authenticatedContext('pending',account).firestore();
 anon=env.authenticatedContext('customer',{firebase:{sign_in_provider:'anonymous'}}).firestore();
 stranger=env.unauthenticatedContext().firestore();
});
beforeEach(async()=>{
 await env.clearFirestore();
 requestData={service:'입주·이사 청소',area:'춘천',size:25,date:Timestamp.fromMillis(Date.now()+7*86400000),status:'신규',ownerUid:'customer',name:'PRIVATE-NAME',phone:'PRIVATE-PHONE'};
 await seed(async db=>{
  await setDoc(doc(db,'quote_requests','r'),requestData);
  await setDoc(doc(db,'partner_profiles','p1'),profile);
  await setDoc(doc(db,'partner_profiles','p2'),profile);
  await setDoc(doc(db,'partner_profiles','pending'),{...profile,status:'검토중',approvalVersion:0});
 });
});
after(async()=>{if(env)await env.cleanup();});

test('approved assignment is atomic and returns no customer PII',async()=>{
 const grantId=await assign();const result=await readAssignedQuote(p1,'r','p1');
 assert.deepEqual(Object.keys(result).sort(),['grantId','service','area','size','date'].sort());
 assert.equal(result.grantId,grantId);assert.equal(result.area,'춘천');
 assert.deepEqual((await getDocFromServer(ref(admin,'assignments','p1'))).data(),{grantId});
 const grant=(await getDocFromServer(ref(admin,'grants',grantId))).data();
 assert.deepEqual(Object.keys(grant).sort(),['partnerUid','approvalVersion','service','area','size','date','createdAt'].sort());
 assert.doesNotMatch(JSON.stringify(grant),/PRIVATE|ownerUid|phone|name/);
});
test('provider cannot self-assign by service or raw write batch',async()=>{
 await assert.rejects(assignPartnerAsAdmin(p1,'r','p1'));
 await assertFails(rawAssign(p1,'p1','self'));
});
test('customer and unauthenticated callers cannot assign',async()=>{
 for(const db of [anon,stranger])await assertFails(rawAssign(db,'p1','forbidden'));
});
test('unapproved provider cannot be assigned even by administrator',async()=>{
 await assert.rejects(assignPartnerAsAdmin(admin,'r','pending'));
 await assertFails(rawAssign(admin,'pending','unapproved',{approvalVersion:0}));
});
test('missing provider cannot be assigned',async()=>{
 await assert.rejects(assignPartnerAsAdmin(admin,'r','missing'));
 await assertFails(rawAssign(admin,'missing','missing-profile'));
});
test('missing request cannot be assigned',async()=>{
 await assert.rejects(assignPartnerAsAdmin(admin,'missing','p1'));
 await seed(db=>deleteDoc(doc(db,'quote_requests','r')));
 await assertFails(rawAssign(admin,'p1','missing-request'));
});
test('past request blocks assignment',async()=>{
 await seed(db=>updateDoc(doc(db,'quote_requests','r'),{date:Timestamp.fromMillis(Date.now()-86400000)}));
 await assert.rejects(assignPartnerAsAdmin(admin,'r','p1'));
 await assertFails(rawAssign(admin,'p1','past'));
});
for(const status of ['예약확정','작업완료','종료'])test(status+' blocks new offers, new assignments and provider reads',async()=>{
 const grantId=await assign();await submitAssignedOffer(p1,'r',grantId,{price:250000});
 await updateDoc(doc(admin,'quote_requests','r'),{status});
 await assertFails(getDocFromServer(ref(p1,'grants',grantId)));
 await assertFails(getDocFromServer(ref(p1,'offers',grantId)));
 await assertFails(setDoc(ref(p1,'offers',grantId),rawOffer(260000)));
 await assertFails(rawAssign(admin,'p2','closed'));
 await assertSucceeds(getDocFromServer(ref(admin,'offers',grantId)));
 // A still-unused grant also rejects CREATE, not only duplicate UPDATE.
 await seed(db=>deleteDoc(ref(db,'offers',grantId)));
 await assertFails(setDoc(ref(p1,'offers',grantId),rawOffer(260000)));
});
test('expired existing grant blocks offer creation',async()=>{
 const grantId=await assign();await seed(db=>updateDoc(doc(db,'quote_requests','r'),{date:Timestamp.fromMillis(Date.now()-1)}));
 await assertFails(setDoc(ref(p1,'offers',grantId),rawOffer(100)));
});
test('pointer without immutable grant is rejected',async()=>{
 await assertFails(setDoc(ref(admin,'assignments','p1'),{grantId:'orphan'}));
});
test('grant without pointer is rejected',async()=>{
 await assertFails(setDoc(ref(admin,'grants','orphan'),{partnerUid:'p1',approvalVersion:1,service:requestData.service,area:requestData.area,size:25,date:requestData.date,createdAt:serverTimestamp()}));
});
test('pointer and grant partner mismatch rejects whole batch',async()=>{
 await assertFails(rawAssign(admin,'p1','mismatch',{partnerUid:'p2'}));
 assert.equal((await getDocFromServer(ref(admin,'assignments','p1'))).exists(),false);
 assert.equal((await getDocFromServer(ref(admin,'grants','mismatch'))).exists(),false);
});
test('contact fields are rejected in either public projection or pointer',async()=>{
 await assertFails(rawAssign(admin,'p1','phone',{phone:'DO-NOT-COPY'}));
 await assertFails(rawAssign(admin,'p1','owner',{ownerUid:'customer'}));
 await assertFails(rawAssign(admin,'p1','pointer',{}, {phone:'DO-NOT-COPY'}));
});
test('service, area, size and date projections must match original request',async()=>{
 for(const extra of [{service:'에어컨 청소'},{area:'홍천'},{size:26},{date:Timestamp.fromMillis(Date.now()+86400000)}])await assertFails(rawAssign(admin,'p1','tampered',extra));
});
test('approval version and createdAt cannot be forged',async()=>{
 await assertFails(rawAssign(admin,'p1','version',{approvalVersion:0}));
 await assertFails(rawAssign(admin,'p1','timestamp',{createdAt:Timestamp.fromMillis(0)}));
});
test('revoked grant ID cannot be replayed even by administrator',async()=>{
 const grantId=await assign();await revokeAssignmentAsAdmin(admin,'r','p1');
 await assertFails(setDoc(ref(admin,'assignments','p1'),{grantId}));
 await assertFails(rawAssign(admin,'p1',grantId));
});
test('concurrent assignment attempts create one pointer and one grant',async()=>{
 const results=await Promise.allSettled([assign(),assign()]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await getDocs(collection(admin,'quote_requests','r','grants'))).size,1);
 assert.equal((await getDocs(collection(admin,'quote_requests','r','assignments'))).size,1);
});
test('only assigned provider can read grant; lists and original PII are denied',async()=>{
 const grantId=await assign();await assertSucceeds(getDocFromServer(ref(p1,'grants',grantId)));
 for(const db of [p2,anon,stranger]){
  await assertFails(getDocFromServer(ref(db,'grants',grantId)));
  await assertFails(getDocFromServer(ref(db,'assignments','p1')));
 }
 await assertFails(getDocFromServer(doc(p1,'quote_requests','r')));
 await assertFails(getDocs(collection(p1,'quote_requests','r','grants')));
});
test('offer is create-only; spoofing another provider grant is denied',async()=>{
 const grantId=await assign();await assertFails(submitAssignedOffer(p2,'r',grantId,{price:100}));
 await submitAssignedOffer(p1,'r',grantId,{price:250000,note:'방문 가능'});
 await assertFails(submitAssignedOffer(p1,'r',grantId,{price:200000}));
 await assertFails(updateDoc(ref(p1,'offers',grantId),{price:1}));
 await assertFails(deleteDoc(ref(p1,'offers',grantId)));
 await assertFails(getDocFromServer(ref(p2,'offers',grantId)));
 await assertFails(getDocs(collection(p1,'quote_requests','r','offers')));
});
test('price and offer fields enforced against raw bypass writes',async()=>{
 const grantId=await assign();
 for(const price of [0,-1,1.5,100000001,'100',NaN])await assertFails(setDoc(ref(p1,'offers',grantId),rawOffer(price)));
 await assertFails(setDoc(ref(p1,'offers',grantId),{...rawOffer(100),phone:'DO-NOT-COPY'}));
 await assertFails(setDoc(ref(p1,'offers',grantId),{...rawOffer(100),note:'x'.repeat(501)}));
});
for(const price of [1,100000000])test('offer price boundary '+price+' is accepted',async()=>{
 const grantId=await assign();await assertSucceeds(submitAssignedOffer(p1,'r',grantId,{price}));
});
test('revocation blocks reads and writes but keeps admin evidence',async()=>{
 const grantId=await assign();await submitAssignedOffer(p1,'r',grantId,{price:250000});
 await revokeAssignmentAsAdmin(admin,'r','p1');
 await assertFails(getDocFromServer(ref(p1,'offers',grantId)));
 await assertFails(getDocFromServer(ref(p1,'grants',grantId)));
 await assertFails(submitAssignedOffer(p1,'r',grantId,{price:100}));
 assert.equal((await getDocFromServer(ref(admin,'offers',grantId))).data().price,250000);
 assert.equal((await getDocFromServer(ref(admin,'grants',grantId))).exists(),true);
});
test('reassignment creates new offer identity without restoring old access',async()=>{
 const old=await assign();await submitAssignedOffer(p1,'r',old,{price:250000});
 await revokeAssignmentAsAdmin(admin,'r','p1');const fresh=await assign();assert.notEqual(old,fresh);
 await assertFails(getDocFromServer(ref(p1,'offers',old)));
 await assertSucceeds(submitAssignedOffer(p1,'r',fresh,{price:260000}));
 assert.equal((await getDocs(collection(admin,'quote_requests','r','offers'))).size,2);
});
test('approval withdrawal and reapproval do not resurrect old grants',async()=>{
 const old=await assign();await submitAssignedOffer(p1,'r',old,{price:100});
 assert.equal((await reviewPartnerAsAdmin(admin,'p1','반려')).approvalVersion,2);
 await assertFails(getDocFromServer(ref(p1,'grants',old)));
 assert.equal((await reviewPartnerAsAdmin(admin,'p1','승인')).approvalVersion,3);
 await assertFails(getDocFromServer(ref(p1,'grants',old)));
 await assertFails(getDocFromServer(ref(p1,'offers',old)));
 await revokeAssignmentAsAdmin(admin,'r','p1');const fresh=await assign();
 assert.equal((await readAssignedQuote(p1,'r','p1')).grantId,fresh);
});
test('approved company cannot edit reviewed identity; explicit rereview unlocks edits',async()=>{
 await assertFails(updateDoc(doc(p1,'partner_profiles','p1'),{company:'changed'}));
 await assertFails(updateDoc(doc(p1,'partner_profiles','p1'),{areas:['홍천']}));
 await reviewPartnerAsAdmin(admin,'p1','검토중');
 await assertSucceeds(updateDoc(doc(p1,'partner_profiles','p1'),{company:'새 가상상호'}));
});
test('provider cannot approve self or forge approval version',async()=>{
 await assertFails(updateDoc(doc(pending,'partner_profiles','pending'),{status:'승인',approvalVersion:1}));
 await assertFails(updateDoc(doc(p1,'partner_profiles','p1'),{approvalVersion:2}));
});
test('administrator must increment revision exactly once per changed review status',async()=>{
 for(const payload of [{status:'반려'},{status:'반려',approvalVersion:0},{status:'반려',approvalVersion:3},{status:'승인',approvalVersion:2}])await assertFails(updateDoc(doc(admin,'partner_profiles','p1'),payload));
 await assertSucceeds(reviewPartnerAsAdmin(admin,'p1','반려'));
 await assert.rejects(reviewPartnerAsAdmin(admin,'p1','반려'));
});
test('missing legacy approvalVersion fails closed until explicit migration',async()=>{
 await seed(db=>setDoc(doc(db,'partner_profiles','p1'),{company:'legacy',areas:['춘천'],specialties:['입주·이사 청소'],status:'승인'}));
 await assert.rejects(assignPartnerAsAdmin(admin,'r','p1'));
 await assertFails(rawAssign(admin,'p1','legacy'));
});
test('same UID without verified password authentication cannot use grants',async()=>{
 const grantId=await assign();
 for(const claims of [{email_verified:false,firebase:{sign_in_provider:'password'}},{email_verified:true,firebase:{sign_in_provider:'anonymous'}}]){
  const db=env.authenticatedContext('p1',claims).firestore();
  await assertFails(getDocFromServer(ref(db,'grants',grantId)));
  await assertFails(setDoc(ref(db,'offers',grantId),rawOffer(100)));
 }
});
test('immutable grant and offer cannot be changed or deleted, including admin',async()=>{
 const grantId=await assign();await submitAssignedOffer(p1,'r',grantId,{price:100});
 for(const kind of ['grants','offers']){
  await assertFails(updateDoc(ref(admin,kind,grantId),{note:'changed'}));
  await assertFails(deleteDoc(ref(admin,kind,grantId)));
 }
});
test('partial invalid assignment batch creates no dangling grant',async()=>{
 await assertFails(rawAssign(admin,'p1','partial',{}, {forbidden:true}));
 assert.equal((await getDocFromServer(ref(admin,'grants','partial'))).exists(),false);
});
test('service validators reject malformed input before database calls',async()=>{
 await assert.rejects(assignPartnerAsAdmin({},'../bad','p1'),TypeError);
 await assert.rejects(reviewPartnerAsAdmin({},'p1','invented'),TypeError);
 await assert.rejects(submitAssignedOffer({},'r','valid',{price:0}),TypeError);
 await assert.rejects(readAssignedQuote({},'r','../bad'),TypeError);
});
