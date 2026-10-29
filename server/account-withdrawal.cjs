'use strict';
const {verifiedCaller}=require('./customer-reservations.cjs');
const response=(code,status)=>({httpStatus:code,body:{status}});
const privileged=c=>c?.admin===true||c?.member_admin===true||c?.reservation_admin===true||c?.super_admin===true;
// The signed auth_time must represent fresh authentication, not a silent token refresh.
function createWithdrawalHandler({db,auth,rateLimit,protectedMemberAdminUid,withdrawalPolicyReviewed=false,now=()=>Date.now()}){
 if(!db?.collection || !db?.runTransaction || typeof auth?.getUser!=='function' || typeof auth?.revokeRefreshTokens!=='function' || typeof rateLimit!=='function')throw Error('Trusted dependencies required');
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
   const result=await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists){if(snap.data()?.status!=='withdrawal_requested')return 'unavailable';if(snap.data()?.securityReview==='required')return 'review_required';tx.update(ref,{sessionRevocation:'pending'});return 'pending';}tx.create(ref,{status:'withdrawal_requested',requestedAt:new Date(timestamp),sessionRevocation:'pending'});return 'pending';});
   if(result==='unavailable')return response(409,'unavailable');
   if(result==='review_required')return response(403,'unavailable');
   // Reservation access is already frozen transactionally. Recheck latest
   // privileges before revoking refresh tokens; these systems cannot share a
   // transaction, so admin provisioning must also honour the lifecycle gate.
   const latest=await auth.getUser(caller.uid);
   if(latest.disabled||privileged(latest.customClaims)){
    // Do not clear a lifecycle gate after privilege changes: another worker
    // might have started. Preserve a non-sensitive marker for manual review.
    await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists&&snap.data()?.status==='withdrawal_requested')tx.update(ref,{securityReview:'required'});});
    return response(403,'unavailable');
   }
   await auth.revokeRefreshTokens(caller.uid);
   await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists||snap.data()?.status!=='withdrawal_requested'||snap.data()?.securityReview==='required')throw Error('LIFECYCLE_CHANGED');tx.update(ref,{sessionRevocation:'revoked',sessionRevokedAt:new Date(now())});});
   return response(200,'pending');
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
   claim=await db.runTransaction(async tx=>{const snap=await tx.get(ref), v=snap.data();if(!snap.exists||v?.status!=='withdrawal_requested')return 'blocked';if(v.securityReview==='required')return 'security_review_required';if(v.demoAuthState==='absent')return 'verify_absent';if(v.sessionRevocation!=='revoked')return 'session_revocation_pending';if(v.demoLeaseExpiresAt && new Date(v.demoLeaseExpiresAt.toDate?v.demoLeaseExpiresAt.toDate():v.demoLeaseExpiresAt).getTime()>start)return 'busy';tx.update(ref,{demoLeaseToken:token,demoLeaseExpiresAt:new Date(start+60000)});return 'claimed';});
   if(claim==='verify_absent'){try{await auth.getUser(uid);return {result:'uid_reused_blocked'};}catch(e){return {result:e?.code==='auth/user-not-found'?'absent':'retry_needed'};}}
   if(claim!=='claimed')return {result:claim};
   // Check for reservations and freeze related writes in one transaction.
   // Reservation creation and supported history writers must also read this
   // lifecycle document inside their write transactions.
   const freeze=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref),v=snap.data();
    const expiry=v?.demoLeaseExpiresAt;
    if(!snap.exists||v?.status!=='withdrawal_requested'||v?.securityReview==='required'||v?.sessionRevocation!=='revoked'||v?.demoLeaseToken!==token||new Date(expiry?.toDate?expiry.toDate():expiry).getTime()<=now())return 'retry_needed';
    const reservations=await tx.get(db.collection('quote_requests').where('ownerUid','==',uid).limit(1));
    if(!reservations.empty)return 'reservations_pending';
    // A known member link is unresolved customer data, so never delete Auth.
    // Link creation must read the same lifecycle record in its transaction.
    // Absence proves nothing about unlinked legacy or external records.
    const memberLink=await tx.get(db.collection('account_member_links').doc(uid));
    if(memberLink.exists)return 'member_data_pending';
    tx.update(ref,{dataMutationFrozen:true});return 'frozen';
   });
   if(freeze!=='frozen')return {result:freeze};
   let account;
   try{account=await auth.getUser(uid);}catch(e){if(e?.code!=='auth/user-not-found')throw e;}
   if(account && (account.disabled || privileged(account.customClaims)))return {result:'blocked'};
   // A Firestore lease cannot fence Firebase Auth itself: production needs an
   // external account-provisioning freeze and conditional identity controls.
   if(account){
    const fresh=await auth.getUser(uid);
    if(fresh.disabled||privileged(fresh.customClaims))return {result:'blocked'};
    // Detect a known UID being deleted and recreated between checks. The Auth
    // API has no conditional delete, leaving a final unavoidable race.
    if(!account.metadata?.creationTime||account.metadata.creationTime!==fresh.metadata?.creationTime)return {result:'retry_needed'};
   }
   const ownsLease=await db.runTransaction(async tx=>{const snap=await tx.get(ref), v=snap.data();const expiry=v?.demoLeaseExpiresAt;return snap.exists && v?.status==='withdrawal_requested' && v?.securityReview!=='required' && v?.sessionRevocation==='revoked' && v?.dataMutationFrozen===true && v?.demoLeaseToken===token && new Date(expiry?.toDate?expiry.toDate():expiry).getTime()>now();});
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
