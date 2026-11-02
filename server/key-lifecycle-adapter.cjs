'use strict';
// Preparation adapter; no cloud SDK, credentials, key creation/deletion or entrypoint.
// Trusted provider contract: registry.transact(fn) serializes ALL lifecycle/receipt
// writers durably and atomically (including audit), clones reads/results, rolls back
// callback exceptions, and never commits after callback failure. fn is synchronous.
// Public-key/receipt history must remain append-only outside these operations.
// kms.inspect/sign must authenticate to the requested key and enforce cloud IAM.
// Production IAM and these provider guarantees are NOT established by this module.
const crypto=require('node:crypto');
const KEY=/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9][0-9]*$/;
const ERROR_CODES=new Set(["KEY_ADAPTER_CONFIGURATION_REQUIRED", "KEY_ALREADY_REVOKED", "KEY_AUTHORIZATION_CHANGED", "KEY_AUTHORIZATION_REQUIRED", "KEY_CLOCK_INVALID", "KEY_CONTEXT_MISMATCH", "KEY_ENVELOPE_INVALID", "KEY_KMS_STATE_INVALID", "KEY_LIFECYCLE_CHANGED", "KEY_NOT_ACTIVE", "KEY_OPERATION_EXPIRED", "KEY_PROOF_REUSED", "KEY_PROVIDER_UNAVAILABLE", "KEY_PUBLIC_INVALID", "KEY_RECEIPT_REQUIRED", "KEY_RECORD_INVALID", "KEY_REGISTRY_INVALID", "KEY_REQUEST_REUSED", "KEY_REVISION_CONFLICT", "KEY_REVOCATION_INPUT_INVALID", "KEY_ROLE_MISMATCH", "KEY_ROTATION_INPUT_INVALID", "KEY_ROTATION_TARGET_INVALID", "KEY_RUNTIME_REJECTED", "KEY_SIGNATURE_INVALID", "KEY_SIGNER_MISMATCH", "KEY_SIGN_INPUT_INVALID"]);
const ID=/^[A-Za-z0-9_-]{16,100}$/;
const HEX=/^[a-f0-9]{64}$/;
const PURPOSES={control:['fence','checkpoint'],validator:['validation'],issuer:['attestation']};
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function publicKey(pem){try{const k=crypto.createPublicKey(pem);if(k.asymmetricKeyType!=='ed25519')throw Error();return k;}catch{throw Error('KEY_PUBLIC_INVALID');}}
function fingerprint(pem){return digest(publicKey(pem).export({format:'der',type:'spki'}));}
function bytes(e){return Buffer.from(JSON.stringify(['okclean-key-envelope-v1',e.keyId,e.role,e.purpose,e.contextHash,e.payloadHash,e.requestId,e.issuedAt,e.expiresAt]));}
function envelopeDigest(e){return digest(Buffer.concat([bytes(e),Buffer.from(e.signature||'','base64url')]));}
function record(k,id){
 if(!k||k.keyId!==id||!KEY.test(id)||!PURPOSES[k.role]||!['staged','active','retired','revoked'].includes(k.status)||typeof k.serviceAccount!=='string'||!/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(k.serviceAccount)||!Number.isSafeInteger(k.notBefore)||!Number.isSafeInteger(k.expiresAt)||k.notBefore<0||k.expiresAt<=k.notBefore||!HEX.test(k.publicKeySha256||'')||fingerprint(k.publicKey)!==k.publicKeySha256)throw Error('KEY_RECORD_INVALID');
 return k;
}
function state(s){if(!s||!Number.isSafeInteger(s.revision)||s.revision<0||!s.keys||!s.active||!s.receipts||!Array.isArray(s.audit))throw Error('KEY_REGISTRY_INVALID');}
function createKeyLifecycleAdapter({registry,kms,authorize,clock=()=>Date.now(),timeoutMs=5000,maxLifetimeMs=600000}={}){
 if(typeof registry?.transact!=='function'||typeof kms?.inspect!=='function'||typeof kms?.sign!=='function'||typeof authorize!=='function'||typeof clock!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(maxLifetimeMs)||maxLifetimeMs<1||maxLifetimeMs>600000)throw Error('KEY_ADAPTER_CONFIGURATION_REQUIRED');
 const time=()=>{const t=clock();if(!Number.isSafeInteger(t)||t<0)throw Error('KEY_CLOCK_INVALID');return t;};
 async function bounded(work){let active=true,timer;const start=time(),deadline=start+timeoutMs;
  const alive=()=>{const t=time();if(!active||t<start||t>=deadline)throw Error('KEY_OPERATION_EXPIRED');return t;};
  try{return await Promise.race([Promise.resolve().then(()=>work(alive)),new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Error('KEY_OPERATION_EXPIRED'));},timeoutMs);})]);}
  catch(e){if(ERROR_CODES.has(e?.message))throw Error(e.message);throw Error('KEY_PROVIDER_UNAVAILABLE');}
  finally{active=false;clearTimeout(timer);}
 }
 async function identity(token,action,role,keyId,alive){const a=await authorize({token,action,role,keyId});alive();if(a?.action!==action||a?.role!==role||a?.keyId!==keyId||a?.authenticated!==true||typeof a.principal!=='string'||!a.principal||a.principal.length>256)throw Error('KEY_AUTHORIZATION_REQUIRED');return a.principal;}
 async function metadata(k,alive){const m=await kms.inspect(k.keyId);alive();if(m?.keyId!==k.keyId||m?.state!=='ENABLED'||m?.algorithm!=='EC_SIGN_ED25519'||m?.publicKeySha256!==k.publicKeySha256)throw Error('KEY_KMS_STATE_INVALID');}
 function audit(s,code,traceId,keyId,principal,at){s.audit.push({code,traceId,keyHash:digest(keyId),principalHash:digest(principal),at});}
 function current(s,role,keyId,t){state(s);const k=record(s.keys[keyId],keyId);if(k.role!==role||s.active[role]!==keyId||k.status!=='active'||t<k.notBefore||t>=k.expiresAt)throw Error('KEY_NOT_ACTIVE');return k;}
 function envelope(e){if(!e||!KEY.test(e.keyId||'')||!PURPOSES[e.role]?.includes(e.purpose)||!HEX.test(e.contextHash||'')||!HEX.test(e.payloadHash||'')||!ID.test(e.requestId||'')||!Number.isSafeInteger(e.issuedAt)||!Number.isSafeInteger(e.expiresAt)||e.issuedAt<0||e.expiresAt<=e.issuedAt||e.expiresAt-e.issuedAt>maxLifetimeMs||typeof e.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(e.signature))throw Error('KEY_ENVELOPE_INVALID');}
 return Object.freeze({
  async sign({token,role,purpose,keyId,requestId,contextHash,payload,lifetimeMs=30000}={}){return bounded(async alive=>{
   if(!KEY.test(keyId||'')||!PURPOSES[role]?.includes(purpose)||!ID.test(requestId||'')||!HEX.test(contextHash||'')||!Buffer.isBuffer(payload)||payload.length>1048576||!Number.isSafeInteger(lifetimeMs)||lifetimeMs<1||lifetimeMs>maxLifetimeMs)throw Error('KEY_SIGN_INPUT_INVALID');
   // Copy caller-owned bytes before awaiting to avoid mutable-input races.
   const payloadHash=digest(Buffer.from(payload)),principal=await identity(token,'sign',role,keyId,alive);
   const snap=await registry.transact(s=>{const k=current(s,role,keyId,alive());if(principal!==k.serviceAccount)throw Error('KEY_SIGNER_MISMATCH');if(s.receipts[requestId])throw Error('KEY_REQUEST_REUSED');return {key:{...k},revision:s.revision};});alive();
   await metadata(snap.key,alive);
   const issuedAt=alive(),expiresAt=Math.min(issuedAt+lifetimeMs,snap.key.expiresAt),e={keyId,role,purpose,contextHash,payloadHash,requestId,issuedAt,expiresAt};
   if(expiresAt<=issuedAt)throw Error('KEY_NOT_ACTIVE');
   const signature=await kms.sign({keyId,serviceAccount:principal,data:bytes(e)});alive();
   if(!Buffer.isBuffer(signature)||signature.length!==64||!crypto.verify(null,bytes(e),publicKey(snap.key.publicKey),signature))throw Error('KEY_SIGNATURE_INVALID');
   e.signature=signature.toString('base64url');
   // No signature is returned or accepted without a durable issuance receipt.
   // Rotation/revocation between the KMS call and this transaction invalidates it.
   await metadata(snap.key,alive);
   if(await identity(token,'sign',role,keyId,alive)!==principal)throw Error('KEY_AUTHORIZATION_CHANGED');
   await registry.transact(s=>{const t=alive(),k=current(s,role,keyId,t);if(s.revision!==snap.revision||k.publicKeySha256!==snap.key.publicKeySha256||k.serviceAccount!==principal||t>=expiresAt)throw Error('KEY_LIFECYCLE_CHANGED');if(s.receipts[requestId])throw Error('KEY_REQUEST_REUSED');s.receipts[requestId]={digest:envelopeDigest(e),keyId,issuedAt,consumed:false};audit(s,'key_signed',requestId,keyId,principal,t);});alive();return e;
  });},
  async verify({envelope:e,role,purpose,contextHash,payload,historical=false,consume=true}={}){return bounded(async alive=>{
   envelope(e);if(typeof historical!=='boolean'||typeof consume!=='boolean'||role!==e.role||purpose!==e.purpose||contextHash!==e.contextHash||!Buffer.isBuffer(payload)||payload.length>1048576||digest(Buffer.from(payload))!==e.payloadHash)throw Error('KEY_CONTEXT_MISMATCH');
   const copy={...e},snap=await registry.transact(s=>{state(s);const k=record(s.keys[copy.keyId],copy.keyId);return {key:{...k},revision:s.revision};});alive();
   if(snap.key.role!==role||copy.issuedAt<snap.key.notBefore||copy.expiresAt>snap.key.expiresAt||!crypto.verify(null,bytes(copy),publicKey(snap.key.publicKey),Buffer.from(copy.signature,'base64url')))throw Error('KEY_SIGNATURE_INVALID');
   if(!historical)await metadata(snap.key,alive);
   return registry.transact(s=>{state(s);const t=alive(),k=record(s.keys[copy.keyId],copy.keyId),r=s.receipts[copy.requestId];
    if(s.revision!==snap.revision||k.publicKeySha256!==snap.key.publicKeySha256)throw Error('KEY_LIFECYCLE_CHANGED');
    if(!r||r.keyId!==copy.keyId||r.issuedAt!==copy.issuedAt||r.digest!==envelopeDigest(copy))throw Error('KEY_RECEIPT_REQUIRED');
    // Historical proof only asserts an archived, previously issued signature.
    // It never authorizes restoration, mutation or renewed proof issuance.
    if(historical)return {valid:true,historical:true,authorizesOperation:false};
    const accepted=k.status==='active'&&s.active[role]===copy.keyId||k.status==='retired'&&Number.isSafeInteger(k.runtimeVerifyUntil)&&t<k.runtimeVerifyUntil;
    if(!accepted||t<copy.issuedAt||t>=copy.expiresAt||t<k.notBefore||t>=k.expiresAt)throw Error('KEY_RUNTIME_REJECTED');
    if(r.consumed!==false)throw Error('KEY_PROOF_REUSED');if(!consume)return {valid:true,historical:false,currentKeyValid:true,authorizesOperation:false};r.consumed=true;audit(s,'key_proof_consumed',copy.requestId,copy.keyId,'verifier',t);return {valid:true,historical:false,authorizesOperation:true};
   });
  });},
  async rotate({token,role,nextKeyId,expectedRevision,traceId,previousVerifyUntil}={}){return bounded(async alive=>{
   if(!PURPOSES[role]||!KEY.test(nextKeyId||'')||!ID.test(traceId||'')||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Number.isSafeInteger(previousVerifyUntil))throw Error('KEY_ROTATION_INPUT_INVALID');
   const principal=await identity(token,'rotate',role,nextKeyId,alive);
   const next=await registry.transact(s=>{state(s);if(s.revision!==expectedRevision)throw Error('KEY_REVISION_CONFLICT');return {...record(s.keys[nextKeyId],nextKeyId)};});alive();
   if(next.role!==role||next.status!=='staged')throw Error('KEY_ROTATION_TARGET_INVALID');await metadata(next,alive);
   if(await identity(token,'rotate',role,nextKeyId,alive)!==principal)throw Error('KEY_AUTHORIZATION_CHANGED');
   return registry.transact(s=>{state(s);const t=alive();if(s.revision!==expectedRevision)throw Error('KEY_REVISION_CONFLICT');const k=record(s.keys[nextKeyId],nextKeyId),old=s.active[role]?record(s.keys[s.active[role]],s.active[role]):null;
    if(k.role!==role||k.status!=='staged'||k.publicKeySha256!==next.publicKeySha256||Object.values(s.keys).some(other=>other.keyId!==nextKeyId&&other.publicKeySha256===k.publicKeySha256)||t<k.notBefore||t>=k.expiresAt||previousVerifyUntil<t||previousVerifyUntil>t&&(!old||old.role!==role||old.status!=='active'||previousVerifyUntil>Math.min(old.expiresAt,t+maxLifetimeMs)))throw Error('KEY_ROTATION_TARGET_INVALID');
    if(old){if(old.role!==role||old.status!=='active')throw Error('KEY_ROTATION_TARGET_INVALID');old.status='retired';old.runtimeVerifyUntil=previousVerifyUntil;}k.status='active';s.active[role]=nextKeyId;s.revision++;audit(s,'key_rotated',traceId,nextKeyId,principal,t);return {revision:s.revision,activeKeyId:nextKeyId};
   });
  });},
  async revoke({token,role,keyId,expectedRevision,traceId}={}){return bounded(async alive=>{
   if(!PURPOSES[role]||!KEY.test(keyId||'')||!ID.test(traceId||'')||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('KEY_REVOCATION_INPUT_INVALID');
   const principal=await identity(token,'revoke',role,keyId,alive);
   return registry.transact(s=>{state(s);const t=alive();if(s.revision!==expectedRevision)throw Error('KEY_REVISION_CONFLICT');const k=record(s.keys[keyId],keyId);if(k.role!==role)throw Error('KEY_ROLE_MISMATCH');if(k.status==='revoked')throw Error('KEY_ALREADY_REVOKED');k.status='revoked';k.revokedAt=t;k.runtimeVerifyUntil=0;if(s.active[role]===keyId)delete s.active[role];s.revision++;audit(s,'key_revoked',traceId,keyId,principal,t);return {revision:s.revision,revoked:true};
   });
  });}
 });
}
module.exports={createKeyLifecycleAdapter,fingerprint,envelopeBytes:bytes};
