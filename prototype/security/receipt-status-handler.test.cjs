'use strict';
const assert = require('node:assert/strict');
const {createReceiptStatusHandler} = require('./receipt-status-handler.cjs');
(async () => {
  const seen = {verify:0, rate:0, read:0};
  const records = {a:{ownerUid:'owner',name:'PRIVATE',phone:'01000000000'},b:{ownerUid:'other'}};
  let allow = true;
  const handler = createReceiptStatusHandler({
    verifyIdToken:async token => {seen.verify++; if(token==='invalid') throw Error('sensitive token details'); return {uid:token,email_verified:true,firebase:{sign_in_provider:'password'}};},
    loadRequest:async id => {seen.read++; if(id==='dbfailure') throw Error('sensitive database details'); return records[id];},
    enforceRateLimit:async () => {seen.rate++; return allow;}
  });
  assert.deepEqual(await handler({requestId:'a'}),{httpStatus:401,body:{status:'unavailable'}});
  assert.deepEqual(await handler({requestId:'../a',idToken:'owner'}),{httpStatus:400,body:{status:'unavailable'}});
  assert.equal(seen.verify,0);
  assert.equal((await handler({requestId:'a',idToken:'invalid'})).httpStatus,401);
  assert.equal(seen.read,0);
  const good=await handler({requestId:'a',idToken:'owner'});
  assert.deepEqual(good,{httpStatus:200,body:{status:'confirmed'}});
  assert.equal(JSON.stringify(good).includes('PRIVATE'),false);
  assert.deepEqual(await handler({requestId:'b',idToken:'owner'}),await handler({requestId:'missing',idToken:'owner'}));
  assert.deepEqual(await handler({requestId:'dbfailure',idToken:'owner'}),{httpStatus:503,body:{status:'unavailable'}});
  allow=false;
  const readBefore=seen.read;
  assert.equal((await handler({requestId:'a',idToken:'owner'})).httpStatus,429);
  assert.equal(seen.read,readBefore);
  const unverified = createReceiptStatusHandler({verifyIdToken:async()=>({uid:'owner',email_verified:false,firebase:{sign_in_provider:'password'}}),loadRequest:async()=>{throw Error('must not read')},enforceRateLimit:async()=>true});
  assert.equal((await unverified({requestId:'a',idToken:'x'})).httpStatus,403);
  const anonymous = createReceiptStatusHandler({verifyIdToken:async()=>({uid:'owner',email_verified:true,firebase:{sign_in_provider:'anonymous'}}),loadRequest:async()=>{throw Error('must not read')},enforceRateLimit:async()=>true});
  assert.equal((await anonymous({requestId:'a',idToken:'x'})).httpStatus,403);
  const phone = createReceiptStatusHandler({verifyIdToken:async()=>({uid:'owner',phone_number:'+821011112222',firebase:{sign_in_provider:'phone'}}),loadRequest:async()=>records.a,enforceRateLimit:async()=>true});
  assert.equal((await phone({requestId:'a',idToken:'x'})).httpStatus,200);
  assert.throws(()=>createReceiptStatusHandler({verifyIdToken:async()=>true}),TypeError);
  console.log('PASS verified owner, anonymous/unverified rejection, privacy, missing/foreign indistinguishable, throttling and safe errors');
})().catch(e=>{console.error(e);process.exitCode=1});
