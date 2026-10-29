'use strict';
// Dedicated privileged issuer. It cannot itself prove a network fence or the
// completeness of a checkpoint: an independently authenticated verifier must
// attest those facts. Missing or stale evidence always denies issuance.
const crypto=require('node:crypto');
const {message:gateMessage}=require('./restore-gate.cjs');
const proj=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,epoch=/^[A-Za-z0-9_-]{16,80}$/,hex=/^[a-f0-9]{64}$/;
function validationMessage(v){return Buffer.from(JSON.stringify(['okclean-independent-restore-validation-v1',v.sourceProject,v.ledgerProject,v.restoreId,v.checkpoint,v.ledgerRevision,v.recordCount,v.issuedAt,v.expiresAt,v.isolated,v.replayed,v.state]));}
function parseEd25519(value){let k;try{k=crypto.createPublicKey(value);}catch{throw Error('PUBLIC_KEY_INVALID');}if(k.asymmetricKeyType!=='ed25519')throw Error('PUBLIC_KEY_INVALID');return k;}
function recordBytes(r){
 if(!r||typeof r.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(r.id)||!['redacted','history_purged'].includes(r.action)||r.state!=='committed'||typeof r.expectedVersion!=='string'||!/^\d+:\d{1,9}$/.test(r.expectedVersion)||typeof r.expectedHistoryVersion!=='string'||!hex.test(r.expectedHistoryVersion))throw Error('LEDGER_INVALID');
 return JSON.stringify([r.sourceProject,r.id,r.action,r.state,r.expectedVersion,r.expectedHistoryVersion])+'\n';
}
function createRestoreIssuer({ledgerDb,ledger,sourceProject,ledgerProject,restoreId,authorityPublicKey,gatePublicKey,verifyOidc,callerEmail,audience,sign,now=()=>Date.now()}){
 if(!proj.test(sourceProject||'')||!proj.test(ledgerProject||'')||sourceProject===ledgerProject||ledgerDb?.projectId!==ledgerProject||!epoch.test(restoreId||'')||!ledgerDb?.collection||!ledgerDb?.runTransaction||!ledger?.page||!ledger?.assertNoPending||ledger.safety?.sourceProjectId!==sourceProject||ledger.safety?.ledgerProjectId!==ledgerProject||typeof verifyOidc!=='function'||typeof sign!=='function'||!/^https:\/\//.test(audience||'')||!/^[-a-z0-9]+@[-a-z0-9]+\.iam\.gserviceaccount\.com$/.test(callerEmail||''))throw Error('ISSUER_CONFIGURATION_INVALID');
 const authority=parseEd25519(authorityPublicKey),gate=parseEd25519(gatePublicKey);
 if(authority.export({type:'spki',format:'der'}).equals(gate.export({type:'spki',format:'der'})))throw Error('INDEPENDENT_AUTHORITY_REQUIRED');
 const head=ledgerDb.collection('deletion_ledger_meta').doc(sourceProject),validation=ledgerDb.collection('restore_validation').doc(restoreId),control=ledgerDb.collection('restore_control').doc('serving'),entries=ledgerDb.collection('deletion_ledger');
 function validate(v,time){
  if(!v||v.sourceProject!==sourceProject||v.ledgerProject!==ledgerProject||v.restoreId!==restoreId||v.state!=='verified'||v.isolated!==true||v.replayed!==true||!hex.test(v.checkpoint||'')||!Number.isSafeInteger(v.ledgerRevision)||v.ledgerRevision<0||!Number.isSafeInteger(v.recordCount)||v.recordCount<0||v.recordCount>100000||!Number.isSafeInteger(v.issuedAt)||!Number.isSafeInteger(v.expiresAt)||v.issuedAt>time+30000||v.expiresAt<=time||v.expiresAt<=v.issuedAt||v.expiresAt-v.issuedAt>600000||typeof v.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(v.signature))return false;
  return crypto.verify(null,validationMessage(v),authority,Buffer.from(v.signature,'base64url'));
 }
 async function snapshot(v){
  const digest=crypto.createHash('sha256');let after,count=0;
  for(;;){
   let q=entries.orderBy('__name__');if(after!==undefined)q=q.startAfter(after);
   const page=await q.limit(100).get();if(!page||!Array.isArray(page.docs)||page.docs.length>100)throw Error('LEDGER_INVALID');
   for(const doc of page.docs){const row=doc.data();if(row?.sourceProject!==sourceProject)throw Error('LEDGER_INVALID');
    const expected=crypto.createHash('sha256').update(sourceProject).update('\0').update(row.action||'').update('\0').update(row.id||'').digest('hex');
    if(doc.id!==expected||(after!==undefined&&doc.id<=after))throw Error('LEDGER_KEY_INVALID');
    digest.update(recordBytes(row));if(++count>100000)throw Error('LEDGER_TOO_LARGE');after=doc.id;
   }
   if(page.docs.length<100)break;
  }
  if(count!==v.recordCount||digest.digest('hex')!==v.checkpoint)throw Error('CHECKPOINT_MISMATCH');
 }
 async function issue(){
  const start=now(),proofSnap=await validation.get(),proof=proofSnap.data();if(!Number.isSafeInteger(start)||!proofSnap.exists||!validate(proof,start))throw Error('VALIDATION_REQUIRED');
  const headSnap=await head.get();if(!headSnap.exists||headSnap.data()?.revision!==proof.ledgerRevision)throw Error('REVISION_MISMATCH');
  await ledger.assertNoPending();await snapshot(proof);
  const issuedAt=now(),expiresAt=Math.min(issuedAt+300000,proof.expiresAt);if(!validate(proof,issuedAt)||expiresAt<=issuedAt)throw Error('VALIDATION_EXPIRED');
  const certificate={sourceProject,ledgerProject,restoreId,checkpoint:proof.checkpoint,ledgerRevision:proof.ledgerRevision,issuedAt,expiresAt,state:'cleared'};
  const sig=await sign(gateMessage(certificate));if(!Buffer.isBuffer(sig)||sig.length!==64||!crypto.verify(null,gateMessage(certificate),gate,sig))throw Error('SIGNATURE_INVALID');
  certificate.signature=sig.toString('base64url');
  await ledgerDb.runTransaction(async tx=>{
   const current=await tx.get(validation),currentHead=await tx.get(head),pending=await tx.get(entries.where('state','==','pending').limit(1)),old=await tx.get(control);
   if(!current.exists||!validate(current.data(),now())||!crypto.timingSafeEqual(crypto.createHash('sha256').update(validationMessage(current.data())).update(current.data().signature).digest(),crypto.createHash('sha256').update(validationMessage(proof)).update(proof.signature).digest())||!currentHead.exists||currentHead.data()?.revision!==proof.ledgerRevision||!pending.empty||now()>=expiresAt)throw Error('REVALIDATION_FAILED');
   // Concurrent invocations can finish in the opposite order. Never shorten a
   // newer valid certificate, but only trust one independently signed by our
   // configured key for this exact project, epoch, checkpoint and revision.
   const v=old.exists?old.data():null,t=now();
   if(v&&v.sourceProject===sourceProject&&v.ledgerProject===ledgerProject&&v.restoreId===restoreId&&v.state==='cleared'&&v.checkpoint===proof.checkpoint&&v.ledgerRevision===proof.ledgerRevision&&Number.isSafeInteger(v.issuedAt)&&Number.isSafeInteger(v.expiresAt)&&v.issuedAt<=t+30000&&v.expiresAt>certificate.expiresAt&&v.expiresAt<=proof.expiresAt&&v.expiresAt>v.issuedAt&&v.expiresAt-v.issuedAt<=600000&&typeof v.signature==='string'&&/^[A-Za-z0-9_-]{86}$/.test(v.signature)&&crypto.verify(null,gateMessage(v),gate,Buffer.from(v.signature,'base64url')))return;
   tx.set(control,certificate);
  });
  return true;
 }
 return async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
  const reply=(status)=>{res.statusCode=status;return res.end(JSON.stringify({status:status===200?'issued':'unavailable'}));};
  if(req.method!=='POST')return reply(405);
  const token=(req.headers.authorization||'').match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];if(!token)return reply(401);
  try{const p=await verifyOidc(token,audience);if(!p||p.aud!==audience||!['accounts.google.com','https://accounts.google.com'].includes(p.iss)||p.email!==callerEmail||p.email_verified!==true)return reply(401);}catch{return reply(401);}
  try{await issue();return reply(200);}catch{return reply(503);}
 };
}
module.exports={createRestoreIssuer,validationMessage,recordBytes};

// Read-only comparison for an already isolated restore. This cannot establish
// isolation, checkpoint completeness, or authorization and never signs proof.
// An independent authority must verify those properties and keep all writers
// fenced from the start of this scan until the restored service is released.
async function auditRestoredDeletionState({ledgerDb,restoredDb,sourceProject,ledgerProject,checkpoint,ledgerRevision,recordCount}){
 if(!proj.test(sourceProject||'')||!proj.test(ledgerProject||'')||sourceProject===ledgerProject||ledgerDb?.projectId!==ledgerProject||restoredDb?.projectId!==sourceProject||!ledgerDb?.collection||!ledgerDb?.runTransaction||!restoredDb?.collection||!hex.test(checkpoint||'')||!Number.isSafeInteger(ledgerRevision)||ledgerRevision<0||!Number.isSafeInteger(recordCount)||recordCount<0||recordCount>100000)throw Error('RESTORE_AUDIT_CONFIGURATION_INVALID');
 const entries=ledgerDb.collection('deletion_ledger'),head=ledgerDb.collection('deletion_ledger_meta').doc(sourceProject);
 async function stable(){return ledgerDb.runTransaction(async tx=>{
  const h=await tx.get(head),pending=await tx.get(entries.where('state','==','pending').limit(1));
  if(!h.exists||h.data()?.revision!==ledgerRevision||pending.empty!==true)throw Error('RESTORE_LEDGER_UNSTABLE');
 },{readOnly:true});}
 const exactKeys=['dataMutationFrozen','legalHold','redactedAt','retentionFreeze','retentionRedacted','status','terminalAt'].sort();
 const timeValue=x=>x instanceof Date?x.getTime():typeof x?.toDate==='function'?x.toDate().getTime():NaN;
 const digest=crypto.createHash('sha256');let after,count=0;
 await stable();
 for(;;){
  let q=entries.orderBy('__name__');if(after!==undefined)q=q.startAfter(after);
  const page=await q.limit(100).get();if(!Array.isArray(page.docs)||page.docs.length>100)throw Error('RESTORE_LEDGER_INVALID');
  for(const doc of page.docs){
   const row=doc.data();
   if(row?.sourceProject!==sourceProject)throw Error('RESTORE_LEDGER_INVALID');
   const expected=crypto.createHash('sha256').update(sourceProject).update('\0').update(row.action||'').update('\0').update(row.id||'').digest('hex');
   if(doc.id!==expected||(after!==undefined&&doc.id<=after))throw Error('RESTORE_LEDGER_INVALID');
   digest.update(recordBytes(row));if(++count>100000)throw Error('RESTORE_LEDGER_INVALID');after=doc.id;
   const ref=restoredDb.collection('quote_requests').doc(row.id),snap=await ref.get();
   if(!snap.exists)throw Error('RESTORE_REAPPLICATION_REQUIRED');
   const v=snap.data();
   if(!v||JSON.stringify(Object.keys(v).sort())!==JSON.stringify(exactKeys)||v.retentionRedacted!==true||v.status!=='보유기간만료'||v.legalHold!==false||v.dataMutationFrozen!==true||v.retentionFreeze!=='retention-v1'||!Number.isFinite(timeValue(v.terminalAt))||!Number.isFinite(timeValue(v.redactedAt)))throw Error('RESTORE_REAPPLICATION_REQUIRED');
   const cols=await ref.listCollections();
   if(cols.some(c=>c.id!=='status_history'))throw Error('RESTORE_UNKNOWN_DEPENDENCIES');
   const history=await ref.collection('status_history').limit(201).get();
   // A restored history entry may contain identifying data, even under an
   // apparently valid field name. Without an independent content checkpoint,
   // it cannot be distinguished from a deleted or modified entry. Fail
   // closed for both actions. This also blocks legitimately retained history
   // until an independently verified history baseline is available.
   if(history.size)throw Error('RESTORE_HISTORY_BASELINE_REQUIRED');
   const afterSnap=await ref.get();
   if(!afterSnap.exists||!snap.updateTime?.isEqual(afterSnap.updateTime))throw Error('RESTORE_DATA_CHANGED');
  }
  if(page.docs.length<100)break;
 }
 if(count!==recordCount||digest.digest('hex')!==checkpoint)throw Error('RESTORE_CHECKPOINT_MISMATCH');
 await stable();
 return {recordCount:count,checkpoint,ledgerRevision};
}
module.exports.auditRestoredDeletionState=auditRestoredDeletionState;
