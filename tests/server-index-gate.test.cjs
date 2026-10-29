'use strict';
// Exercises the real production entrypoint and gate with a stubbed Express and
// Firebase Admin transport. The Ed25519 signature and preflight are real.
// This is not a live Cloud Run, IAM, network-isolation or Firestore test.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Module=require('node:module');
const path=require('node:path');
const indexPath=require.resolve('../server/index.cjs');
const {message}=require('../server/restore-gate.cjs');

test('production index refuses missing gate settings and places verified gate ahead of reservation handler',async()=>{
  const originalLoad=Module._load,originalEnv={...process.env},stack=[];
  const pair=crypto.generateKeyPairSync('ed25519');
  const pub=pair.publicKey.export({type:'spki',format:'pem'});
  let called=0,listened=0,attestation=null,headRevision=1,pending=false,controlInit=0,selectedDatabase='(default)';const posted=[];
  const tags={control:{type:'control'},head:{type:'head'},query:{type:'query'}};
  const ledger={projectId:'sample-ledger-prod',collection(name){
    if(name==='restore_control')return {doc:()=>tags.control};
    if(name==='deletion_ledger_meta')return {doc:()=>tags.head};
    if(name==='deletion_ledger')return {where:()=>({limit:()=>tags.query})};
    throw Error('Unexpected collection');
  },async runTransaction(work){return work({get:async ref=>{
    if(ref===tags.control)return {exists:!!attestation,data:()=>attestation};
    if(ref===tags.head)return {exists:true,data:()=>({revision:headRevision})};
    if(ref===tags.query)return {empty:!pending};
    throw Error('Unexpected read');
  }});}};
  const app={disable(){},use(fn){stack.push(fn)},post(path,handler){posted.push({path,handler,after:stack.length})},listen(){listened++}};
  function express(){return app} express.json=()=>async(req,res,next)=>next();
  const passthrough=async(req,res)=>{called++;res.statusCode=204;res.end('')};
  const fake={
    express,
    'firebase-admin/app':{initializeApp:({projectId})=>({projectId}),applicationDefault:()=>({})},
    'firebase-admin/auth':{getAuth:()=>({})},
    'firebase-admin/app-check':{getAppCheck:()=>({verifyToken:async()=>({})})},
    'firebase-admin/firestore':{getFirestore:(app,databaseId)=>app?.projectId==='sample-ledger-prod'?ledger:app?.projectId==='sample-control-prod'?(controlInit++,{projectId:'sample-control-prod',collection:()=>({doc:()=>({})}),runTransaction:async f=>f({get:async()=>({exists:false,data:()=>null}),set(){}})}):{projectId:'sample-clean-prod',databaseId:databaseId||'(default)'}},
    'google-auth-library':{GoogleAuth:class{async getClient(){return {request:async()=>({data:{name:'projects/sample-clean-prod/databases/'+selectedDatabase,uid:'123e4567-e89b-42d3-a456-426614174000'}})}} async getIdTokenClient(){return {request:async()=>({status:503,data:{status:'unavailable'}})}}}},
    './services.json':[{id:'synthetic'}],
    './handler.cjs':{createHttpHandler:()=>passthrough},
    './rate-limit.cjs':{createRateLimit:()=>async()=>true},
    './demo-retention-route.cjs':{attachDemoRetentionRoute:()=>false,createGoogleOidcVerifier:()=>async()=>({})},
    './account-withdrawal.cjs':{createWithdrawalRecoveryHandler:()=>async()=>{}}
  };
  Module._load=function(request,parent,isMain){
    if(parent?.filename===indexPath && Object.prototype.hasOwnProperty.call(fake,request))return fake[request];
    return originalLoad.apply(this,arguments);
  };
  const env={NODE_ENV:'production',OKCLEAN_PROJECT_ID:'sample-clean-prod',GOOGLE_CLOUD_PROJECT:'sample-clean-prod',CONSENT_VERSION:'privacy-v1',ALLOWED_ORIGIN:'https://ok-clean.github.io',OKCLEAN_FIREBASE_WEB_APP_ID:'1:123:web:abcdef',OKCLEAN_LEDGER_PROJECT_ID:'sample-ledger-prod',OKCLEAN_RESTORE_EPOCH:'synthetic-epoch-001',OKCLEAN_RESTORE_PUBLIC_KEY:pub};
  try{
    for(const k of ['GCLOUD_PROJECT','FIREBASE_AUTH_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','FIREBASE_EMULATOR_HUB','FIREBASE_APP_CHECK_DEBUG_TOKEN','FIREBASE_APPCHECK_DEBUG_TOKEN','APP_CHECK_DEBUG_TOKEN','GOOGLE_APPLICATION_CREDENTIALS','OKCLEAN_RESTORE_PUBLIC_KEY'])delete process.env[k];
    Object.assign(process.env,env);delete process.env.OKCLEAN_RESTORE_PUBLIC_KEY;
    assert.throws(()=>require(indexPath),/Unsafe runtime configuration/);
    assert.equal(listened,0);
    process.env.OKCLEAN_RESTORE_PUBLIC_KEY=pub;
    delete require.cache[indexPath];require(indexPath);
    assert.equal(listened,1);
    async function send(){const res={statusCode:200,body:null,headers:{},setHeader(k,v){this.headers[k]=v},end(v){this.body=v}};let pos=0;async function next(){const fn=stack[pos++];if(fn && fn.length<4)await fn({method:'POST'},res,next);}await next();return res;}
    let res=await send();assert.equal(res.statusCode,503);assert.equal(called,0);
    const now=Date.now();attestation={sourceProject:'sample-clean-prod',ledgerProject:'sample-ledger-prod',restoreId:'synthetic-epoch-001',servedDatabaseId:'(default)',servedDatabaseUid:'123e4567-e89b-42d3-a456-426614174000',checkpoint:'a'.repeat(64),ledgerRevision:1,issuedAt:now,expiresAt:now+60000,state:'cleared'};
    attestation.signature=crypto.sign(null,message(attestation),pair.privateKey).toString('base64url');
    const signed=attestation.signature;attestation.signature=(signed[0]==='A'?'B':'A')+signed.slice(1);
    res=await send();assert.equal(res.statusCode,503);assert.equal(called,0);
    attestation.signature=signed;res=await send();assert.equal(res.statusCode,204);assert.equal(called,1);
    headRevision=2;res=await send();assert.equal(res.statusCode,503);assert.equal(called,1);
    headRevision=1;pending=true;res=await send();assert.equal(res.statusCode,503);assert.equal(called,1);
    // Named DB cannot use a proof signed for the default DB. A specifically
    // signed proof and metadata for the named DB are both required.
    pending=false;process.env.OKCLEAN_FIRESTORE_DATABASE_ID='restored-db';selectedDatabase='restored-db';stack.length=0;delete require.cache[indexPath];require(indexPath);
    res=await send();assert.equal(res.statusCode,503);assert.equal(called,1);
    attestation.servedDatabaseId=selectedDatabase;attestation.signature=crypto.sign(null,message(attestation),pair.privateKey).toString('base64url');
    res=await send();assert.equal(res.statusCode,204);assert.equal(called,2);
    process.env.OKCLEAN_WITHDRAWAL_RECOVERY_ENABLED='true';stack.length=0;delete require.cache[indexPath];require(indexPath);assert.equal(posted.length,1);assert.equal(posted[0].path,'/_internal/withdrawal/recover');assert.equal(posted[0].after,2,'recovery route must be registered after restore gate');
    process.env.OKCLEAN_RESTORE_RENEWAL_ENABLED='true';process.env.OKCLEAN_RESTORE_CONTROL_PROJECT_ID='sample-control-prod';process.env.OKCLEAN_RESTORE_ISSUER_ORIGIN='https://issuer-service.run.app';stack.length=0;delete require.cache[indexPath];require(indexPath);assert.equal(controlInit,1,'renewal uses a distinct control project');
  }finally{Module._load=originalLoad;delete require.cache[indexPath];for(const k of Object.keys(process.env))if(!(k in originalEnv))delete process.env[k];Object.assign(process.env,originalEnv);}
});
