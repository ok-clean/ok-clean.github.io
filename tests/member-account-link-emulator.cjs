'use strict';
// Synthetic Firebase Auth + Firestore emulators only.
const assert=require('node:assert/strict'),admin=require('firebase-admin');
const {createHttpHandler}=require('../server/handler.cjs');
const {createWithdrawalHandler}=require('../server/account-withdrawal.cjs');
const services=require('../config.json').services;
const project='demo-okclean-integration';
if(process.env.GCLOUD_PROJECT!==project||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw Error('DEMO_EMULATOR_REQUIRED');
async function anonymous(){const r=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({returnSecureToken:true})});if(!r.ok)throw Error('ANON_AUTH_FAILED');return r.json();}
async function main(){
 const app=admin.initializeApp({projectId:project},'synthetic-member-link'),db=admin.firestore(app),auth=admin.auth(app);
 try{
  await auth.createUser({uid:'synthetic-link-customer',email:'synthetic-link-customer@example.test',password:'synthetic-password',emailVerified:true});
  const response=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'synthetic-link-customer@example.test',password:'synthetic-password',returnSecureToken:true})});if(!response.ok)throw Error('CUSTOMER_AUTH_FAILED');
  const reservationToken=(await response.json()).idToken,caller=await auth.verifyIdToken(reservationToken,true),first=await anonymous(),other=await anonymous();
  const ref=db.collection('member_requests').doc('synthetic-member');await ref.create({ownerUid:first.localId});
  const handler=createHttpHandler({db,auth,memberLinkEnabled:true,memberLinkPolicyVersion:'test-member-v1',appCheck:{verifyToken:async()=>true},rateLimit:async()=>true,allowedOrigin:'https://ok-clean.github.io',services,consentVersion:'test-v1'});
  async function request(body){let text='';const req={method:'POST',path:'/reservation/link-member',headers:{origin:'https://ok-clean.github.io',authorization:'Bearer '+reservationToken,'x-firebase-appcheck':'synthetic'},body};const res={statusCode:200,setHeader(){},end(v){text=v||''}};await handler(req,res);return {httpStatus:res.statusCode,body:JSON.parse(text)};}
  const body={memberId:ref.id,memberIdToken:other.idToken,consent:true,policyVersion:'test-member-v1'};assert.equal((await request(body)).httpStatus,403);
  body.memberIdToken=first.idToken;assert.equal((await request(body)).body.status,'linked');
  assert.equal((await db.collection('member_account_links').doc(ref.id).get()).data().reservationUid,caller.uid);
  assert.equal((await db.collection('account_member_links').doc(caller.uid).get()).data().memberId,ref.id);
  assert.equal((await db.collection('account_member_links').doc(caller.uid).get()).data().policyVersion,'test-member-v1');
  assert.equal((await db.collection('member_identity_links').doc(first.localId).get()).data().reservationUid,caller.uid);
  assert.equal((await request(body)).body.status,'linked');
  await db.collection('account_lifecycle').doc(caller.uid).create({status:'withdrawal_requested'});assert.equal((await request(body)).httpStatus,403);
  // A withdrawal request and link creation contend on the same lifecycle doc.
  // Whichever commits first, post-withdrawal linking must be rejected.
  await auth.createUser({uid:'synthetic-race-customer',email:'synthetic-race@example.test',password:'synthetic-password',emailVerified:true});
  const raceLogin=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'synthetic-race@example.test',password:'synthetic-password',returnSecureToken:true})});
  if(!raceLogin.ok)throw Error('RACE_AUTH_FAILED');const raceToken=(await raceLogin.json()).idToken,raceCaller=await auth.verifyIdToken(raceToken,true),raceAnon=await anonymous();
  await db.collection('member_requests').doc('synthetic-race-member').create({ownerUid:raceAnon.localId});
  async function raceRequest(){let text='';const req={method:'POST',path:'/reservation/link-member',headers:{origin:'https://ok-clean.github.io',authorization:'Bearer '+raceToken,'x-firebase-appcheck':'synthetic'},body:{memberId:'synthetic-race-member',memberIdToken:raceAnon.idToken,consent:true,policyVersion:'test-member-v1'}};const res={statusCode:200,setHeader(){},end(v){text=v||''}};await handler(req,res);return {httpStatus:res.statusCode,body:JSON.parse(text)};}
  const withdrawal=createWithdrawalHandler({db,auth,rateLimit:async()=>true,protectedMemberAdminUid:'protected-synthetic-admin',withdrawalPolicyReviewed:true});
  const [linked,withdrawn]=await Promise.all([raceRequest(),withdrawal(raceCaller)]);assert.equal(withdrawn.body.status,'pending');assert.ok([200,403].includes(linked.httpStatus));
  assert.equal((await db.collection('account_member_links').doc(raceCaller.uid).get()).exists,linked.httpStatus===200);assert.equal((await raceRequest()).httpStatus,403);
  console.log('PASS: member account links require both synthetic Firebase Auth identities and freeze gate');
 }finally{await app.delete();}
}
main().catch(e=>{
 // Test inputs are synthetic, but avoid printing errors, credentials or payloads.
 // The source location and error type are enough to locate failed assertions.
 const location=typeof e?.stack==='string'?e.stack.match(/member-account-link-emulator\.cjs:\d+:\d+/)?.[0]:'unknown';
 const kind=e?.name==='AssertionError'?'ASSERTION':'OTHER';
 console.error('MEMBER_LINK_EMULATOR_FAILED',kind,location||'unknown');process.exitCode=1;
});
