'use strict';
// Associate an existing membership record to a reservation account only when
// the caller controls both Firebase identities. No name/phone matching is used.
const {verifiedCaller}=require('./customer-reservations.cjs');
const SAFE_ID=/^[A-Za-z0-9_-]{1,128}$/;
const result=(httpStatus,status)=>({httpStatus,body:{status}});
function createMemberAccountLinkHandler({db,auth,rateLimit,enabled=false,policyVersion,now=()=>Date.now()}){
 if(!db?.collection||!db?.runTransaction||typeof auth?.verifyIdToken!=='function'||typeof rateLimit!=='function')throw Error('Trusted dependencies required');
 return async function link(caller,input){
  if(enabled!==true||typeof policyVersion!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(policyVersion))return result(503,'unavailable');
  if(!verifiedCaller(caller)||!SAFE_ID.test(caller.uid))return result(403,'unavailable');
  const authMs=caller.auth_time*1000,time=now();
  if(!Number.isFinite(authMs)||authMs>time+30000||authMs<time-300000)return result(403,'reauth_required');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='consent,memberId,memberIdToken,policyVersion'||input.consent!==true||input.policyVersion!==policyVersion||!SAFE_ID.test(input.memberId||'')||typeof input.memberIdToken!=='string'||input.memberIdToken.length<1||input.memberIdToken.length>4096)return result(400,'unavailable');
  try{
   if(await rateLimit(caller.uid,'status')!==true)return result(429,'unavailable');
   // Admin SDK verifies signature, audience, issuer and revocation for the
   // configured project. A caller-supplied UID is never accepted as proof.
   const member=await auth.verifyIdToken(input.memberIdToken,true);
   if(member?.firebase?.sign_in_provider!=='anonymous'||!SAFE_ID.test(member.uid||'')||member.uid===caller.uid)return result(403,'unavailable');
   const gate=db.collection('account_lifecycle').doc(caller.uid);
   const record=db.collection('member_requests').doc(input.memberId);
   const byMember=db.collection('member_account_links').doc(input.memberId);
   const byAccount=db.collection('account_member_links').doc(caller.uid);
   const byIdentity=db.collection('member_identity_links').doc(member.uid);
   const state=await db.runTransaction(async tx=>{
    const life=await tx.get(gate), membership=await tx.get(record), existingMember=await tx.get(byMember), existingAccount=await tx.get(byAccount), existingIdentity=await tx.get(byIdentity);
    if(life.exists)return 'blocked';
    // Legacy records with no ownerUid are held for an independently verified
    // manual workflow; knowledge of a document ID confers no ownership.
    if(!membership.exists||membership.data()?.ownerUid!==member.uid)return 'blocked';
    const m=existingMember.data(),a=existingAccount.data(),i=existingIdentity.data();
    if(existingMember.exists||existingAccount.exists||existingIdentity.exists){
     if(existingMember.exists&&existingAccount.exists&&existingIdentity.exists&&m?.reservationUid===caller.uid&&m?.memberOwnerUid===member.uid&&a?.memberId===input.memberId&&a?.memberOwnerUid===member.uid&&i?.memberId===input.memberId&&i?.reservationUid===caller.uid&&m?.policyVersion===policyVersion&&a?.policyVersion===policyVersion&&i?.policyVersion===policyVersion)return 'linked';
     return 'conflict';
    }
    // Transactionally enforce one member record per account and one account per record.
    // The reviewed policy version and timestamp are stored in the same
    // transaction as the relationship. No consent text or tokens are logged.
    tx.create(byMember,{reservationUid:caller.uid,memberOwnerUid:member.uid,policyVersion,consentAt:new Date(time)});
    tx.create(byAccount,{memberId:input.memberId,memberOwnerUid:member.uid,policyVersion,consentAt:new Date(time)});
    tx.create(byIdentity,{memberId:input.memberId,reservationUid:caller.uid,policyVersion,consentAt:new Date(time)});
    return 'linked';
   });
   return state==='linked'?result(200,'linked'):state==='conflict'?result(409,'unavailable'):result(403,'unavailable');
  }catch{return result(503,'unavailable');}
 };
}
module.exports={createMemberAccountLinkHandler};
