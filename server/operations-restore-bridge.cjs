'use strict';
// Preparation-only composition. Does not release quarantine or issue serving
// attestations. Independent key and DB providers still require external fencing.
const crypto=require('node:crypto');
const {checkpointStorageMessage}=require('./checkpoint-store-adapter.cjs');
const fields=['sourceProject','ledgerProject','restoreId','servedDatabaseId','servedDatabaseUid','fenceId'];
const requestFields=['targetDatabaseUid','epoch','recordId','payloadDigest','requestId','operation','expectedRevision'];
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const restoreContextHash=b=>hash(Buffer.from(JSON.stringify(['okclean-isolated-restore-context-v1',...fields.map(k=>b[k])])));
const restoreAuthorizationBytes=(b,r,a)=>Buffer.from(JSON.stringify(['okclean-isolated-restore-request-v1',...fields.map(k=>b[k]),...requestFields.map(k=>r[k]),a.sequence,a.hash]));
function createRestoreEvidenceVerifier({lifecycle,checkpointStore,checkpointToken,binding,clock=Date.now}={}){
 if(typeof lifecycle?.verify!=='function'||typeof checkpointStore?.inspect!=='function'||!binding||fields.some(k=>typeof binding[k]!=='string'||!binding[k])||typeof clock!=='function')throw Error('RESTORE_BRIDGE_CONFIGURATION_REQUIRED');
 const b=structuredClone(binding);
 return async(evidence,request)=>{
  try{
   const e=structuredClone(evidence),r=structuredClone(request),a=e?.checkpointAnchor;
   if(r?.targetDatabaseUid!==b.servedDatabaseUid||r.epoch!==b.restoreId||r.operation!=='restore'||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0||!['recordId','requestId'].every(k=>/^[A-Za-z0-9_-]{1,80}$/.test(r[k]||''))||!/^[a-f0-9]{64}$/.test(r.payloadDigest||'')||!a||!Number.isSafeInteger(a.sequence)||a.sequence<1||!/^[a-f0-9]{64}$/.test(a.hash||''))throw Error();
   const archive=await checkpointStore.inspect({token:checkpointToken,expectedAnchor:a});
   if(archive?.historicalOnly!==true||archive.publishAllowed!==false||archive.anchor?.hash!==a.hash||archive.anchor.sequence!==a.sequence||!Array.isArray(archive.records)||archive.records.length!==a.sequence)throw Error();
   const last=archive.records.at(-1);
   if(!fields.every(k=>last?.evidence?.[k]===b[k])||last.sequence!==a.sequence||last.keyProof?.keyId!==last.keyId)throw Error();
   // Historical storage integrity alone cannot authorize a write. Require the
   // control key's current status, plus a request-specific issuer attestation.
   const control=await lifecycle.verify({envelope:last.keyProof,role:'control',purpose:'checkpoint',contextHash:restoreContextHash(b),payload:checkpointStorageMessage(last),historical:false,consume:false});
   const approval=await lifecycle.verify({envelope:e.envelope,role:'issuer',purpose:'attestation',contextHash:restoreContextHash(b),payload:restoreAuthorizationBytes(b,r,a),historical:false,consume:false});
   if(![control,approval].every(v=>v?.valid===true&&v.historical===false&&v.currentKeyValid===true&&v.authorizesOperation===false))throw Error();
   const now=clock(),expiresAt=Math.min(last.evidence.expiresAt,last.keyProof.expiresAt,e.envelope.expiresAt);
   if(!Number.isSafeInteger(now)||!Number.isSafeInteger(expiresAt)||expiresAt<=now)throw Error();
   return {...r,checkpointDigest:a.hash,expiresAt,historical:false,authorizesOperation:true,publishAllowed:false};
  }catch{throw Error('RESTORE_BRIDGE_EVIDENCE_REJECTED');}
 };
}
module.exports={createRestoreEvidenceVerifier,restoreAuthorizationBytes,restoreContextHash};
