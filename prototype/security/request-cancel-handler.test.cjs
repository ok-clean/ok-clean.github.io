'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCancelHandler} = require('./request-cancel-handler.cjs');
const valid = {uid:'customer',email_verified:true,firebase:{sign_in_provider:'password'}};
const args = {idToken:'fake-token',requestId:'r'};
const unavail = status => ({httpStatus:status,body:{status:'unavailable'}});
function make(overrides={}) {
 return createCancelHandler({
  verifyIdToken:async()=>valid,enforceRateLimit:async()=>true,cancelOwned:async()=> 'cancelled',...overrides
 });
}
test('requires trusted dependencies and rejects malformed or excessive input before lookup',async()=>{
 assert.throws(()=>createCancelHandler(),TypeError);
 let calls=0;const handler=make({verifyIdToken:async()=>{calls++;return valid;}});
 for(const input of [null,{}, {...args,phone:'PRIVATE'}, {...args,requestId:'../bad'}, {...args,requestId:'x'.repeat(81)}])
  assert.deepEqual(await handler(input),unavail(400));
 for(const idToken of ['',null,'x'.repeat(4097)])assert.deepEqual(await handler({...args,idToken}),unavail(401));
 assert.equal(calls,0);
});
test('verified email or phone can request cancellation and receives only a status',async()=>{
 const identities=[valid,{uid:'customer',phone_number:'synthetic',firebase:{sign_in_provider:'phone'}}];
 for(const identity of identities) {
  let seen;const handler=make({verifyIdToken:async()=>identity,cancelOwned:async(id,uid)=>{seen={id,uid};return 'cancelled';}});
  assert.deepEqual(await handler(args),{httpStatus:200,body:{status:'cancelled'}});
  assert.deepEqual(seen,{id:'r',uid:'customer'});
 }
});
test('invalid, anonymous and unverified identities fail before rate or data access',async()=>{
 let calls=0;
 for(const auth of [
  null,{uid:'customer',firebase:{sign_in_provider:'anonymous'}},
  {uid:'customer',email_verified:false,firebase:{sign_in_provider:'password'}},
  {uid:'customer',phone_number:'',firebase:{sign_in_provider:'phone'}},
  {uid:'customer',email_verified:true,firebase:{sign_in_provider:'unknown'}}
 ]) {
  const handler=make({verifyIdToken:async()=>auth,enforceRateLimit:async()=>{calls++;return true;},cancelOwned:async()=>{calls++;return 'cancelled';}});
  assert.deepEqual(await handler(args),unavail(403));
 }
 assert.deepEqual(await make({verifyIdToken:async()=>{throw Error('PRIVATE TOKEN');}})(args),unavail(401));
 assert.equal(calls,0);
});
test('missing and foreign requests are indistinguishable; closed is separate only after ownership',async()=>{
 const cancelOwned=async(id,uid)=>id==='r' && uid==='customer'?'closed':'not_found';
 const missing=await make({cancelOwned})({...args,requestId:'missing'});
 const foreign=await make({cancelOwned,verifyIdToken:async()=>({...valid,uid:'other'})})(args);
 assert.deepEqual(missing,foreign);assert.deepEqual(missing,unavail(404));
 assert.deepEqual(await make({cancelOwned})(args),unavail(409));
});
test('rate limits and internal failures produce generic responses',async()=>{
 let called=false;
 assert.deepEqual(await make({enforceRateLimit:async()=>false,cancelOwned:async()=>{called=true;}})(args),unavail(429));
 assert.equal(called,false);
 for(const overrides of [
  {enforceRateLimit:async()=>{throw Error('PRIVATE LIMIT');}},
  {cancelOwned:async()=>{throw Error('PRIVATE DATA');}},
  {cancelOwned:async()=>({status:'cancelled',name:'PRIVATE'})}
 ]) {
  const result=await make(overrides)(args);
  assert.deepEqual(result,unavail(503));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|customer|fake-token/);
 }
});
