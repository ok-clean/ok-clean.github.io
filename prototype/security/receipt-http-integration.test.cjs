'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {createReceiptHttpHandler}=require('./receipt-http-adapter.cjs');
const {createReceiptStatusHandler}=require('./receipt-status-handler.cjs');
(async()=>{
 const records={req1:{ownerUid:'anonymous-uid-1',phone:'01000000000',name:'NEVER RETURN'},req2:{ownerUid:'other-uid'}};
 let throttle=false;
 // Fake verifier and records ONLY: operational Firebase tokens are not used.
 const core=createReceiptStatusHandler({
  verifyIdToken:async token=>{
   if(token==='bad')throw Error('auth secret');
   if(token==='same-anonymous')return {uid:'anonymous-uid-1',firebase:{sign_in_provider:'anonymous'}};
   if(token==='same-linked')return {uid:'anonymous-uid-1',email_verified:true,firebase:{sign_in_provider:'password'}};
   if(token==='different-linked')return {uid:'different-uid',email_verified:true,firebase:{sign_in_provider:'password'}};
   return {uid:'anonymous-uid-1',email_verified:false,firebase:{sign_in_provider:'password'}};
  },
  loadRequest:async id=>records[id],
  enforceRateLimit:async()=>!throttle
 });
 const handler=createReceiptHttpHandler({lookupReceipt:core,allowedOrigins:['https://ok-clean.github.io']});
 const server=http.createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(()=>res.destroy())});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const endpoint=`http://127.0.0.1:${server.address().port}/api/receipt-status`;
 async function request(token,id){const r=await fetch(endpoint,{method:'POST',headers:{origin:'https://ok-clean.github.io',authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({requestId:id})});return {code:r.status,body:await r.json()};}
 try {
  assert.deepEqual(await request('same-anonymous','req1'),{code:403,body:{status:'unavailable'}});
  assert.deepEqual(await request('same-linked','req1'),{code:200,body:{status:'confirmed'}});
  assert.deepEqual(await request('different-linked','req1'),{code:404,body:{status:'unavailable'}});
  assert.deepEqual(await request('same-linked','req2'),{code:404,body:{status:'unavailable'}});
  assert.deepEqual(await request('same-linked','missing'),{code:404,body:{status:'unavailable'}});
  assert.deepEqual(await request('not-verified','req1'),{code:403,body:{status:'unavailable'}});
  assert.deepEqual(await request('bad','req1'),{code:401,body:{status:'unavailable'}});
  throttle=true;assert.deepEqual(await request('same-linked','req1'),{code:429,body:{status:'unavailable'}});
  console.log('PASS identity continuity only with verified SAME UID, owner isolation and safe HTTP response');
 } finally {await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
})().catch(e=>{console.error(e);process.exitCode=1});
