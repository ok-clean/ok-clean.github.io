'use strict';
// Uses synthetic accounts and the isolated Firebase Auth / Firestore emulators.
const assert=require('node:assert/strict'),admin=require('firebase-admin');
const {createDemoWithdrawalProcessor}=require('../server/account-withdrawal.cjs');
const project='demo-okclean-integration';
if(process.env.GCLOUD_PROJECT!==project||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:project},'withdrawal-processor-test'),db=admin.firestore(app),auth=admin.auth(app);
 try{
  const uid='synthetic-erase-only';await auth.createUser({uid,email:'synthetic-erase-only@example.test',password:'synthetic-password'});await db.collection('account_lifecycle').doc(uid).create({status:'withdrawal_requested',sessionRevocation:'revoked',authCreationTime:(await auth.getUser(uid)).metadata.creationTime});
  const run=createDemoWithdrawalProcessor({db,auth,policy:{reviewed:true,allowDemoAuthDeletion:true},protectedMemberAdminUid:'protected-demo-admin'});
  assert.equal((await run(uid)).result,'auth_absent_pending_other_data');
  assert.equal((await db.collection('account_lifecycle').doc(uid).get()).data().dataMutationFrozen,true);
  await assert.rejects(()=>auth.getUser(uid),e=>e.code==='auth/user-not-found');
  assert.equal((await run(uid)).result,'absent');
  assert.equal((await db.collection('account_lifecycle').doc(uid).get()).data().status,'withdrawal_requested');
  await auth.createUser({uid,email:'synthetic-recreated@example.test',password:'synthetic-password'});assert.equal((await run(uid)).result,'uid_reused_blocked');assert.equal((await auth.getUser(uid)).uid,uid);
  const held='synthetic-held';await auth.createUser({uid:held,email:'synthetic-held@example.test',password:'synthetic-password'});await db.collection('account_lifecycle').doc(held).create({status:'withdrawal_requested',sessionRevocation:'revoked',authCreationTime:(await auth.getUser(held)).metadata.creationTime});await db.collection('quote_requests').doc('synthetic-held').create({ownerUid:held,legalHold:true});
  assert.equal((await run(held)).result,'reservations_pending');assert.equal((await auth.getUser(held)).uid,held);
  assert.notEqual((await db.collection('account_lifecycle').doc(held).get()).data().dataMutationFrozen,true);
  const linked='synthetic-member-linked';await auth.createUser({uid:linked,email:'synthetic-member-linked@example.test',password:'synthetic-password'});await db.collection('account_lifecycle').doc(linked).create({status:'withdrawal_requested',sessionRevocation:'revoked',authCreationTime:(await auth.getUser(linked)).metadata.creationTime});await db.collection('account_member_links').doc(linked).create({memberId:'synthetic-member'});
  assert.equal((await run(linked)).result,'member_data_pending');assert.equal((await auth.getUser(linked)).uid,linked);assert.equal((await db.collection('account_member_links').doc(linked).get()).exists,true);
  const stale='synthetic-stale-identity';await auth.createUser({uid:stale,email:'synthetic-stale-identity@example.test',password:'synthetic-password'});
  await db.collection('account_lifecycle').doc(stale).create({status:'withdrawal_requested',sessionRevocation:'revoked',authCreationTime:'previous-creation'});
  assert.equal((await run(stale)).result,'security_review_required');assert.equal((await auth.getUser(stale)).uid,stale);
  console.log('PASS: synthetic Auth account absent; withdrawal remains pending and reservation prevents account deletion');
 }finally{await app.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
