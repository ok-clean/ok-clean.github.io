'use strict';
// SDK-backed preparation provider. Production is deliberately NOT enabled.
// Firebase transactions retry their callback and require all reads before writes:
// https://firebase.google.com/docs/firestore/manage-data/transactions
// Firestore does NOT enforce our wall-clock deadline at server commit. We check
// before staging and after acknowledgement; a late/lost acknowledgement is
// uncertain, remains quarantined and must be recovered by the same request ID.
// Consequently this provider does NOT fully satisfy the v4 production deadline
// contract. An independently verified external writer fence is still required.
const crypto=require('node:crypto');
const ID=/^[A-Za-z0-9_-]{1,80}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATABASE=/^(?:\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/;
const HASH=/^[a-f0-9]{64}$/;
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const clone=x=>structuredClone(x);
const errors=new Set(['FIRESTORE_WRITE_CONFIGURATION_REQUIRED','FIRESTORE_WRITE_DISABLED','FIRESTORE_WRITE_IDENTITY_MISMATCH','FIRESTORE_WRITE_DEADLINE_EXPIRED','FIRESTORE_WRITE_READ_ORDER_INVALID','FIRESTORE_WRITE_STAGE_INVALID','FIRESTORE_WRITE_FENCE_REQUIRED','FIRESTORE_WRITE_AUTHORITY_REQUIRED','FIRESTORE_WRITE_COMMIT_UNCERTAIN','WRITE_ADMIN_REQUIRED','WRITE_AUTHORIZATION_CHANGED','WRITE_AUTHORIZATION_REQUIRED','WRITE_CLOCK_INVALID','WRITE_DEADLINE_EXPIRED','WRITE_FENCE_REQUIRED','WRITE_IDEMPOTENCY_CONFLICT','WRITE_INPUT_INVALID','WRITE_RECORD_EXISTS','WRITE_RECORD_MISSING','WRITE_RECORD_TOMBSTONED','WRITE_RESTORE_EVIDENCE_REQUIRED','WRITE_REVISION_CONFLICT']);
function createFirestoreWriteProvider(c={}){
 const {db,resolveDbIdentity,sourceDatabaseId,targetDatabaseId,sourceDatabaseUid,targetDatabaseUid,projectId,epoch,namespace='prepared-reservations',executionMode='disabled',clock=()=>Date.now(),timeoutMs=10000}=c;
 // No environment/config boolean can turn this implementation into a production writer.
 if(executionMode!=='emulator')return Object.freeze({productionReady:false,runTransaction:async()=>{throw Error('FIRESTORE_WRITE_DISABLED');}});
 function emulator(){return /^demo-[a-z0-9-]+$/.test(projectId||'')&&process.env.GCLOUD_PROJECT===projectId&&process.env.FIRESTORE_EMULATOR_HOST==='127.0.0.1:8085'&&(db?._settings?.host==='127.0.0.1:8085'||(db?._settings?.servicePath==='127.0.0.1'&&db?._settings?.port===8085))&&db?._settings?.ssl===false;}
 if(!emulator()||db?.projectId!==projectId||db?.databaseId!==targetDatabaseId||typeof db?.collection!=='function'||typeof db?.runTransaction!=='function'||typeof resolveDbIdentity!=='function'||typeof clock!=='function'||!DATABASE.test(sourceDatabaseId||'')||!DATABASE.test(targetDatabaseId||'')||sourceDatabaseId===targetDatabaseId||!UUID.test(sourceDatabaseUid||'')||!UUID.test(targetDatabaseUid||'')||sourceDatabaseUid===targetDatabaseUid||!ID.test(epoch||'')||!ID.test(namespace)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('FIRESTORE_WRITE_CONFIGURATION_REQUIRED');
 const root=db.collection('write_isolation').doc(namespace);
 const ref=(kind,name)=>{if(!ID.test(name||''))throw Error('FIRESTORE_WRITE_STAGE_INVALID');return root.collection(kind).doc(name);};
 async function identity(){
  const values=await Promise.all([sourceDatabaseId,targetDatabaseId].map(databaseId=>resolveDbIdentity({projectId,databaseId})));
  for(const [i,databaseId] of [sourceDatabaseId,targetDatabaseId].entries())if(values[i]?.projectId!==projectId||values[i]?.databaseId!==databaseId||values[i]?.uid!==[sourceDatabaseUid,targetDatabaseUid][i])throw Error('FIRESTORE_WRITE_IDENTITY_MISMATCH');
 }
 return Object.freeze({productionReady:false,namespace,async runTransaction(callback,options){
  let active=true,timer,commitAttempted=false;const started=clock();
  const alive=()=>{const t=clock();if(!active||!Number.isSafeInteger(t)||t<started||t>=options.deadlineMs)throw Error(commitAttempted?'FIRESTORE_WRITE_COMMIT_UNCERTAIN':'FIRESTORE_WRITE_DEADLINE_EXPIRED');if(!emulator())throw Error('FIRESTORE_WRITE_DISABLED');};
  const pending=(async()=>{try{
   if(typeof callback!=='function'||options?.databaseUid!==targetDatabaseUid||!Number.isSafeInteger(options?.deadlineMs)||options.deadlineMs<=started||!Number.isSafeInteger(started))throw Error('FIRESTORE_WRITE_CONFIGURATION_REQUIRED');
   alive();await identity();alive();
   const result=await db.runTransaction(async sdk=>{
    alive();const reads=new Map(),staged={record:null,request:null,audit:null};let staging=false;
    async function read(kind,name){alive();if(staging)throw Error('FIRESTORE_WRITE_READ_ORDER_INVALID');const k=kind+'/'+name;if(!reads.has(k))reads.set(k,sdk.get(ref(kind,name)).then(s=>s.exists?clone(s.data()):null));return clone(await reads.get(k));}
    const tx=Object.freeze({getControl:()=>read('control','active'),getPrincipal:n=>read('principals',n),getRequest:n=>read('requests',n),getRecord:n=>read('records',n),
     putRecord:async(n,value,guard)=>{alive();if(staged.record||!reads.has('records/'+n)||!reads.has('control/active'))throw Error('FIRESTORE_WRITE_STAGE_INVALID');staging=true;staged.record={id:n,value:clone(value),guard:clone(guard)};},
     createRequest:async(n,value)=>{alive();if(staged.request||!reads.has('requests/'+n))throw Error('FIRESTORE_WRITE_STAGE_INVALID');staging=true;staged.request={id:n,value:clone(value)};},
     appendAudit:async value=>{alive();if(staged.audit)throw Error('FIRESTORE_WRITE_STAGE_INVALID');staging=true;staged.audit=clone(value);}});
    const value=await callback(tx);alive();
    // Nothing is flushed to the SDK until the complete callback succeeds.
    if(!staging)return value;
    const control=await reads.get('control/active');
    if(control?.databaseUid!==targetDatabaseUid||control.epoch!==epoch||control.quarantined!==true||control.publishAllowed!==false||!Number.isSafeInteger(control.fencingToken)||control.fencingToken<1||!Number.isSafeInteger(control.expiresAt)||clock()>=control.expiresAt)throw Error('FIRESTORE_WRITE_FENCE_REQUIRED');
    if(!staged.record||!staged.request||!staged.audit)throw Error('FIRESTORE_WRITE_STAGE_INVALID');
    const {record,request,audit}=staged,receipt=request.value;
    const principalKeys=[...reads.keys()].filter(k=>k.startsWith('principals/'));
    if(principalKeys.length!==1)throw Error('FIRESTORE_WRITE_AUTHORITY_REQUIRED');
    const principal=await reads.get(principalKeys[0]),actor=principalKeys[0].slice('principals/'.length);
    if(principal?.enabled!==true||!Array.isArray(principal.operations)||!principal.operations.includes(receipt.operation)||!Array.isArray(control.allowedOperations)||!control.allowedOperations.includes(receipt.operation)||(['update','restore','delete'].includes(receipt.operation)&&principal.admin!==true))throw Error('FIRESTORE_WRITE_AUTHORITY_REQUIRED');
    const old=await reads.get('records/'+record.id),oldRequest=await reads.get('requests/'+request.id);
    if(oldRequest||!Number.isSafeInteger(record.guard?.expectedRevision)||record.guard.expectedRevision!==(old?.revision??0)||record.guard.fencingToken!==control.fencingToken||record.value?.revision!==record.guard.expectedRevision+1||receipt.revision!==record.value.revision||receipt.recordId!==record.id||receipt.databaseUid!==targetDatabaseUid||receipt.epoch!==epoch||receipt.status!=='committed'||receipt.ownerHash!==hash(actor)||!HASH.test(receipt.fingerprint||'')||audit.code!=='WRITE_COMMITTED'||audit.actorHash!==hash(actor)||audit.requestHash!==hash(request.id)||audit.operation!==receipt.operation||audit.fencingToken!==control.fencingToken||!ID.test(audit.traceId||'')||!['create','update','restore','delete'].includes(receipt.operation))throw Error('FIRESTORE_WRITE_STAGE_INVALID');
    if((receipt.operation==='create'&&old)||(receipt.operation!=='create'&&!old)||old?.tombstone===true||record.value.tombstone!==(receipt.operation==='delete'))throw Error('FIRESTORE_WRITE_STAGE_INVALID');
    options.deadlineMs=Math.min(options.deadlineMs,control.expiresAt);alive();
    await identity();alive();
    sdk.set(ref('records',record.id),record.value);
    sdk.create(ref('requests',request.id),receipt);
    sdk.create(ref('audit',request.id),audit);
    commitAttempted=true;
    return value;
   },{maxAttempts:5});
   alive();await identity();alive();return result;
  }catch(e){throw Error(errors.has(e?.message)?e.message:(commitAttempted?'FIRESTORE_WRITE_COMMIT_UNCERTAIN':'FIRESTORE_WRITE_UNAVAILABLE'));}})();
  try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Error(commitAttempted?'FIRESTORE_WRITE_COMMIT_UNCERTAIN':'FIRESTORE_WRITE_DEADLINE_EXPIRED'));},timeoutMs);})]);}finally{active=false;clearTimeout(timer);}
 }});
}
module.exports={createFirestoreWriteProvider};
