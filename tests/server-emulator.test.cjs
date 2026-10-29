'use strict';
// Real Auth and Firestore emulators; App Check verification is stubbed only in this test.
const assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {createHttpHandler}=require('../server/handler.cjs');
const {createRateLimit}=require('../server/rate-limit.cjs');
const project='demo-okclean-integration';
if(process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!==project)throw Error('Test emulators required');
async function main(){
 const app=admin.initializeApp({projectId:project},'server-test'),auth=admin.auth(app),db=admin.firestore(app);
 const pass='test-password-123', user='server-user@example.test',other='server-other@example.test',manager='server-admin@example.test';
 for(const [uid,email] of [['server-user',user],['server-other',other],['server-admin',manager]])await auth.createUser({uid,email,password:pass,emailVerified:true});
 await auth.setCustomUserClaims('server-admin',{admin:true});
 async function token(email){const r=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password:pass,returnSecureToken:true})});const data=await r.json();assert.ok(data.idToken);return data.idToken;}
 const [userToken,otherToken,adminToken]=await Promise.all([token(user),token(other),token(manager)]);
 const create=()=>createHttpHandler({auth,db,appCheck:{verifyToken:async v=>{if(v!=='emulator-app-check')throw Error();}},rateLimit:createRateLimit(db),allowedOrigin:'https://ok-clean.github.io'});
 let handler=create();
 async function call(path,t,body){const req={path,method:'POST',headers:{origin:'https://ok-clean.github.io',authorization:'Bearer '+t,'x-firebase-appcheck':'emulator-app-check'},body};let text;const res={statusCode:200,setHeader(){},end(v){text=v;}};await handler(req,res);return {code:res.statusCode,body:JSON.parse(text)};}
 const date=new Date(Date.now()+7*86400000).toISOString().slice(0,10),form={service:'입주·이사 청소',area:'춘천',size:20,date,name:'시험고객',phone:'01000000005',notes:'시험',consent:true};
 try{
  assert.equal((await call('/reservation/submit',userToken,{requestId:'server-emulator-test',form})).code,200);
  assert.equal((await call('/reservation/submit',userToken,{requestId:'server-emulator-test',form})).code,200);
  assert.equal((await db.collection('quote_requests').get()).size,1);
  handler=create(); // simulate new server instance using the same Firestore database
  assert.equal((await call('/reservation/status',userToken,{requestId:'server-emulator-test'})).code,200);
  assert.equal((await call('/reservation/status',otherToken,{requestId:'server-emulator-test'})).code,404);
  assert.equal((await call('/admin/list',userToken,{})).code,403);
  assert.equal((await call('/admin/list',adminToken,{})).body.items.length,1);
  assert.equal((await call('/admin/status',adminToken,{requestId:'server-emulator-test',status:'상담중'})).code,200);
  assert.equal((await db.collection('quote_requests').doc('server-emulator-test').get()).data().status,'상담중');
  console.log('PASS: real Auth/Firestore emulators with Cloud Run HTTP adapter; App Check stubbed');
 }finally{await app.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
