'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createCustomerReservationsHandler}=require('../server/customer-reservations.cjs');
const a={uid:'a',email_verified:true,firebase:{sign_in_provider:'password'}},b={uid:'b',email_verified:true,firebase:{sign_in_provider:'password'}};
function fixture({rate=true,throws=false}={}){
 const rows=[{id:'receipt-a',data:()=>({ownerUid:'a',service:'입주청소',status:'신규',date:new Date('2030-01-01T00:00:00Z'),name:'가상 이름',phone:'가상 번호',notes:'가상 메모'})},{id:'receipt-b',data:()=>({ownerUid:'b',service:'다른 고객',status:'신규'})}];
 const calls=[];const db={collection(name){calls.push(['collection',name]);return {where(field,op,uid){calls.push(['where',field,op,uid]);return {limit(n){calls.push(['limit',n]);return {async get(){if(throws)throw Error('private error');return {docs:rows.filter(r=>r.data().ownerUid===uid)}}}}}}}}};
 const list=createCustomerReservationsHandler({db,rateLimit:async()=>rate});return {list,calls};
}
test('verified owner receives only own receipt summary without contact data',async()=>{const {list,calls}=fixture();const r=await list(a);assert.equal(r.httpStatus,200);assert.equal(r.body.items.length,1);assert.equal(r.body.items[0].id,'receipt-a');assert.deepEqual(Object.keys(r.body.items[0]).sort(),['date','id','service','status']);assert.doesNotMatch(JSON.stringify(r),/가상 이름|가상 번호|가상 메모|receipt-b/);assert.deepEqual(calls[1],['where','ownerUid','==','a']);assert.equal((await list(b)).body.items[0].id,'receipt-b');});
test('anonymous and unverified accounts are rejected before querying',async()=>{const {list,calls}=fixture();for(const u of [{uid:'a',firebase:{sign_in_provider:'anonymous'}},{uid:'a',email_verified:false,firebase:{sign_in_provider:'password'}},null])assert.equal((await list(u)).httpStatus,403);assert.equal(calls.length,0);});
test('rate limits and store errors fail closed without disclosing error details',async()=>{assert.equal((await fixture({rate:false}).list(a)).httpStatus,429);const r=await fixture({throws:true}).list(a);assert.equal(r.httpStatus,503);assert.doesNotMatch(JSON.stringify(r),/private error/);});
test('unrelated records are rejected even if query adapter returns them',async()=>{const doc={id:'foreign',data:()=>({ownerUid:'other',name:'secret'})};const db={collection:()=>({where:()=>({limit:()=>({get:async()=>({docs:[doc]})})})})};assert.equal((await createCustomerReservationsHandler({db,rateLimit:async()=>true})(a)).body.items.length,0);});
