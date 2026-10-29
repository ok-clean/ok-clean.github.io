'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createWithdrawalHandler}=require('../server/account-withdrawal.cjs');
const {createVerifiedReservationHandler}=require('../prototype/security/verified-reservation-handler.cjs');
const {createCustomerReservationsHandler}=require('../server/customer-reservations.cjs');
function fixture(){
 const values=new Map();let lock=Promise.resolve();
 const collection=name=>({doc:id=>({name,id}),where:(field,op,uid)=>({query:true,uid,limit(){return this;}})});
 const db={collection,runTransaction(fn){const task=lock.then(async()=>fn({get:async ref=>ref.query?{docs:[...values.entries()].filter(([k,v])=>k.startsWith('quote_requests/')&&v.ownerUid===ref.uid).map(([k,v])=>({id:k.split('/')[1],data:()=>v}))}:{exists:values.has(ref.name+'/'+ref.id),data:()=>values.get(ref.name+'/'+ref.id)},create:(ref,v)=>{const key=ref.name+'/'+ref.id;if(values.has(key))throw Error('already exists');values.set(key,v);}}));lock=task.catch(()=>{});return task;}};
 const now=Date.now(), user={uid:'customer-a',auth_time:Math.floor(now/1000),email_verified:true,firebase:{sign_in_provider:'password'}};
 const auth={getUser:async uid=>({uid,customClaims:{},disabled:false})};
 const withdrawal=createWithdrawalHandler({db,auth,rateLimit:async()=>true,protectedMemberAdminUid:'protected-admin',withdrawalPolicyReviewed:true,now:()=>now});
 const submit=createVerifiedReservationHandler({db,verifyIdToken:async()=>user,enforceRateLimit:async()=>true});
 const list=createCustomerReservationsHandler({db,rateLimit:async()=>true});
 const form={service:'입주·이사 청소',area:'춘천',size:15,date:new Date(now+7*86400000).toISOString().slice(0,10),name:'가상고객',phone:'01000000000',consent:true};
 return {values,db,user,withdrawal,submit,list,form,auth,now};
}
test('only recently authenticated verified non-admin can request; no account or reservation deletion',async()=>{const f=fixture();assert.equal((await f.withdrawal({...f.user,auth_time:f.user.auth_time-301})).httpStatus,403);for(const role of ['admin','member_admin','reservation_admin','super_admin'])assert.equal((await f.withdrawal({...f.user,[role]:true})).httpStatus,403);assert.equal((await f.withdrawal({...f.user,uid:'protected-admin'})).httpStatus,403);f.auth.getUser=async()=>({customClaims:{member_admin:true}});assert.equal((await f.withdrawal(f.user)).httpStatus,403);assert.equal(f.values.size,0);});
test('unconfigured legacy member administrator UID fails closed',async()=>{const f=fixture();const h=createWithdrawalHandler({db:f.db,auth:f.auth,rateLimit:async()=>true,withdrawalPolicyReviewed:true,now:()=>f.now});assert.equal((await h(f.user)).httpStatus,503);assert.equal(f.values.size,0);});
test('pending withdrawal is idempotent, retains old data and blocks future creation and list',async()=>{const f=fixture();assert.equal((await f.submit({idToken:'synthetic',requestId:'before',form:f.form})).httpStatus,200);assert.equal((await f.withdrawal(f.user)).body.status,'pending');assert.equal((await f.withdrawal(f.user)).body.status,'pending');assert.equal((await f.submit({idToken:'synthetic',requestId:'after',form:f.form})).httpStatus,409);assert.equal((await f.list(f.user)).httpStatus,403);assert.ok(f.values.has('quote_requests/before'));assert.ok(!f.values.has('quote_requests/after'));});
test('concurrent request and reservation serialize through account marker',async()=>{const f=fixture();const [w,s]=await Promise.all([f.withdrawal(f.user),f.submit({idToken:'synthetic',requestId:'concurrent',form:f.form})]);assert.equal(w.body.status,'pending');if(s.httpStatus===200)assert.ok(f.values.has('quote_requests/concurrent'));else assert.equal(s.httpStatus,409);assert.equal((await f.submit({idToken:'synthetic',requestId:'later',form:f.form})).httpStatus,409);});

test('server blocks withdrawal when policy approval is missing',async()=>{const f=fixture();const h=createWithdrawalHandler({db:f.db,auth:f.auth,rateLimit:async()=>true,protectedMemberAdminUid:'protected-admin',now:()=>f.now});assert.equal((await h(f.user)).httpStatus,503);assert.equal(f.values.size,0);});
