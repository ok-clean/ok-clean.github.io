'use strict';
const {verifiedCaller}=require('./customer-reservations.cjs');
const response=(code,status)=>({httpStatus:code,body:{status}});
const privileged=c=>c?.admin===true||c?.member_admin===true||c?.reservation_admin===true||c?.super_admin===true;
// The signed auth_time must represent fresh authentication, not a silent token refresh.
function createWithdrawalHandler({db,auth,rateLimit,protectedMemberAdminUid,withdrawalPolicyReviewed=false,now=()=>Date.now()}){
 if(!db?.collection || !db?.runTransaction || typeof auth?.getUser!=='function' || typeof rateLimit!=='function')throw Error('Trusted dependencies required');
 return async caller=>{
  if(withdrawalPolicyReviewed!==true)return response(503,'unavailable');
  if(!verifiedCaller(caller)||privileged(caller))return response(403,'unavailable');
  if(typeof protectedMemberAdminUid!=='string'||!protectedMemberAdminUid.trim()||protectedMemberAdminUid==='REPLACE_WITH_ADMIN_UID')return response(503,'unavailable');
  if(caller.uid===protectedMemberAdminUid)return response(403,'unavailable');
  const timestamp=now(),authMillis=caller.auth_time*1000;
  if(!Number.isFinite(authMillis)||authMillis>timestamp+30000||authMillis<timestamp-300000)return response(403,'reauth_required');
  try{
   if(!await rateLimit(caller.uid,'status'))return response(429,'unavailable');
   // Latest server-side role check defends against stale ID-token custom claims.
   const account=await auth.getUser(caller.uid);if(privileged(account.customClaims)||account.disabled)return response(403,'unavailable');
   const ref=db.collection('account_lifecycle').doc(caller.uid);
   const result=await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists)return snap.data()?.status==='withdrawal_requested'?'pending':'unavailable';tx.create(ref,{status:'withdrawal_requested',requestedAt:new Date(timestamp)});return 'pending';});
   return result==='pending'?response(200,'pending'):response(409,'unavailable');
  }catch{return response(503,'unavailable');}
 };
}
module.exports={createWithdrawalHandler,privileged};

// Deliberately restricted to an isolated demo project. This worker removes ONLY
// a Firebase Auth account; it never asserts that membership, external stores,
// reservations or legal-retention obligations have been handled. A production
// worker needs independently enforced inventory, identity and restore controls.
function createDemoWithdrawalProcessor({db,auth,policy,protectedMemberAdminUid,now=()=>Date.now(),randomId=()=>require('node:crypto').randomBytes(16).toString('hex')}){
 const project='demo-okclean-integration';
 if(process.env.GCLOUD_PROJECT!==project || db?.projectId!==project || process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085' || process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099') throw Error('DEMO_EMULATOR_REQUIRED');
 if(!db?.runTransaction || !db?.collection || !auth?.getUser || !auth?.deleteUser) throw Error('Trusted dependencies required');
 return async function process(uid){
  if(policy?.reviewed!==true || policy?.allowDemoAuthDeletion!==true || !protectedMemberAdminUid || protectedMemberAdminUid==='REPLACE_WITH_ADMIN_UID')return {result:'policy_unconfirmed'};
  if(typeof uid!=='string'||!uid||uid.length>128||uid.includes('/')||uid===protectedMemberAdminUid)return {result:'blocked'};
  const ref=db.collection('account_lifecycle').doc(uid), token=randomId(), start=now();
  let claim;
  try{
   claim=await db.runTransaction(async tx=>{const snap=await tx.get(ref), v=snap.data();if(!snap.exists||v?.status!=='withdrawal_requested')return 'blocked';if(v.demoAuthState==='absent')return 'verify_absent';if(v.demoLeaseExpiresAt && new Date(v.demoLeaseExpiresAt.toDate?v.demoLeaseExpiresAt.toDate():v.demoLeaseExpiresAt).getTime()>start)return 'busy';tx.update(ref,{demoLeaseToken:token,demoLeaseExpiresAt:new Date(start+60000)});return 'claimed';});
   if(claim==='verify_absent'){try{await auth.getUser(uid);return {result:'uid_reused_blocked'};}catch(e){return {result:e?.code==='auth/user-not-found'?'absent':'retry_needed'};}}
   if(claim!=='claimed')return {result:claim};
   const reservations=await db.collection('quote_requests').where('ownerUid','==',uid).limit(1).get();
   if(!reservations.empty)return {result:'reservations_pending'};
   let account;
   try{account=await auth.getUser(uid);}catch(e){if(e?.code!=='auth/user-not-found')throw e;}
   if(account && (account.disabled || privileged(account.customClaims)))return {result:'blocked'};
   // A Firestore lease cannot fence Firebase Auth itself: production needs an
   // external account-provisioning freeze and conditional identity controls.
   const ownsLease=await db.runTransaction(async tx=>{const snap=await tx.get(ref), v=snap.data();const expiry=v?.demoLeaseExpiresAt;return snap.exists && v?.demoLeaseToken===token && new Date(expiry?.toDate?expiry.toDate():expiry).getTime()>now();});
   if(!ownsLease)return {result:'retry_needed'};
   if(account){try{await auth.deleteUser(uid);}catch(e){if(e?.code!=='auth/user-not-found')throw e;}}
   const finalized=await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists||snap.data()?.demoLeaseToken!==token)return false;tx.update(ref,{demoAuthState:'absent',demoAuthCheckedAt:new Date(now())});return true;});
   return {result:finalized?'auth_absent_pending_other_data':'retry_needed'};
  }catch{return {result:'retry_needed'};}
  finally{
   if(claim==='claimed')try{await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists&&snap.data()?.demoLeaseToken===token)tx.update(ref,{demoLeaseExpiresAt:new Date(0),demoLeaseToken:''});});}catch{}
  }
 };
}
module.exports.createDemoWithdrawalProcessor=createDemoWithdrawalProcessor;
