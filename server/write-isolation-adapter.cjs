'use strict';
// Preparation adapter only: not imported by the customer API/production issuer.
// The provider MUST serialize control/principal/idempotency/record/audit in ONE
// target-database transaction and enforce deadlineMs at commit. All writers,
// including Admin SDKs, must use that boundary or be fenced externally. This
// interface cannot manufacture an IAM/network fence or a cross-project atomicity.
// Restore key status is rechecked before staging, but a separate key registry
// cannot be atomically committed with this datastore: the external writer fence
// must cover that final race before any production adapter can be activated.
const crypto=require('node:crypto');
const id=/^[A-Za-z0-9_-]{1,80}$/;
const uid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operations=new Set(['create','update','restore','delete']);
const errorCodes=new Set(['WRITE_ADAPTER_CONFIGURATION_REQUIRED', 'WRITE_ADMIN_REQUIRED', 'WRITE_AUTHORIZATION_CHANGED', 'WRITE_AUTHORIZATION_REQUIRED', 'WRITE_CLOCK_INVALID', 'WRITE_DEADLINE_EXPIRED', 'WRITE_FENCE_REQUIRED', 'WRITE_IDEMPOTENCY_CONFLICT', 'WRITE_INPUT_INVALID', 'WRITE_RECORD_EXISTS', 'WRITE_RECORD_MISSING', 'WRITE_RECORD_TOMBSTONED', 'WRITE_RESTORE_EVIDENCE_REQUIRED', 'WRITE_REVISION_CONFLICT']);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function canonical(x){
 if(x===null||typeof x==='string'||typeof x==='boolean')return x;
 if(typeof x==='number'&&Number.isFinite(x))return x;
 if(Array.isArray(x))return ['array',x.map(canonical)];
 if(x&&Object.getPrototypeOf(x)===Object.prototype)return ['object',Object.keys(x).sort().map(k=>[k,canonical(x[k])])];
 throw Error('WRITE_INPUT_INVALID');
}
const digest=x=>hash(JSON.stringify(canonical(x)));
function createWriteIsolationAdapter(c){
 const {provider,verifyIdentity,verifyAppCheck,validatePayload,verifyRestore,clock=()=>Date.now(),sourceDatabaseUid,targetDatabaseUid,epoch,appId,leaseMs=5000}=c||{};
 if(typeof provider?.runTransaction!=='function'||[verifyIdentity,verifyAppCheck,validatePayload,clock].some(f=>typeof f!=='function')||!uid.test(sourceDatabaseUid||'')||!uid.test(targetDatabaseUid||'')||sourceDatabaseUid===targetDatabaseUid||!id.test(epoch||'')||typeof appId!=='string'||!appId||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>30000)throw Error('WRITE_ADAPTER_CONFIGURATION_REQUIRED');
 const time=()=>{const n=clock();if(!Number.isSafeInteger(n)||n<0)throw Error('WRITE_CLOCK_INVALID');return n;};
 async function identity(token,check){
  const [principal,app]=await Promise.all([verifyIdentity(token,{checkRevoked:true}),verifyAppCheck(check)]);
  const t=time();
  if(!principal||!id.test(principal.uid||'')||principal.revoked!==false||!Number.isSafeInteger(principal.authVersion)||!Number.isSafeInteger(principal.expiresAt)||principal.expiresAt<=t||app?.appId!==appId||!Number.isSafeInteger(app.expiresAt)||app.expiresAt<=t)throw Error('WRITE_AUTHORIZATION_REQUIRED');
  return {uid:principal.uid,authVersion:principal.authVersion,expiresAt:Math.min(principal.expiresAt,app.expiresAt)};
 }
 return Object.freeze({async execute(input){
  let active=true,timer;const started=time();
  const alive=()=>{const t=time();if(!active||t<started||t>=started+leaseMs)throw Error('WRITE_DEADLINE_EXPIRED');};
  const pending=(async()=>{try{
   const r=structuredClone(input||{});
   if(!operations.has(r.operation)||!id.test(r.requestId||'')||!id.test(r.recordId||'')||!id.test(r.traceId||'')||!Number.isSafeInteger(r.expectedRevision)||r.expectedRevision<0)throw Error('WRITE_INPUT_INVALID');
   const caller=await identity(r.idToken,r.appCheckToken);alive();
   const payload=r.operation==='delete'?null:await validatePayload(r.operation,structuredClone(r.payload));alive();
   if(r.operation!=='delete'&&(!payload||typeof payload!=='object'||Array.isArray(payload)))throw Error('WRITE_INPUT_INVALID');
   const fingerprint=digest({operation:r.operation,recordId:r.recordId,expectedRevision:r.expectedRevision,payload,owner:caller.uid,epoch,targetDatabaseUid});
   let deadlineMs=Math.min(started+leaseMs,caller.expiresAt);
   const transactionOptions={databaseUid:targetDatabaseUid,deadlineMs};
   let restore=null;
   async function readRestore(){
    if(typeof verifyRestore!=='function')throw Error('WRITE_RESTORE_EVIDENCE_REQUIRED');
    const proof=await verifyRestore(structuredClone(r.restoreEvidence),{targetDatabaseUid,epoch,recordId:r.recordId,requestId:r.requestId,operation:r.operation,expectedRevision:r.expectedRevision,payloadDigest:digest(payload)});alive();
    if(!proof||proof.authorizesOperation!==true||proof.historical!==false||proof.targetDatabaseUid!==targetDatabaseUid||proof.epoch!==epoch||proof.recordId!==r.recordId||proof.requestId!==r.requestId||proof.operation!==r.operation||proof.expectedRevision!==r.expectedRevision||proof.payloadDigest!==digest(payload)||!/^[a-f0-9]{64}$/.test(proof.checkpointDigest||'')||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=time())throw Error('WRITE_RESTORE_EVIDENCE_REQUIRED');
    return structuredClone(proof);
   }
   if(r.operation==='restore')restore=await readRestore();
   const result=await provider.runTransaction(async tx=>{
    alive();
    if(time()>=deadlineMs)throw Error('WRITE_DEADLINE_EXPIRED');
    const [control,principal,previous,record]=await Promise.all([tx.getControl(),tx.getPrincipal(caller.uid),tx.getRequest(r.requestId),tx.getRecord(r.recordId)]);
    if(control?.databaseUid!==targetDatabaseUid||control?.epoch!==epoch||control?.quarantined!==true||control?.publishAllowed!==false||!Number.isSafeInteger(control?.fencingToken)||control.fencingToken<1||!Number.isSafeInteger(control?.expiresAt)||control.expiresAt<=time()||!Array.isArray(control.allowedOperations)||!control.allowedOperations.includes(r.operation))throw Error('WRITE_FENCE_REQUIRED');
    deadlineMs=Math.min(deadlineMs,control.expiresAt,restore?.expiresAt??deadlineMs);transactionOptions.deadlineMs=deadlineMs;
    // Expired quarantine never auto-releases, nor permits takeover by a writer.
    if(principal?.enabled!==true||principal.authVersion!==caller.authVersion||!Array.isArray(principal.operations)||!principal.operations.includes(r.operation))throw Error('WRITE_AUTHORIZATION_REQUIRED');
    if(['update','restore','delete'].includes(r.operation)&&principal.admin!==true)throw Error('WRITE_ADMIN_REQUIRED');
    const fresh=await identity(r.idToken,r.appCheckToken);alive();
    if(fresh.uid!==caller.uid||fresh.authVersion!==caller.authVersion||time()>=deadlineMs)throw Error('WRITE_AUTHORIZATION_CHANGED');
    if(previous){
     if(previous.fingerprint!==fingerprint||previous.ownerHash!==hash(caller.uid)||previous.operation!==r.operation||previous.recordId!==r.recordId||previous.epoch!==epoch||previous.databaseUid!==targetDatabaseUid||previous.status!=='committed')throw Error('WRITE_IDEMPOTENCY_CONFLICT');
     // A receipt is acknowledgement only, never permission to serve restored data.
     return {status:'committed',revision:previous.revision,replayed:true,publishAllowed:false};
    }
    const revision=record?record.revision:0;
    if(!Number.isSafeInteger(revision)||revision<0||revision!==r.expectedRevision||revision===Number.MAX_SAFE_INTEGER)throw Error('WRITE_REVISION_CONFLICT');
    if(r.operation==='create'&&record)throw Error('WRITE_RECORD_EXISTS');
    if(r.operation!=='create'&&!record)throw Error('WRITE_RECORD_MISSING');
    if(record?.tombstone===true)throw Error('WRITE_RECORD_TOMBSTONED');
    if(r.operation==='restore'){
     const currentProof=await readRestore();
     if(control.checkpointDigest!==currentProof.checkpointDigest||currentProof.checkpointDigest!==restore.checkpointDigest||currentProof.expiresAt!==restore.expiresAt||time()>=deadlineMs)throw Error('WRITE_RESTORE_EVIDENCE_REQUIRED');
    }
    const nextRevision=revision+1;
    const next=r.operation==='delete'?{revision:nextRevision,tombstone:true}:{revision:nextRevision,tombstone:false,payload};
    // Atomic provider contract: no writes/audit escape if any of these fail.
    await tx.putRecord(r.recordId,structuredClone(next),{expectedRevision:revision,fencingToken:control.fencingToken});
    alive();await tx.createRequest(r.requestId,{status:'committed',fingerprint,ownerHash:hash(caller.uid),operation:r.operation,recordId:r.recordId,epoch,databaseUid:targetDatabaseUid,revision:nextRevision});
    alive();await tx.appendAudit({code:'WRITE_COMMITTED',traceId:r.traceId,requestHash:hash(r.requestId),actorHash:hash(caller.uid),operation:r.operation,fencingToken:control.fencingToken,at:time()});
    alive();return {status:'committed',revision:nextRevision,replayed:false,publishAllowed:false};
   },transactionOptions);
   alive();const final=await identity(r.idToken,r.appCheckToken);alive();
   if(final.uid!==caller.uid||final.authVersion!==caller.authVersion||time()>=deadlineMs)throw Error('WRITE_AUTHORIZATION_CHANGED');
   return result;
  }catch(e){
   // An uncertain commit remains uncertain; retry the same request ID to recover.
   const safe=errorCodes.has(e?.message)?e.message:'WRITE_PROVIDER_UNAVAILABLE';
   throw Error(safe);
  }})();
  try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Error('WRITE_DEADLINE_EXPIRED'));},leaseMs);})]);}
  finally{active=false;clearTimeout(timer);}
 }});
}
module.exports={createWriteIsolationAdapter,digest};
