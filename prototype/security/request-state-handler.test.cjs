'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRequestStateHandler}=require('./request-state-handler.cjs');
const valid={uid:'customer',email_verified:true,firebase:{sign_in_provider:'password'}};
const args={idToken:'fake-token',requestId:'r'};
const bad=code=>({httpStatus:code,body:{status:'unavailable'}});
function make(overrides={}) {
 return createRequestStateHandler({verifyIdToken:async()=>valid,enforceRateLimit:async()=>true,readOwnedState:async()=> 'processing',...overrides});
}
test('rejects malformed input, extra fields and invalid tokens before data lookup',async()=>{
 assert.throws(()=>createRequestStateHandler(),TypeError);
 let calls=0;const handler=make({verifyIdToken:async()=>{calls++;return valid;}});
 for(const input of [null,{}, {...args,name:'PRIVATE'}, {...args,requestId:'../bad'}, {...args,requestId:'x'.repeat(81)}])
  assert.deepEqual(await handler(input),bad(400));
 for(const idToken of ['',null,'x'.repeat(4097)])assert.deepEqual(await handler({...args,idToken}),bad(401));
 assert.equal(calls,0);
});
test('verified email or phone sees only an allowed state',async()=>{
 for(const identity of [valid,{uid:'customer',phone_number:'synthetic',firebase:{sign_in_provider:'phone'}}]) {
  for(const state of ['processing','cancelled','booked','completed','closed']) {
   let seen;const handler=make({verifyIdToken:async()=>identity,readOwnedState:async(id,uid)=>{seen={id,uid};return state;}});
   assert.deepEqual(await handler(args),{httpStatus:200,body:{status:'ok',state}});
   assert.deepEqual(seen,{id:'r',uid:'customer'});
  }
 }
});
test('invalid, anonymous and unverified identities never reach storage',async()=>{
 let calls=0;
 for(const auth of [null,{uid:'customer',firebase:{sign_in_provider:'anonymous'}},
  {uid:'customer',email_verified:false,firebase:{sign_in_provider:'password'}},
  {uid:'customer',phone_number:'',firebase:{sign_in_provider:'phone'}}]) {
  const handler=make({verifyIdToken:async()=>auth,readOwnedState:async()=>{calls++;return 'processing';}});
  assert.deepEqual(await handler(args),bad(403));
 }
 assert.deepEqual(await make({verifyIdToken:async()=>{throw Error('PRIVATE TOKEN');}})(args),bad(401));
 assert.equal(calls,0);
});
test('missing and foreign requests have identical unavailable responses',async()=>{
 const readOwnedState=async(id,uid)=>id==='r' && uid==='customer'?'processing':null;
 const missing=await make({readOwnedState})({...args,requestId:'missing'});
 const foreign=await make({readOwnedState,verifyIdToken:async()=>({...valid,uid:'other'})})(args);
 assert.deepEqual(missing,foreign);assert.deepEqual(missing,bad(404));
});
test('rate limits, unknown states and failures return no internal details',async()=>{
 let called=false;
 assert.deepEqual(await make({enforceRateLimit:async()=>false,readOwnedState:async()=>{called=true;}})(args),bad(429));
 assert.equal(called,false);
 for(const overrides of [
  {enforceRateLimit:async()=>{throw Error('PRIVATE LIMIT');}},
  {readOwnedState:async()=>{throw Error('PRIVATE DATA');}},
  {readOwnedState:async()=>({state:'cancelled',name:'PRIVATE'})},
  {readOwnedState:async()=> 'unknown'}
 ]) {
  const result=await make(overrides)(args);assert.deepEqual(result,bad(503));
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|customer|fake-token/);
 }
});
