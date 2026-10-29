'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {restrictedAppCheck}=require('../server/app-check-policy.cjs');
const {createHttpHandler}=require('../server/handler.cjs');
const services=require('../config.json').services;
const allowed='1:123456789:web:abcdef';
test('wrong-app and expired App Check tokens cannot reach reservation or auth handlers',async()=>{
 let authCalls=0;
 const auth={verifyIdToken:async()=>{authCalls++;return {uid:'test'};}};
 const checker=restrictedAppCheck({verifyToken:async token=>{if(token==='expired')throw Error('expired');return {appId:'1:123456789:web:012345'};}},allowed);
 const db={runTransaction:async()=>{throw Error('unexpected database access');},collection:()=>{throw Error('unexpected database access');}};
 const h=createHttpHandler({auth,appCheck:checker,db,rateLimit:async()=>true,allowedOrigin:'https://ok-clean.github.io',services,consentVersion:'privacy-v1'});
 for(const token of ['expired','other-app']){
  const req={method:'POST',path:'/reservation/status',headers:{origin:'https://ok-clean.github.io','x-firebase-appcheck':token,authorization:'Bearer fake'},body:{requestId:'fake'}};
  let status=200;const res={setHeader(){},set statusCode(v){status=v;},get statusCode(){return status;},end(){}};
  await h(req,res);assert.notEqual(status,200);
 }
 assert.equal(authCalls,0);
});
