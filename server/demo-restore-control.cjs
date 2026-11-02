'use strict';
// Emulator-only application quarantine and append-only signed checkpoints.
// This is NOT an IAM/network fence or WORM storage. No production entrypoint
// imports this adapter, and successful preparation never permits publication.
const crypto=require('node:crypto');
const {recordBytes}=require('./restore-issuer.cjs');
const {fenceMessage,checkpointMessage}=require('./independent-restore-verifier.cjs');
const ID=/^[A-Za-z0-9_-]{16,80}$/;
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
function stateMessage(x){return Buffer.from(JSON.stringify(['okclean-demo-restore-state-v1',x.sourceProject,x.restoreId,x.servedDatabaseId,x.servedDatabaseUid,x.fenceId,x.phase,x.digest,x.recordCount,x.issuedAt,x.expiresAt]));}
function canonical(x){
 if(x instanceof Date){if(!Number.isFinite(x.getTime()))throw Error('INVALID_SNAPSHOT');return ['timestamp',x.toISOString()];}
 if(x&&typeof x.toDate==='function')return canonical(x.toDate());
 if(x===null||typeof x==='string'||typeof x==='boolean')return x;
 if(typeof x==='number'&&Number.isFinite(x))return x;
 if(Array.isArray(x))return x.map(canonical);
 if(x&&typeof x==='object')return Object.keys(x).sort().map(k=>[k,canonical(x[k])]);
 throw Error('INVALID_SNAPSHOT');
}
function createDemoRestoreControl(c){
 const {controlDb,ledgerDb,sourceDb,restoredDb,sourceProject,ledgerProject,restoreId,resolveDbIdentity,verifyIdToken,sign,publicKey,clock=()=>Date.now(),leaseMs=300000,timeoutMs=5000}=c||{};
 if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!==sourceProject||
 ![sourceProject,ledgerProject,controlDb?.projectId].every(p=>/^demo-[a-z0-9-]+$/.test(p||''))||new Set([sourceProject,ledgerProject,controlDb?.projectId]).size!==3||ledgerDb?.projectId!==ledgerProject||sourceDb?.projectId!==sourceProject||restoredDb?.projectId!==sourceProject||!sourceDb.databaseId||!restoredDb.databaseId||sourceDb.databaseId===restoredDb.databaseId||!ID.test(restoreId||'')||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(leaseMs)||leaseMs<1000||leaseMs>600000||[resolveDbIdentity,verifyIdToken,sign,clock].some(f=>typeof f!=='function'))throw Error('DEMO_RESTORE_CONTROL_REQUIRED');
 const key=crypto.createPublicKey(publicKey);if(key.asymmetricKeyType!=='ed25519')throw Error('CONTROL_KEY_INVALID');
 const run=controlDb.collection('restore_adapter_runs').doc(restoreId),head=ledgerDb.collection('deletion_ledger_meta').doc(sourceProject),entries=ledgerDb.collection('deletion_ledger');
 const fenceRef=ledgerDb.collection('restore_fence_evidence').doc(restoreId),cpRef=ledgerDb.collection('restore_checkpoint_evidence').doc(restoreId);
 const time=()=>{const t=clock();if(!Number.isSafeInteger(t))throw Error('INVALID_CLOCK');return t;};
 async function bounded(fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CONTROL_TIMEOUT')),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
 async function signed(value,message){const sig=await bounded(()=>sign(message(value)));if(!Buffer.isBuffer(sig)||sig.length!==64||!crypto.verify(null,message(value),key,sig))throw Error('CONTROL_SIGNATURE_INVALID');return {...value,signature:sig.toString('base64url')};}
 async function caller(token){const a=await bounded(()=>verifyIdToken(token));if(!a||typeof a.uid!=='string'||!a.uid||a.restoreAdmin!==true)throw Error('RESTORE_OPERATOR_REQUIRED');return digest(a.uid);}
 function held(v,owner,trace){return v&&v.ownerHash===owner&&v.traceId===trace&&v.sourceProject===sourceProject&&v.restoreId===restoreId&&v.servedDatabaseId===restoredDb.databaseId&&v.state==='quarantined'&&v.publishAllowed===false&&v.expiresAt>time();}
 async function identify(){const x=await bounded(()=>resolveDbIdentity({projectId:sourceProject,databaseId:restoredDb.databaseId}));if(x?.projectId!==sourceProject||x.databaseId!==restoredDb.databaseId||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x.uid||''))throw Error('RESTORE_IDENTITY_INVALID');return x.uid;}
 async function snapshot(){
  const initial=await head.get();if(!initial.exists||!Number.isSafeInteger(initial.data().revision)||initial.data().revision<0)throw Error('LEDGER_UNSTABLE');
  const revision=initial.data().revision,hash=crypto.createHash('sha256');let after,count=0;
  if(!(await entries.where('state','==','pending').limit(1).get()).empty)throw Error('LEDGER_PENDING');
  for(;;){let q=entries.orderBy('__name__');if(after)q=q.startAfter(after);const page=await q.limit(100).get();
   for(const doc of page.docs){const row=doc.data(),expected=digest(sourceProject+'\0'+row.action+'\0'+row.id);if(row.sourceProject!==sourceProject||doc.id!==expected||(after&&doc.id<=after))throw Error('LEDGER_INVALID');hash.update(recordBytes(row));after=doc.id;if(++count>100000)throw Error('LEDGER_LIMIT');}
   if(page.docs.length<100)break;
  }
  await ledgerDb.runTransaction(async tx=>{const h=await tx.get(head),p=await tx.get(entries.where('state','==','pending').limit(1));if(h.data()?.revision!==revision||!p.empty)throw Error('LEDGER_CHANGED');},{readOnly:true});
  return {checkpoint:hash.digest('hex'),ledgerRevision:revision,recordCount:count};
 }
 async function prepare({idToken,traceId}){
  if(!ID.test(traceId||''))throw Error('TRACE_REQUIRED');const owner=await caller(idToken),uid=await identify();
  const state=await controlDb.runTransaction(async tx=>{const old=await tx.get(run);if(old.exists){const v=old.data();if(!held(v,owner,traceId)||v.servedDatabaseUid!==uid)throw Error('RESTORE_QUARANTINE_BUSY');return v;}
   const issuedAt=time(),v={sourceProject,ledgerProject,restoreId,servedDatabaseId:restoredDb.databaseId,servedDatabaseUid:uid,fenceId:crypto.randomUUID(),traceId,ownerHash:owner,issuedAt,expiresAt:issuedAt+leaseMs,state:'quarantined',publishAllowed:false};tx.create(run,v);return v;});
  const snap=await snapshot();if(await identify()!==uid)throw Error('RESTORE_IDENTITY_CHANGED');
  const binding={sourceProject,ledgerProject,restoreId,servedDatabaseId:restoredDb.databaseId,servedDatabaseUid:uid,fenceId:state.fenceId,issuedAt:state.issuedAt,expiresAt:state.expiresAt};
  const fence=await signed({...binding,state:'held'},fenceMessage),checkpoint=await signed({...binding,...snap,state:'immutable-complete'},checkpointMessage);
  await ledgerDb.runTransaction(async tx=>{const [f,p,h,pending]=await Promise.all([tx.get(fenceRef),tx.get(cpRef),tx.get(head),tx.get(entries.where('state','==','pending').limit(1))]);
   if(h.data()?.revision!==snap.ledgerRevision||!pending.empty||time()>=state.expiresAt)throw Error('LEDGER_CHANGED');
   if(f.exists||p.exists){if(!f.exists||!p.exists||!same(f.data(),fence)||!same(p.data(),checkpoint))throw Error('CHECKPOINT_IMMUTABLE');return;}
   tx.create(fenceRef,fence);tx.create(cpRef,checkpoint);
  });
  return {fence,checkpoint,publishAllowed:false};
 }
 async function capture({idToken,traceId,phase}){
  if(!['before','after'].includes(phase)||!ID.test(traceId||''))throw Error('CHECKPOINT_PHASE_INVALID');
  const owner=await caller(idToken),r=await run.get(),v=r.data();if(!r.exists||!held(v,owner,traceId))throw Error('RESTORE_QUARANTINE_REQUIRED');
  if(await identify()!==v.servedDatabaseUid)throw Error('RESTORE_IDENTITY_CHANGED');
  async function scan(){const hash=crypto.createHash('sha256');let after,count=0;
  for(;;){let q=restoredDb.collection('quote_requests').orderBy('__name__');if(after)q=q.startAfter(after);const page=await q.limit(100).get();
   for(const doc of page.docs){if(after&&doc.id<=after)throw Error('SNAPSHOT_ORDER');const ref=doc.ref,cols=await ref.listCollections();if(cols.some(x=>x.id!=='status_history'))throw Error('SNAPSHOT_DEPENDENCY');
    const history=await ref.collection('status_history').orderBy('__name__').limit(201).get();if(history.size>200)throw Error('SNAPSHOT_LIMIT');
    for(const child of history.docs)if((await child.ref.listCollections()).length)throw Error('SNAPSHOT_DEPENDENCY');
    hash.update(JSON.stringify(canonical([doc.id,doc.data(),history.docs.map(d=>[d.id,d.data()])]))+'\n');
    const latest=await ref.get();if(!latest.exists||!doc.updateTime.isEqual(latest.updateTime))throw Error('SNAPSHOT_CHANGED');after=doc.id;if(++count>100000)throw Error('SNAPSHOT_LIMIT');
   }if(page.docs.length<100)break;
  }
  return {digest:hash.digest('hex'),recordCount:count};}
  const first=await scan(),second=await scan();if(!same(first,second))throw Error('SNAPSHOT_CHANGED');
  if(await identify()!==v.servedDatabaseUid)throw Error('RESTORE_IDENTITY_CHANGED');
  const result=await signed({sourceProject,restoreId,servedDatabaseId:restoredDb.databaseId,servedDatabaseUid:v.servedDatabaseUid,fenceId:v.fenceId,phase,...first,issuedAt:v.issuedAt,expiresAt:v.expiresAt},stateMessage);
  const ref=controlDb.collection('restore_state_checkpoints').doc(restoreId+'_'+phase);
  await controlDb.runTransaction(async tx=>{const [s,old]=await Promise.all([tx.get(run),tx.get(ref)]);if(!held(s.data(),owner,traceId))throw Error('RESTORE_QUARANTINE_REQUIRED');if(old.exists){if(!same(old.data(),result))throw Error('CHECKPOINT_IMMUTABLE');return;}tx.create(ref,result);});
  return result;
 }
 // There deliberately is no release/promote/delete/production-sign method.
 async function recordOutcome({idToken,traceId,outcome,reason='none'}){
  if(!ID.test(traceId||'')||!['prepared','before_checkpoint','after_checkpoint','blocked','retry_needed'].includes(outcome)||!['none','auth_failed','evidence_invalid','ledger_changed','policy_blocked','identity_changed','timeout','unknown'].includes(reason))throw Error('AUDIT_CODE_INVALID');
  const owner=await caller(idToken),ref=controlDb.collection('restore_adapter_audit').doc(crypto.randomUUID());
  await controlDb.runTransaction(async tx=>{const s=await tx.get(run);if(!s.exists||s.data().ownerHash!==owner||s.data().traceId!==traceId)throw Error('RESTORE_OPERATOR_REQUIRED');tx.create(ref,{traceId,outcome,reason,at:time(),publishAllowed:false});});
  return {traceId,outcome,reason,publishAllowed:false};
 }
 return Object.freeze({prepare,capture,recordOutcome});
}
module.exports={createDemoRestoreControl,stateMessage};
