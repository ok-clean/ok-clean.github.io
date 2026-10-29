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
   const creationTime=typeof account.metadata?.creationTime==='string'&&account.metadata.creationTime?account.metadata.creationTime:null;
   const ref=db.collection('account_lifecycle').doc(caller.uid);
   const result=await db.runTransaction(async tx=>{
    const snap=await tx.get(ref);
    if(snap.exists){
     const data=snap.data();if(data?.status!=='withdrawal_requested')return 'unavailable';
     if(data?.securityReview==='required')return 'review_required';
     // Never apply a previous request to a newly created Auth user with the
     // same UID. Legacy requests lacking the identity binding require review.
     if(!creationTime||!data?.authCreationTime||data.authCreationTime!==creationTime){tx.update(ref,{securityReview:'required'});return 'review_required';}
     tx.update(ref,{sessionRevocation:'pending'});return 'pending';
    }
    if(!creationTime)return 'identity_unavailable';
    tx.create(ref,{status:'withdrawal_requested',requestedAt:new Date(timestamp),sessionRevocation:'pending',authCreationTime:creationTime});return 'pending';
   });
   if(result==='unavailable')return response(409,'unavailable');
   if(result==='identity_unavailable')return response(503,'unavailable');
   if(result==='review_required')return response(403,'unavailable');
   // Reservation access is already frozen transactionally. Recheck latest
   // privileges before revoking refresh tokens; these systems cannot share a
   // transaction, so admin provisioning must also honour the lifecycle gate.
   const latest=await auth.getUser(caller.uid);
   if(latest.disabled||privileged(latest.customClaims)||latest.metadata?.creationTime!==creationTime){
    // Do not clear a lifecycle gate after privilege changes: another worker
    // might have started. Preserve a non-sensitive marker for manual review.
    await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists&&snap.data()?.status==='withdrawal_requested')tx.update(ref,{securityReview:'required'});});
    return response(403,'unavailable');
   }
   // Recheck the persisted request immediately before the external call.
   // Auth role/identity changes still require a separately enforced fence.
   const sameRequest=await db.runTransaction(async tx=>{const snap=await tx.get(ref),v=snap.data();return snap.exists&&v?.status==='withdrawal_requested'&&v?.securityReview!=='required'&&v?.sessionRevocation==='pending'&&v?.authCreationTime===creationTime;});
   if(!sameRequest)return response(403,'unavailable');
   await auth.revokeRefreshTokens(caller.uid);
   await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists||snap.data()?.status!=='withdrawal_requested'||snap.data()?.securityReview==='required'||snap.data()?.authCreationTime!==creationTime)throw Error('LIFECYCLE_CHANGED');tx.update(ref,{sessionRevocation:'revoked',sessionRevokedAt:new Date(now())});});
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
  let claim,expectedAuthCreationTime;
  try{
   claim=await db.runTransaction(async tx=>{const snap=await tx.get(ref), v=snap.data();if(!snap.exists||v?.status!=='withdrawal_requested')return 'blocked';if(v.securityReview==='required')return 'security_review_required';if(v.demoAuthState==='absent')return 'verify_absent';if(v.sessionRevocation!=='revoked')return 'session_revocation_pending';if(typeof v.authCreationTime!=='string'||!v.authCreationTime){tx.update(ref,{securityReview:'required'});return 'security_review_required';}expectedAuthCreationTime=v.authCreationTime;if(v.demoLeaseExpiresAt && new Date(v.demoLeaseExpiresAt.toDate?v.demoLeaseExpiresAt.toDate():v.demoLeaseExpiresAt).getTime()>start)return 'busy';tx.update(ref,{demoLeaseToken:token,demoLeaseExpiresAt:new Date(start+60000)});return 'claimed';});
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
   if(account && account.metadata?.creationTime!==expectedAuthCreationTime){
    await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(snap.exists&&snap.data()?.demoLeaseToken===token)tx.update(ref,{securityReview:'required'});});
    return {result:'security_review_required'};
   }
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

// Production-capable *non-destructive* recovery of an already-requested token
// revocation. It NEVER deletes a Firebase user or declares withdrawal complete.
// A separate, authorized Scheduler principal may run this bounded worker after
// the operator reviews the policy and configures the exact OIDC audience.
function createWithdrawalRecoveryHandler({db,auth,verifyOidc,config,now=()=>Date.now(),newId=()=>require('node:crypto').randomUUID()}){
 if(!db?.collection||!db?.runTransaction||typeof auth?.getUser!=='function'||typeof auth?.revokeRefreshTokens!=='function'||typeof verifyOidc!=='function')throw Error('Trusted dependencies required');
 const c=config||{}, validProject=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
 const ready=c.enabled===true&&c.policyReviewed===true&&validProject.test(c.projectId||'')&&db.projectId===c.projectId&&typeof c.audience==='string'&&/^https:\/\//.test(c.audience)&&typeof c.serviceAccount==='string'&&/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(c.serviceAccount)&&typeof c.protectedMemberAdminUid==='string'&&c.protectedMemberAdminUid.length>0&&c.protectedMemberAdminUid!=='REPLACE_WITH_ADMIN_UID';
 const control=db.collection('withdrawal_recovery_control').doc('current'),leaseMs=300000;
 function ts(x){return x instanceof Date?x.getTime():typeof x?.toDate==='function'?x.toDate().getTime():0;}
 function time(){const n=now();if(!Number.isFinite(n))throw Error('INVALID_CLOCK');return n;}
 async function claim(job){return db.runTransaction(async tx=>{const s=await tx.get(control),v=s.exists?s.data():{};const n=time();if(v.owner&&ts(v.expiresAt)>n)return null;const cursor=typeof v.cursor==='string'?v.cursor:null;tx.set(control,{owner:job,expiresAt:new Date(n+leaseMs),cursor});return {cursor};});}
 async function owns(job){return db.runTransaction(async tx=>{const s=await tx.get(control),v=s.data();return s.exists&&v?.owner===job&&ts(v.expiresAt)>time();});}
 async function finish(job,cursor,counts,outcome){return db.runTransaction(async tx=>{const s=await tx.get(control),v=s.data();if(!s.exists||v?.owner!==job)return false;tx.set(control,{owner:null,expiresAt:null,cursor,lastResult:outcome,lastCounts:counts,lastRunAt:new Date(time())});return true;});}
 async function markReview(ref,job){return db.runTransaction(async tx=>{const lock=await tx.get(control),s=await tx.get(ref),v=lock.data();if(!lock.exists||v?.owner!==job||ts(v.expiresAt)<=time()||!s.exists||s.data()?.status!=='withdrawal_requested')return false;tx.update(ref,{securityReview:'required',sessionRevocation:'pending'});return true;});}
 async function processOne(ref,job){
  const snapshot=await ref.get(),v=snapshot.exists?snapshot.data():null;
  if(!v||v.status!=='withdrawal_requested'||v.sessionRevocation!=='pending'||v.securityReview==='required')return 'skipped';
  if(ref.id===c.protectedMemberAdminUid||typeof v.authCreationTime!=='string'||!v.authCreationTime){return await markReview(ref,job)?'review':'retry';}
  let first;
  try{first=await auth.getUser(ref.id);}catch(e){if(e?.code==='auth/user-not-found'){return await markReview(ref,job)?'review':'retry';}throw e;}
  if(first.uid!==ref.id||first.disabled||privileged(first.customClaims)||first.metadata?.creationTime!==v.authCreationTime){return await markReview(ref,job)?'review':'retry';}
  const gate=await db.runTransaction(async tx=>{const lock=await tx.get(control),s=await tx.get(ref),v=lock.data(),x=s.data();return lock.exists&&v?.owner===job&&ts(v.expiresAt)>time()&&s.exists&&x?.status==='withdrawal_requested'&&x?.securityReview!=='required'&&x?.sessionRevocation==='pending'&&x?.authCreationTime===first.metadata.creationTime;});
  if(!gate)return 'retry';
  // Firebase Auth and Firestore do not share a transaction. This operation is
  // limited to revoking sessions. External privilege changes require separate
  // account-provisioning coordination and are rechecked after the call.
  await auth.revokeRefreshTokens(ref.id);
  const after=await auth.getUser(ref.id);
  if(after.uid!==ref.id||after.disabled||privileged(after.customClaims)||after.metadata?.creationTime!==first.metadata.creationTime){return await markReview(ref,job)?'review':'retry';}
  const committed=await db.runTransaction(async tx=>{const lock=await tx.get(control),s=await tx.get(ref),v=lock.data(),x=s.data();if(!lock.exists||v?.owner!==job||ts(v.expiresAt)<=time()||!s.exists||x?.status!=='withdrawal_requested'||x?.securityReview==='required'||x?.sessionRevocation!=='pending'||x?.authCreationTime!==after.metadata.creationTime)return false;tx.update(ref,{sessionRevocation:'revoked',sessionRevokedAt:new Date(time())});return true;});
  return committed?'revoked':'retry';
 }
 return async function(req,res){
  res.setHeader('Cache-Control','no-store');const reply=(status,body)=>res.status(status).json(body);
  if(req.method!=='POST')return reply(405,{status:'unavailable'});
  if(!ready)return reply(503,{status:'unavailable'});
  const bearer=/^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization||'');if(!bearer)return reply(401,{status:'unauthorized'});
  try{const p=await verifyOidc(bearer[1],c.audience);if(!p||p.aud!==c.audience||!['https://accounts.google.com','accounts.google.com'].includes(p.iss)||p.email_verified!==true||p.email!==c.serviceAccount)throw Error('UNAUTHORIZED');}catch{return reply(401,{status:'unauthorized'});}
  const job=newId();if(typeof job!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(job))return reply(503,{status:'unavailable'});
  let lease;try{lease=await claim(job);}catch{return reply(503,{status:'unavailable'});}if(!lease)return reply(409,{status:'busy'});
  const counts={revoked:0,review:0,skipped:0};
  try{
   let query=db.collection('account_lifecycle').where('sessionRevocation','==','pending').orderBy('__name__');if(lease.cursor)query=query.startAfter(lease.cursor);
   const page=await query.limit(26).get(),docs=page.docs.slice(0,25);
   for(const doc of docs){if(!await owns(job))throw Error('FENCE_LOST');const outcome=await processOne(doc.ref,job);if(outcome==='retry')throw Error('RETRY');counts[outcome]++;}
   const cursor=page.docs.length>25?docs[docs.length-1].id:null;
   if(!await finish(job,cursor,counts,'batch_processed'))throw Error('FENCE_LOST');return reply(200,{status:'batch_processed',hasMore:cursor!==null,counts});
  }catch{try{await finish(job,lease.cursor,counts,'retry_needed');}catch{}return reply(503,{status:'retry_needed'});}
 };
}
module.exports.createWithdrawalRecoveryHandler=createWithdrawalRecoveryHandler;
