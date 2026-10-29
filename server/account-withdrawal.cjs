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
