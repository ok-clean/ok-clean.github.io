'use strict';
// Real Firestore emulator with synthetic identities. No production auth or data.
const {test,before,after,beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {initializeTestEnvironment,assertFails} = require('@firebase/rules-unit-testing');
const {doc,setDoc,updateDoc,getDocFromServer,Timestamp} = require('firebase/firestore');
const {assignPartnerAsAdmin,readAssignedQuote,submitAssignedOffer} = require('./partner-matching-service.cjs');
const {createComparisonReader} = require('./comparison-reader.cjs');
const {createCancellationStore} = require('./request-cancel-store.cjs');
const {createCancelHandler} = require('./request-cancel-handler.cjs');
const account={email_verified:true,firebase:{sign_in_provider:'password'}};
const profile={company:'가상업체',areas:['춘천'],specialties:['입주·이사 청소'],status:'승인',approvalVersion:1};
const args={idToken:'test-owner',requestId:'r'};
const unavailable=code=>({httpStatus:code,body:{status:'unavailable'}});
let env,admin,p1,p2,verifiedOwner,anon,other,handler,compare;
const quote=db=>doc(db,'quote_requests','r');
const child=(db,kind,id)=>doc(db,'quote_requests','r',kind,id);
const seed=fn=>env.withSecurityRulesDisabled(c=>fn(c.firestore()));
async function fakeVerify(token) {
 if (token==='test-invalid') throw Error('PRIVATE TOKEN');
 if (token==='test-owner') return {uid:'customer',...account};
 if (token==='test-phone') return {uid:'customer',phone_number:'synthetic',firebase:{sign_in_provider:'phone'}};
 if (token==='test-other') return {uid:'other',...account};
 if (token==='test-anonymous') return {uid:'customer',firebase:{sign_in_provider:'anonymous'}};
 if (token==='test-unverified') return {uid:'customer',email_verified:false,firebase:{sign_in_provider:'password'}};
 throw Error('PRIVATE TOKEN');
}
before(async()=>{
 env=await initializeTestEnvironment({projectId:'demo-okclean-matching',firestore:{rules:fs.readFileSync('prototype/security/firestore.rules','utf8')}});
 admin=env.authenticatedContext('admin',{admin:true}).firestore();
 p1=env.authenticatedContext('p1',account).firestore();p2=env.authenticatedContext('p2',account).firestore();
 verifiedOwner=env.authenticatedContext('customer',account).firestore();
 anon=env.authenticatedContext('customer',{firebase:{sign_in_provider:'anonymous'}}).firestore();
 other=env.authenticatedContext('other',account).firestore();
 handler=createCancelHandler({verifyIdToken:fakeVerify,enforceRateLimit:async()=>true,cancelOwned:createCancellationStore(admin)});
 compare=createComparisonReader(admin);
});
beforeEach(async()=>{
 await env.clearFirestore();
 await seed(async db=>{
  await setDoc(quote(db),{service:'입주·이사 청소',area:'춘천',size:25,date:Timestamp.fromMillis(Date.now()+7*86400000),status:'신규',ownerUid:'customer',name:'PRIVATE-NAME',phone:'PRIVATE-PHONE'});
  await setDoc(doc(db,'partner_profiles','p1'),profile);await setDoc(doc(db,'partner_profiles','p2'),profile);
 });
});
after(async()=>{if(env)await env.cleanup();});

test('direct customer, anonymous and partner state changes remain denied',async()=>{
 for(const db of [verifiedOwner,anon,other,p1]) {
  await assertFails(updateDoc(quote(db),{status:'취소'}));
  await assertFails(getDocFromServer(quote(db)));
 }
 assert.equal((await getDocFromServer(quote(admin))).data().status,'신규');
});
test('verified owner cancels: assigned partner access and new offers stop; records remain',async()=>{
 const one=await assignPartnerAsAdmin(admin,'r','p1');
 const two=await assignPartnerAsAdmin(admin,'r','p2');
 await submitAssignedOffer(p1,'r',one.grantId,{price:250000,note:'PRIVATE-NOTE'});
 assert.deepEqual(await compare('r','customer'),[{company:'가상업체',price:250000}]);
 const result=await handler(args);
 assert.deepEqual(result,{httpStatus:200,body:{status:'cancelled'}});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|customer|grant|phone/);
 assert.equal((await getDocFromServer(quote(admin))).data().status,'취소');
 assert.equal((await getDocFromServer(child(admin,'offers',one.grantId))).exists(),true);
 for(const ref of [child(p1,'assignments','p1'),child(p1,'grants',one.grantId),child(p1,'offers',one.grantId),child(p2,'grants',two.grantId)])
  await assertFails(getDocFromServer(ref));
 await assert.rejects(readAssignedQuote(p1,'r','p1'));
 await assert.rejects(submitAssignedOffer(p2,'r',two.grantId,{price:270000}));
 await assert.rejects(assignPartnerAsAdmin(admin,'r','p2'));
 assert.equal(await compare('r','customer'),null);
});
test('repeat cancellation is idempotent for the owner; foreign and missing are indistinguishable',async()=>{
 assert.deepEqual(await handler({idToken:'test-other',requestId:'r'}),unavailable(404));
 assert.deepEqual(await handler({idToken:'test-owner',requestId:'missing'}),unavailable(404));
 assert.equal((await getDocFromServer(quote(admin))).data().status,'신규');
 assert.deepEqual(await handler(args),{httpStatus:200,body:{status:'cancelled'}});
 assert.deepEqual(await handler(args),{httpStatus:200,body:{status:'cancelled'}});
 assert.deepEqual(await handler({idToken:'test-other',requestId:'r'}),unavailable(404));
});
test('anonymous, invalid and unverified identities cannot cancel; phone test identity may',async()=>{
 for(const [token,code] of [['test-anonymous',403],['test-unverified',403],['test-invalid',401]])
  assert.deepEqual(await handler({idToken:token,requestId:'r'}),unavailable(code));
 assert.equal((await getDocFromServer(quote(admin))).data().status,'신규');
 assert.deepEqual(await handler({idToken:'test-phone',requestId:'r'}),{httpStatus:200,body:{status:'cancelled'}});
});
test('booked, finished and closed requests require a separate policy',async()=>{
 for(const status of ['예약확정','작업완료','종료']) {
  await seed(db=>updateDoc(quote(db),{status}));
  assert.deepEqual(await handler(args),unavailable(409));
  await assertFails(updateDoc(quote(admin),{status:'취소'}));
  assert.equal((await getDocFromServer(quote(admin))).data().status,status);
 }
});
test('cancelled status is terminal even for direct admin writes',async()=>{
 assert.deepEqual(await handler(args),{httpStatus:200,body:{status:'cancelled'}});
 for(const status of ['신규','검토중','상담중','예약확정','작업완료','종료'])
  await assertFails(updateDoc(quote(admin),{status}));
 assert.equal((await getDocFromServer(quote(admin))).data().status,'취소');
});
test('simultaneous repeated cancellation settles to one safe state', {timeout:60000},async()=>{
 const results=await Promise.all([handler(args),handler(args)]);
 assert.deepEqual(results,[{httpStatus:200,body:{status:'cancelled'}},{httpStatus:200,body:{status:'cancelled'}}]);
 assert.equal((await getDocFromServer(quote(admin))).data().status,'취소');
});
test('concurrent assignment cannot leave an active grant after cancellation', {timeout:60000},async()=>{
 const [cancel,assignment]=await Promise.allSettled([handler(args),assignPartnerAsAdmin(admin,'r','p1')]);
 assert.equal(cancel.status,'fulfilled');assert.deepEqual(cancel.value,{httpStatus:200,body:{status:'cancelled'}});
 assert.ok(['fulfilled','rejected'].includes(assignment.status));
 assert.equal((await getDocFromServer(quote(admin))).data().status,'취소');
 if(assignment.status==='fulfilled')await assertFails(getDocFromServer(child(p1,'grants',assignment.value.grantId)));
 await assert.rejects(assignPartnerAsAdmin(admin,'r','p2'));
});
test('concurrent booking and cancellation produce one compatible final state', {timeout:60000},async()=>{
 const [cancel,booking]=await Promise.allSettled([handler(args),updateDoc(quote(admin),{status:'예약확정'})]);
 assert.equal(cancel.status,'fulfilled');
 const state=(await getDocFromServer(quote(admin))).data().status;
 if(state==='취소') {
  assert.deepEqual(cancel.value,{httpStatus:200,body:{status:'cancelled'}});
  assert.equal(booking.status,'rejected');
 } else {
  assert.equal(state,'예약확정');assert.equal(booking.status,'fulfilled');
  // A concurrent rule rejection can surface as an unknown 503 instead of a 409.
  // Never claim cancellation; a later owner retry must observe the booked state.
  assert.ok([409,503].includes(cancel.value.httpStatus));
  assert.deepEqual(cancel.value.body,{status:'unavailable'});
  assert.deepEqual(await handler(args),unavailable(409));
 }
});
