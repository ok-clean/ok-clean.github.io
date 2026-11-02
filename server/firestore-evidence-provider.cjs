'use strict';
// Firebase Admin Firestore SDK provider. No SDK initialization or credential IO.
// Reads precede every SDK write; Firestore owns retry/commit atomicity.
// Firestore is NOT WORM and cannot atomically commit with GCS/KMS/other databases.
// Production writes are hard-denied in this preparation version.
// https://firebase.google.com/docs/firestore/manage-data/transactions
const crypto=require('node:crypto');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const clone=structuredClone;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const scopeFields=['sourceProject','ledgerProject','restoreId','servedDatabaseId','servedDatabaseUid','fenceId'];
const scopeHash=s=>hash(JSON.stringify(scopeFields.map(k=>s?.[k])));
const ZERO='0'.repeat(64);
function configuration(c){
 const {db,projectId,databaseId,writeGate,env=process.env,clock=Date.now}=c||{};
 if(typeof db?.runTransaction!=='function'||typeof db?.collection!=='function'||db.projectId!==projectId||db.databaseId!==databaseId||!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId||'')||!/^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/.test(databaseId||'')||typeof clock!=='function'||(writeGate!==undefined&&typeof writeGate!=='function'))throw Error('EVIDENCE_PROVIDER_CONFIGURATION');
 const runtime={...env};
 function deadline(limit){const t=clock();if(!Number.isSafeInteger(t)||!Number.isSafeInteger(limit)||t>=limit)throw Error('EVIDENCE_PROVIDER_DEADLINE');return t;}
 async function allow(operation,limit){
  deadline(limit);
  if(!/^demo-[a-z0-9-]+$/.test(projectId)||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(runtime.FIRESTORE_EMULATOR_HOST||'')||runtime.GCLOUD_PROJECT!==projectId||typeof writeGate!=='function')throw Error('EVIDENCE_PROVIDER_WRITES_BLOCKED');
  const port=Number(runtime.FIRESTORE_EMULATOR_HOST.split(':')[1]);if(port>65535||(db?._settings?.host!==runtime.FIRESTORE_EMULATOR_HOST&&!(db?._settings?.servicePath==='127.0.0.1'&&db?._settings?.port===port))||db?._settings?.ssl!==false)throw Error('EVIDENCE_PROVIDER_WRITES_BLOCKED');
  const gate=await writeGate({operation,projectId,databaseId,mode:'emulator'});deadline(limit);
  if(gate?.allowed!==true||gate.mode!=='emulator'||gate.projectId!==projectId||gate.databaseId!==databaseId)throw Error('EVIDENCE_PROVIDER_WRITES_BLOCKED');
 }
 return {db,projectId,databaseId,deadline,allow,clock};
}
function boundedJson(value,maxBytes=700000){let raw;try{raw=JSON.stringify(value);}catch{throw Error('EVIDENCE_PROVIDER_DATA_INVALID');}if(typeof raw!=='string'||Buffer.byteLength(raw)>maxBytes||/-----BEGIN [^-]*PRIVATE KEY-----|"(?:private_key|access_token|refresh_token|client_secret|password)"\s*:/i.test(raw))throw Error('EVIDENCE_PROVIDER_DATA_INVALID');return raw;}
function unchangedHistory(before,after){
 if(!before||!after||!Number.isSafeInteger(after.revision)||after.revision<before.revision||after.revision>before.revision+1||!after.keys||!after.receipts||!Array.isArray(after.audit)||after.audit.length<before.audit.length||!same(after.audit.slice(0,before.audit.length),before.audit))throw Error('EVIDENCE_PROVIDER_HISTORY_CHANGED');
 for(const [id,key] of Object.entries(before.keys||{})){const next=after.keys[id];if(!next||!['keyId','role','serviceAccount','notBefore','expiresAt','publicKey','publicKeySha256'].every(k=>same(key[k],next[k])))throw Error('EVIDENCE_PROVIDER_HISTORY_CHANGED');}
 for(const [id,r] of Object.entries(before.receipts||{})){const next=after.receipts[id];if(!next||!['digest','keyId','issuedAt'].every(k=>same(r[k],next[k]))||(r.consumed===true&&next.consumed!==true)||typeof next.consumed!=='boolean')throw Error('EVIDENCE_PROVIDER_HISTORY_CHANGED');}
}
function createFirestoreKeyRegistry(c={}){
 const {db,deadline,allow,clock}=configuration(c);const registryId=c.registryId;
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(registryId||''))throw Error('EVIDENCE_PROVIDER_CONFIGURATION');
 const ref=db.collection('operations_key_registry').doc(registryId),audits=db.collection('operations_key_audit');
 return Object.freeze({async transact(fn){
  if(typeof fn!=='function')throw Error('EVIDENCE_PROVIDER_CALLBACK');const limit=clock()+5000;let callbackError;
  try{const committed=await db.runTransaction(async tx=>{
   deadline(limit);const snap=await tx.get(ref);deadline(limit);if(!snap.exists)throw Error('EVIDENCE_PROVIDER_NOT_PROVISIONED');
   const stored=snap.data();if(!Number.isSafeInteger(stored?.version)||stored.version<0||!stored.state||!Array.isArray(stored.state.audit))throw Error('EVIDENCE_PROVIDER_DATA_INVALID');
   const before=clone(stored.state),working=clone(before);let result;
   try{result=fn(working);if(result&&typeof result.then==='function')throw Error('EVIDENCE_PROVIDER_ASYNC_CALLBACK');}catch(e){callbackError=e;throw e;}
   deadline(limit);boundedJson(working);unchangedHistory(before,working);
   if(!same(before,working)){
    if(working.audit.length-before.audit.length>100)throw Error('EVIDENCE_PROVIDER_LIMIT');await allow('key-registry',limit);
    // All reads/callback/KMS eligibility checks above finish before SDK writes.
    tx.update(ref,{version:stored.version+1,state:working});
    for(let i=before.audit.length;i<working.audit.length;i++)tx.create(audits.doc(hash(registryId)+'_'+String(i).padStart(10,'0')),{registryId,index:i,event:working.audit[i]});
   }
   deadline(limit);return clone(result);
  },{maxAttempts:3});deadline(limit);return committed;}catch(e){if(e===callbackError)throw e;throw Error('EVIDENCE_PROVIDER_FAILURE');}
 }});
}
function createFirestoreCheckpointProvider(c={}){
 const {db,deadline,allow}=configuration(c);const maxRecords=c.maxRecords??1000;
 if(!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>10000)throw Error('EVIDENCE_PROVIDER_CONFIGURATION');
 return Object.freeze({async transaction(fn,{scope,deadline:limit}={}){
  if(typeof fn!=='function'||!scope||!scopeFields.every(k=>typeof scope[k]==='string'&&scope[k]))throw Error('EVIDENCE_PROVIDER_CONFIGURATION');
  const scopeId=scopeHash(scope),head=db.collection('operations_checkpoint_heads').doc(scopeId),records=db.collection('operations_checkpoint_records'),audits=db.collection('operations_checkpoint_audit');let callbackError;
  try{const committed=await db.runTransaction(async tx=>{
   deadline(limit);let cached=null,pending=null;
   const result=await fn({
    async readSnapshot(requestScope){
     if(scopeHash(requestScope)!==scopeId)throw Error('EVIDENCE_PROVIDER_SCOPE');if(cached)return clone(cached);
     const [h,rows]=await Promise.all([tx.get(head),tx.get(records.where('scopeHash','==',scopeId).orderBy('sequence').limit(maxRecords+1))]);deadline(limit);
     if(!h.exists)throw Error('EVIDENCE_PROVIDER_NOT_PROVISIONED');const data=h.data();
     if(!same(data.scope,scope)||!Number.isSafeInteger(data.sequence)||data.sequence<0||! /^[a-f0-9]{64}$/.test(data.hash||'')||rows.docs.length>maxRecords||rows.docs.length!==data.sequence)throw Error('EVIDENCE_PROVIDER_DATA_INVALID');
     const values=rows.docs.map((d,i)=>{const x=d.data();if(x.scopeHash!==scopeId||x.sequence!==i+1||x.record?.sequence!==i+1||d.id!==scopeId+'_'+String(i+1).padStart(10,'0'))throw Error('EVIDENCE_PROVIDER_DATA_INVALID');return clone(x.record);});
     if(!values.length&&data.hash!==ZERO)throw Error('EVIDENCE_PROVIDER_DATA_INVALID');
     cached={records:values,anchor:{sequence:data.sequence,hash:data.hash}};return clone(cached);
    },
    async appendAndAnchor(value){
     if(!cached||pending||scopeHash(value?.scope)!==scopeId||!same(value.expectedAnchor,cached.anchor)||value.anchor?.sequence!==cached.anchor.sequence+1||value.record?.sequence!==value.anchor.sequence||! /^[a-f0-9]{64}$/.test(value.anchor.hash||'')||value.record.previousHash!==cached.anchor.hash||value.audit?.recordHash!==value.anchor.hash)throw Error('EVIDENCE_PROVIDER_APPEND_CONFLICT');
     boundedJson(value.record);boundedJson(value.audit,4096);pending=clone(value);
    }
   }).catch(e=>{callbackError=e;throw e;});deadline(limit);
   if(pending){await allow('checkpoint-append',limit);const n=pending.anchor.sequence,id=scopeId+'_'+String(n).padStart(10,'0');tx.create(records.doc(id),{scopeHash:scopeId,sequence:n,record:pending.record});tx.update(head,{sequence:n,hash:pending.anchor.hash});tx.create(audits.doc(id),{scopeHash:scopeId,sequence:n,event:pending.audit});}
   deadline(limit);return clone(result);
  },{maxAttempts:3});deadline(limit);return committed;}catch(e){if(e===callbackError)throw e;throw Error('EVIDENCE_PROVIDER_FAILURE');}
 }});
}
module.exports={createFirestoreKeyRegistry,createFirestoreCheckpointProvider,checkpointScopeHash:scopeHash};
