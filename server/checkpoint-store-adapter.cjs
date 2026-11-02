'use strict';
// Provider-neutral preparation adapter. The trusted provider must atomically commit
// create-only records + an independently protected monotonic anchor + audit rows.
// This module supplies no cloud provider and cannot establish WORM/IAM by itself.
const crypto=require('node:crypto');
const {checkpointMessage}=require('./independent-restore-verifier.cjs');
const SAFE_CODES=new Set(["CHECKPOINT_ANCHOR_MISMATCH", "CHECKPOINT_APPEND_CONFLICT", "CHECKPOINT_CHAIN_INCOMPLETE", "CHECKPOINT_CHAIN_INVALID", "CHECKPOINT_CLOCK_INVALID", "CHECKPOINT_CONFIGURATION_REQUIRED", "CHECKPOINT_EVIDENCE_EXPIRED", "CHECKPOINT_EVIDENCE_INVALID", "CHECKPOINT_EXPECTED_ANCHOR_REQUIRED", "CHECKPOINT_EXTERNAL_ANCHOR_MISMATCH", "CHECKPOINT_FORBIDDEN", "CHECKPOINT_IDEMPOTENCY_CONFLICT", "CHECKPOINT_IDENTITY_CHANGED", "CHECKPOINT_KEYS_REQUIRED", "CHECKPOINT_KEY_AUTHORIZATION_REQUIRED", "CHECKPOINT_PROVIDER_INVALID", "CHECKPOINT_RECORD_INVALID", "CHECKPOINT_SIGNATURE_INVALID", "CHECKPOINT_STORAGE_UNAVAILABLE", "CHECKPOINT_TIMEOUT"]);
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9_-]{16,80}$/;
const KEY=/^(?:[A-Za-z0-9_-]{16,80}|projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9][0-9]*)$/;
const ZERO='0'.repeat(64);
const fields=['sourceProject','ledgerProject','restoreId','servedDatabaseId','servedDatabaseUid','fenceId'];
const exact=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const evidenceFields=[...fields,'issuedAt','expiresAt','checkpoint','ledgerRevision','recordCount','state','signature'];
const envelopeFields=['id','sequence','previousHash','evidence','retentionUntil','legalHold','keyId','signature','keyProof'];
function checkpointStorageMessage(v){return Buffer.from(JSON.stringify(['okclean-checkpoint-storage-v1',v.id,v.sequence,v.previousHash,checkpointMessage(v.evidence).toString('base64'),v.evidence.signature,v.retentionUntil,v.legalHold,v.keyId]));}
function checkpointStorageHash(v){return crypto.createHash('sha256').update(checkpointStorageMessage(v)).update('\0').update(v.signature).update('\0').update(JSON.stringify(v.keyProof)).digest('hex');}
function createCheckpointStoreAdapter({provider,authorize,verifyEvidence,publicKeys,binding,now=()=>Date.now(),timeoutMs=5000,maxRecords=10000}={}){
 if(!provider||typeof provider.transaction!=='function'||typeof authorize!=='function'||typeof verifyEvidence!=='function'||typeof now!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>10000||!exact(binding,fields)||!ID.test(binding.restoreId)||!ID.test(binding.fenceId)||binding.sourceProject===binding.ledgerProject||![binding.sourceProject,binding.ledgerProject].every(x=>/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(x||''))||!/^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/.test(binding.servedDatabaseId)||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(binding.servedDatabaseUid))throw Error('CHECKPOINT_CONFIGURATION_REQUIRED');
 const scope=Object.freeze({...binding});const keys=new Map();
 try{for(const [id,pem] of Object.entries(publicKeys||{})){if(!KEY.test(id))throw Error();const key=crypto.createPublicKey(pem);if(key.asymmetricKeyType!=='ed25519')throw Error();keys.set(id,key);}if(!keys.size)throw Error();}catch{throw Error('CHECKPOINT_KEYS_REQUIRED');}
 function validate(v,live,t){
  if(!exact(v,envelopeFields)||!exact(v.evidence,evidenceFields)||!ID.test(v.id)||!Number.isSafeInteger(v.sequence)||v.sequence<1||!HASH.test(v.previousHash)||!Number.isSafeInteger(v.retentionUntil)||typeof v.legalHold!=='boolean'||!keys.has(v.keyId)||!/^[A-Za-z0-9_-]{86}$/.test(v.signature||''))throw Error('CHECKPOINT_RECORD_INVALID');
  const e=v.evidence;
  if(!fields.every(k=>e[k]===scope[k])||e.state!=='immutable-complete'||!HASH.test(e.checkpoint||'')||!Number.isSafeInteger(e.ledgerRevision)||e.ledgerRevision<0||!Number.isSafeInteger(e.recordCount)||e.recordCount<0||e.recordCount>100000||!Number.isSafeInteger(e.issuedAt)||!Number.isSafeInteger(e.expiresAt)||e.expiresAt<=e.issuedAt||e.expiresAt-e.issuedAt>600000||v.retentionUntil<e.expiresAt||!/^[A-Za-z0-9_-]{86}$/.test(e.signature||''))throw Error('CHECKPOINT_EVIDENCE_INVALID');
  if(live&&(e.issuedAt>t||e.expiresAt<=t||v.retentionUntil<=t))throw Error('CHECKPOINT_EVIDENCE_EXPIRED');
  const key=keys.get(v.keyId);
  if(!crypto.verify(null,checkpointMessage(e),key,Buffer.from(e.signature,'base64url'))||!crypto.verify(null,checkpointStorageMessage(v),key,Buffer.from(v.signature,'base64url')))throw Error('CHECKPOINT_SIGNATURE_INVALID');
 }
 async function attest(v,historical){
  const result=await verifyEvidence({proof:structuredClone(v.keyProof),keyId:v.keyId,payload:checkpointStorageMessage(v),historical});
  if(result?.verified!==true||result.keyId!==v.keyId||result.historicalOnly!==historical)throw Error('CHECKPOINT_KEY_AUTHORIZATION_REQUIRED');
 }
 async function chain(snapshot,t){
  if(!exact(snapshot,['records','anchor'])||!Array.isArray(snapshot.records)||snapshot.records.length>maxRecords||!exact(snapshot.anchor,['sequence','hash'])||snapshot.anchor.sequence!==snapshot.records.length)throw Error('CHECKPOINT_CHAIN_INCOMPLETE');
  let hash=ZERO,retention=0,hold=false,revision=-1;const ids=new Set();
  for(const [i,v] of snapshot.records.entries()){validate(v,false,t);await attest(v,true);if(v.sequence!==i+1||v.previousHash!==hash||ids.has(v.id)||v.retentionUntil<retention||(hold&&!v.legalHold)||v.evidence.ledgerRevision<revision)throw Error('CHECKPOINT_CHAIN_INVALID');ids.add(v.id);hash=checkpointStorageHash(v);retention=v.retentionUntil;hold=v.legalHold;revision=v.evidence.ledgerRevision;}
  if(snapshot.anchor.hash!==hash)throw Error('CHECKPOINT_ANCHOR_MISMATCH');
  return {hash,retention,hold,revision};
 }
 async function operation(token,fn){
  let active=true,timer;const started=now();if(!Number.isSafeInteger(started))throw Error('CHECKPOINT_CLOCK_INVALID');const deadline=started+timeoutMs;
  const alive=()=>{const t=now();if(!active||!Number.isSafeInteger(t)||t<started||t>=deadline)throw Error('CHECKPOINT_TIMEOUT');return t;};
  async function caller(){const p=await authorize(token);alive();if(!p||typeof p.uid!=='string'||!p.uid||p.checkpointAdmin!==true)throw Error('CHECKPOINT_FORBIDDEN');return crypto.createHash('sha256').update(p.uid).digest('hex');}
  const work=(async()=>{const owner=await caller();const value=await provider.transaction(async tx=>{alive();if(!tx||typeof tx.readSnapshot!=='function'||typeof tx.appendAndAnchor!=='function')throw Error('CHECKPOINT_PROVIDER_INVALID');if(await caller()!==owner)throw Error('CHECKPOINT_IDENTITY_CHANGED');const s=await tx.readSnapshot(scope);const state=await chain(s,alive());const result=await fn(tx,s,state,owner,alive);alive();return result;},{scope,deadline});alive();return value;})();
  try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Error('CHECKPOINT_TIMEOUT'));},timeoutMs);})]);}catch(e){if(SAFE_CODES.has(e?.message))throw e;throw Error('CHECKPOINT_STORAGE_UNAVAILABLE');}finally{active=false;clearTimeout(timer);}
 }
 return Object.freeze({
  async append({token,record}={}){
   // Snapshot request before asynchronous callbacks to avoid caller mutation.
   let candidate;try{candidate=structuredClone(record);}catch{throw Error('CHECKPOINT_RECORD_INVALID');}
   return operation(token,async(tx,s,state,owner,alive)=>{
    validate(candidate,false,alive());await attest(candidate,true);alive();const hash=checkpointStorageHash(candidate),old=s.records.find(v=>v.id===candidate.id);
    if(old){if(checkpointStorageHash(old)!==hash)throw Error('CHECKPOINT_IDEMPOTENCY_CONFLICT');return {sequence:old.sequence,hash,replayed:true,publishAllowed:false};}
    validate(candidate,true,alive());
    if(s.records.length>=maxRecords||candidate.sequence!==s.records.length+1||candidate.previousHash!==state.hash||candidate.retentionUntil<state.retention||(state.hold&&!candidate.legalHold)||candidate.evidence.ledgerRevision<state.revision)throw Error('CHECKPOINT_APPEND_CONFLICT');
    const expectedAnchor={...s.anchor},anchor={sequence:candidate.sequence,hash};
    await attest(candidate,false);alive();
    await tx.appendAndAnchor({scope,record:candidate,expectedAnchor,anchor,audit:{code:'CHECKPOINT_APPENDED',traceId:candidate.id,actorHash:owner,recordHash:hash,at:alive()}});alive();await attest(candidate,false);alive();
    return {sequence:candidate.sequence,hash,replayed:false,publishAllowed:false};
   });
  },
  async inspect({token,expectedAnchor}={}){
   if(!exact(expectedAnchor,['sequence','hash'])||!Number.isSafeInteger(expectedAnchor.sequence)||expectedAnchor.sequence<0||!HASH.test(expectedAnchor.hash||''))throw Error('CHECKPOINT_EXPECTED_ANCHOR_REQUIRED');
   const expected={...expectedAnchor};
   return operation(token,async(tx,s)=>{if(s.anchor.sequence!==expected.sequence||s.anchor.hash!==expected.hash)throw Error('CHECKPOINT_EXTERNAL_ANCHOR_MISMATCH');return {anchor:{...s.anchor},records:structuredClone(s.records),historicalOnly:true,publishAllowed:false};});
  }
 });
}
module.exports={createCheckpointStoreAdapter,checkpointStorageMessage,checkpointStorageHash};
