'use strict';
// Synthetic demo Auth + Firestore emulator, never access a live project.
const assert=require('node:assert/strict'),admin=require('firebase-admin');
const {createWithdrawalRecoveryHandler,createWithdrawalHandler}=require('../server/account-withdrawal.cjs');
const project='demo-okclean-integration';
if(process.env.GCLOUD_PROJECT!==project||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:project},'withdraw-recovery-test'),db=admin.firestore(app),real=admin.auth(app);
 try{
  const user=await real.createUser({uid:'synthetic-recovery',email:'synthetic-recovery@example.test',password:'synthetic-password'});
  const ref=db.collection('account_lifecycle').doc(user.uid);
  await ref.create({status:'withdrawal_requested',sessionRevocation:'pending',authCreationTime:user.metadata.creationTime});
  await db.collection('account_lifecycle').doc('synthetic-legacy').create({status:'withdrawal_requested',sessionRevocation:'pending'});
  const reused=await real.createUser({uid:'synthetic-reused',email:'synthetic-reused@example.test',password:'synthetic-password'});
  await db.collection('account_lifecycle').doc(reused.uid).create({status:'withdrawal_requested',sessionRevocation:'pending',authCreationTime:'different-old-creation-time'});
  let fails=true,release,signal;const entered=new Promise(resolve=>signal=resolve);
  const auth={getUser:async uid=>{if(uid===user.uid&&!release){await new Promise(resolve=>{release=resolve;signal();});}return real.getUser(uid);},revokeRefreshTokens:uid=>{if(fails){fails=false;throw Error('synthetic transient failure');}return real.revokeRefreshTokens(uid);}};
  const audience='https://scheduler.example.test/recovery',email='worker@demo-okclean-integration.iam.gserviceaccount.com';
  const worker=createWithdrawalRecoveryHandler({db,auth,config:{enabled:true,policyReviewed:true,projectId:project,audience,serviceAccount:email,protectedMemberAdminUid:'protected-admin'},verifyOidc:async()=>({aud:audience,iss:'https://accounts.google.com',email_verified:true,email})});
  async function call(){const res={statusCode:0,body:null,setHeader(){},status(c){this.statusCode=c;return this},json(v){this.body=v;return this}};await worker({method:'POST',headers:{authorization:'Bearer synthetic'}},res);return res;}
  const first=call();await entered;assert.equal((await call()).statusCode,409);release();assert.equal((await first).statusCode,503);assert.equal((await ref.get()).data().sessionRevocation,'pending');
  assert.equal((await db.collection('withdrawal_recovery_control').doc('current').get()).data().lastResult,'retry_needed');
  assert.equal((await call()).statusCode,200);const v=(await ref.get()).data();assert.equal(v.sessionRevocation,'revoked');assert.equal(v.status,'withdrawal_requested');assert.equal((await real.getUser(user.uid)).uid,user.uid);
  assert.equal((await db.collection('account_lifecycle').doc('synthetic-legacy').get()).data().securityReview,'required');
  assert.equal((await db.collection('account_lifecycle').doc(reused.uid).get()).data().securityReview,'required');
  assert.equal((await real.getUser(reused.uid)).uid,reused.uid);
  const retryUser=await real.createUser({uid:'synthetic-old-request',email:'synthetic-old-request@example.test',emailVerified:true,password:'synthetic-password'});
  const oldRef=db.collection('account_lifecycle').doc(retryUser.uid);await oldRef.create({status:'withdrawal_requested',sessionRevocation:'pending',authCreationTime:'prior-account-creation'});
  const signIn=await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'synthetic-old-request@example.test',password:'synthetic-password',returnSecureToken:true})});
  assert.equal(signIn.ok,true);const token=(await signIn.json()).idToken;const caller=await real.verifyIdToken(token,true);
  const before=await real.getUser(retryUser.uid),withdraw=createWithdrawalHandler({db,auth:real,rateLimit:async()=>true,protectedMemberAdminUid:'protected-admin',withdrawalPolicyReviewed:true});
  assert.equal((await withdraw(caller)).httpStatus,403);assert.equal((await oldRef.get()).data().securityReview,'required');
  const after=await real.getUser(retryUser.uid);assert.equal(after.tokensValidAfterTime,before.tokensValidAfterTime,'new account session must not be revoked');
  console.log('PASS: bounded session recovery using synthetic Auth and Firestore emulators; OIDC verifier is a test double');
 }finally{await app.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
