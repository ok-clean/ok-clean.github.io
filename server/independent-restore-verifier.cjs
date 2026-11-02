'use strict';
// Preparation-only, read-only verifier of an ALREADY replayed isolated restore.
// No production entrypoint, fence/IAM controller, deletion or replay executor is
// supplied here. The existing production issuer hard guard MUST remain false.
// Signed external evidence is meaningful only when its independent authority
// actually controls and verifies the writers/fence and immutable full snapshot.
// Trusted adapters/SDK configuration are a runtime boundary, not HTTP inputs.
const crypto=require('node:crypto');
const {auditRestoredDeletionState,validationMessage}=require('./restore-issuer.cjs');
const common=['sourceProject','ledgerProject','restoreId','servedDatabaseId','servedDatabaseUid','fenceId','issuedAt','expiresAt'];
function fenceMessage(v){return Buffer.from(JSON.stringify(['okclean-external-restore-fence-v1',...common.map(k=>v[k]),v.state]));}
function checkpointMessage(v){return Buffer.from(JSON.stringify(['okclean-immutable-deletion-checkpoint-v1',...common.map(k=>v[k]),v.checkpoint,v.ledgerRevision,v.recordCount,v.state]));}
function publicKey(value){const key=crypto.createPublicKey(value);if(key.asymmetricKeyType!=='ed25519')throw Error('VERIFIER_KEY_INVALID');return key;}
const fp=k=>k.export({format:'der',type:'spki'}).toString('hex');
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function createIndependentRestoreVerifier(config){
 const {ledgerDb,sourceDb,restoredDb,sourceProject,ledgerProject,restoreId,restoredDatabaseId,resolveDbIdentity,sign,now=()=>Date.now(),timeoutMs=5000}=config||{};
 if(typeof sign!=='function'||typeof now!=='function'||typeof resolveDbIdentity!=='function'||!ledgerDb?.runTransaction||!ledgerDb?.collection||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||! /^[A-Za-z0-9_-]{16,80}$/.test(restoreId||'')||typeof sourceProject!=='string'||typeof ledgerProject!=='string')throw Error('VERIFIER_CONFIGURATION_REQUIRED');
 let authority,validator,issuer;try{authority=publicKey(config.controlAuthorityPublicKey);validator=publicKey(config.validatorPublicKey);issuer=publicKey(config.issuerPublicKey);}catch{throw Error('VERIFIER_KEY_INVALID');}
 if(new Set([fp(authority),fp(validator),fp(issuer)]).size!==3)throw Error('INDEPENDENT_KEYS_REQUIRED');
 const fenceRef=ledgerDb.collection('restore_fence_evidence').doc(restoreId),checkpointRef=ledgerDb.collection('restore_checkpoint_evidence').doc(restoreId),validationRef=ledgerDb.collection('restore_validation').doc(restoreId),headRef=ledgerDb.collection('deletion_ledger_meta').doc(sourceProject),entries=ledgerDb.collection('deletion_ledger');
 const sameBinding=(v,uid)=>v?.sourceProject===sourceProject&&v.ledgerProject===ledgerProject&&v.restoreId===restoreId&&v.servedDatabaseId===restoredDatabaseId&&v.servedDatabaseUid===uid&&/^[A-Za-z0-9_-]{16,80}$/.test(v.fenceId||'');
 function signed(v,message,t,uid){return sameBinding(v,uid)&&Number.isSafeInteger(v.issuedAt)&&Number.isSafeInteger(v.expiresAt)&&v.issuedAt<=t&&v.expiresAt>t&&v.expiresAt-v.issuedAt<=600000&&v.expiresAt>v.issuedAt&&/^[A-Za-z0-9_-]{86}$/.test(v.signature||'')&&crypto.verify(null,message(v),authority,Buffer.from(v.signature,'base64url'));}
 function evidence(f,c,t,uid){if(!signed(f,fenceMessage,t,uid)||f.state!=='held'||!signed(c,checkpointMessage,t,uid)||c.state!=='immutable-complete'||f.fenceId!==c.fenceId||!/^[a-f0-9]{64}$/.test(c.checkpoint||'')||!Number.isSafeInteger(c.ledgerRevision)||c.ledgerRevision<0||!Number.isSafeInteger(c.recordCount)||c.recordCount<0||c.recordCount>100000)throw Error('SIGNED_EXTERNAL_EVIDENCE_REQUIRED');}
 return Object.freeze({async verify(){
  let active=true,timer;const started=now();if(!Number.isSafeInteger(started))throw Error('INVALID_CLOCK');const deadline=started+timeoutMs;
  function alive(){const t=now();if(!active||!Number.isSafeInteger(t)||t<started||t>=deadline)throw Error('VERIFIER_TIMEOUT');return t;}
  const bounded=(async()=>{
   const id=await resolveDbIdentity({projectId:sourceProject,databaseId:restoredDatabaseId});alive();
   if(id?.projectId!==sourceProject||id.databaseId!==restoredDatabaseId||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id.uid||''))throw Error('RESTORE_IDENTITY_INVALID');
   const [fs,cs]=await Promise.all([fenceRef.get(),checkpointRef.get()]);alive();if(!fs.exists||!cs.exists)throw Error('SIGNED_EXTERNAL_EVIDENCE_REQUIRED');
   const f=fs.data(),c=cs.data();evidence(f,c,alive(),id.uid);
   const audited=await auditRestoredDeletionState({ledgerDb,sourceDb,restoredDb,sourceProject,ledgerProject,restoredDatabaseId,resolveDbIdentity,identityTimeoutMs:timeoutMs,checkpoint:c.checkpoint,ledgerRevision:c.ledgerRevision,recordCount:c.recordCount});alive();
   if(audited.servedDatabaseUid!==id.uid)throw Error('RESTORE_IDENTITY_CHANGED');
   const issuedAt=alive(),expiresAt=Math.min(deadline,f.expiresAt,c.expiresAt);
   const proof={sourceProject,ledgerProject,restoreId,servedDatabaseId:restoredDatabaseId,servedDatabaseUid:id.uid,checkpoint:audited.checkpoint,ledgerRevision:audited.ledgerRevision,recordCount:audited.recordCount,issuedAt,expiresAt,isolated:true,replayed:true,state:'verified'};
   const signature=await sign(validationMessage(proof));alive();if(!Buffer.isBuffer(signature)||signature.length!==64||!crypto.verify(null,validationMessage(proof),validator,signature))throw Error('VALIDATOR_SIGNATURE_INVALID');proof.signature=signature.toString('base64url');
   const finalId=await resolveDbIdentity({projectId:sourceProject,databaseId:restoredDatabaseId});alive();if(!equal(finalId,id))throw Error('RESTORE_IDENTITY_CHANGED');
   // Atomic storage adapter is the trusted ledger SDK transaction. Re-read the
   // signed evidence, revision and pending set in the same transaction as the
   // proof write. A boolean "store succeeded" callback is never accepted.
   await ledgerDb.runTransaction(async tx=>{
    const [freshF,freshC,head,pending,old]=await Promise.all([tx.get(fenceRef),tx.get(checkpointRef),tx.get(headRef),tx.get(entries.where('state','==','pending').limit(1)),tx.get(validationRef)]);
    const t=alive();if(!freshF.exists||!freshC.exists||!equal(freshF.data(),f)||!equal(freshC.data(),c))throw Error('EXTERNAL_EVIDENCE_CHANGED');evidence(freshF.data(),freshC.data(),t,id.uid);
    if(!head.exists||head.data()?.revision!==proof.ledgerRevision||pending.empty!==true)throw Error('RESTORE_LEDGER_UNSTABLE');
    // Do not replace an existing, newer independently signed proof. This driver
    // deliberately refuses conflicts rather than assuming overwrite authority.
    if(old.exists&&old.data()?.issuedAt>=proof.issuedAt)throw Error('VALIDATION_WRITE_CONFLICT');
    if(t>=proof.expiresAt)throw Error('VERIFIER_TIMEOUT');tx.set(validationRef,proof);
   });alive();return proof;
  })();
  // A late signer/audit cannot proceed to storage. A late transaction may have
  // committed, but its proof expires no later than this deadline and is unusable
  // by the issuer thereafter. No routine here releases the external fence.
  try{return await Promise.race([bounded,new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Error('VERIFIER_TIMEOUT'));},timeoutMs);})]);}finally{active=false;clearTimeout(timer);}
 }});
}
module.exports={createIndependentRestoreVerifier,fenceMessage,checkpointMessage};
