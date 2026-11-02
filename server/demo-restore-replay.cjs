'use strict';
// Demo emulator ONLY. No production entrypoint, IAM fence controller or release
// operation. Cross-project evidence reads cannot atomically fence another DB;
// this adapter rechecks at every boundary and leaves a failed restore blocked.
const crypto=require('node:crypto');
const {createDeletionLedger}=require('./deletion-ledger.cjs');
const {createRetentionService}=require('./retention.cjs');
const {recordBytes}=require('./restore-issuer.cjs');
const {fenceMessage,checkpointMessage}=require('./independent-restore-verifier.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function createDemoRestoreReplay({ledgerDb,sourceDb,restoredDb,sourceProject,ledgerProject,restoreId,resolveDbIdentity,controlAuthorityPublicKey,policy,clock=()=>new Date(),leaseMs=30000,newId=()=>crypto.randomUUID()}){
 const env=process.env,host='127.0.0.1:8085',demo=x=>/^demo-[a-z0-9-]+$/.test(x||'');
 if(!demo(sourceProject)||!demo(ledgerProject)||sourceProject===ledgerProject||env.FIRESTORE_EMULATOR_HOST!==host||env.GCLOUD_PROJECT!==sourceProject||ledgerDb?.projectId!==ledgerProject||sourceDb?.projectId!==sourceProject||restoredDb?.projectId!==sourceProject||!restoredDb?.databaseId||sourceDb.databaseId===restoredDb.databaseId||! /^[A-Za-z0-9_-]{16,80}$/.test(restoreId||'')||typeof resolveDbIdentity!=='function'||!Number.isInteger(leaseMs)||leaseMs<100||leaseMs>300000||typeof newId!=='function')throw Error('DEMO_RESTORE_REPLAY_REQUIRED');
 const authority=crypto.createPublicKey(controlAuthorityPublicKey);if(authority.asymmetricKeyType!=='ed25519')throw Error('CONTROL_AUTHORITY_KEY_REQUIRED');
 const ledger=createDeletionLedger({ledgerDb,primaryProjectId:sourceProject,ledgerProjectId:ledgerProject,clock});
 const fenceRef=ledgerDb.collection('restore_fence_evidence').doc(restoreId),checkpointRef=ledgerDb.collection('restore_checkpoint_evidence').doc(restoreId),headRef=ledgerDb.collection('deletion_ledger_meta').doc(sourceProject),lockRef=restoredDb.collection('restore_replay_control').doc('active');
 const ms=()=>{const n=clock();if(!(n instanceof Date)||!Number.isFinite(n.getTime()))throw Error('INVALID_CLOCK');return n.getTime();};
 const signature=(v,make,t)=>v&&v.sourceProject===sourceProject&&v.ledgerProject===ledgerProject&&v.restoreId===restoreId&&v.servedDatabaseId===restoredDb.databaseId&&Number.isSafeInteger(v.issuedAt)&&Number.isSafeInteger(v.expiresAt)&&v.issuedAt<=t&&v.expiresAt>t&&v.expiresAt-v.issuedAt<=600000&&/^[A-Za-z0-9_-]{16,80}$/.test(v.fenceId||'')&&/^[A-Za-z0-9_-]{86}$/.test(v.signature||'')&&crypto.verify(null,make(v),authority,Buffer.from(v.signature,'base64url'));
 async function evidence(){
  const [fs,cs,id]=await Promise.all([fenceRef.get(),checkpointRef.get(),resolveDbIdentity({projectId:sourceProject,databaseId:restoredDb.databaseId})]);
  if(!fs.exists||!cs.exists)throw Error('SIGNED_REPLAY_EVIDENCE_REQUIRED');const f=fs.data(),c=cs.data(),t=ms();
  if(!signature(f,fenceMessage,t)||!signature(c,checkpointMessage,t)||f.state!=='held'||c.state!=='immutable-complete'||f.fenceId!==c.fenceId||id?.projectId!==sourceProject||id.databaseId!==restoredDb.databaseId||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id.uid||'')||f.servedDatabaseUid!==id.uid||c.servedDatabaseUid!==id.uid||!/^[a-f0-9]{64}$/.test(c.checkpoint||'')||!Number.isSafeInteger(c.ledgerRevision)||c.ledgerRevision<0||!Number.isSafeInteger(c.recordCount)||c.recordCount<0||c.recordCount>100000)throw Error('SIGNED_REPLAY_EVIDENCE_REQUIRED');
  const h=await headRef.get();if(!h.exists||h.data()?.revision!==c.ledgerRevision)throw Error('REPLAY_LEDGER_CHANGED');await ledger.assertNoPending();if(ms()>=Math.min(f.expiresAt,c.expiresAt))throw Error('REPLAY_EVIDENCE_EXPIRED');return {f:clone(f),c:clone(c)};
 }
 return Object.freeze({async replay(){
  const owner=newId();if(typeof owner!=='string'||! /^[A-Za-z0-9_-]{1,80}$/.test(owner))throw Error('INVALID_REPLAY_OWNER');
  const start=ms(),proof=await evidence(),deadline=Math.min(start+leaseMs,proof.f.expiresAt,proof.c.expiresAt);let owned=false,closed=false,completed=false;
  const counts={redacted:0,history_purged:0,already_applied:0};
  async function unchanged(){if(closed||ms()>=deadline)throw Error('REPLAY_LEASE_EXPIRED');const current=await evidence();if(closed||ms()>=deadline)throw Error('REPLAY_LEASE_EXPIRED');if(JSON.stringify(current)!==JSON.stringify(proof))throw Error('REPLAY_EVIDENCE_CHANGED');return true;}
  async function fence(tx){await unchanged();const s=await tx.get(lockRef),v=s.exists?s.data():null;return v?.owner===owner&&v.restoreId===restoreId&&v.fenceId===proof.f.fenceId&&v.expiresAt===deadline&&ms()<deadline;}
  async function snapshot(){await unchanged();const hash=crypto.createHash('sha256');let after,count=0;for(;;){const p=await ledger.page({after,limit:100});for(const row of p.records){if(row.sourceProject!==sourceProject)throw Error('REPLAY_LEDGER_INVALID');hash.update(recordBytes(row));if(++count>100000)throw Error('REPLAY_LEDGER_INVALID');}if(!p.next)break;after=p.next;}if(count!==proof.c.recordCount||hash.digest('hex')!==proof.c.checkpoint)throw Error('REPLAY_CHECKPOINT_MISMATCH');await unchanged();return true;}
  try{
   await restoredDb.runTransaction(async tx=>{const s=await tx.get(lockRef),v=s.exists?s.data():null,t=ms();if(v?.owner&&(!Number.isFinite(v.expiresAt)||v.expiresAt>t))throw Error('REPLAY_BUSY');if(t>=deadline)throw Error('REPLAY_LEASE_EXPIRED');tx.set(lockRef,{owner,restoreId,fenceId:proof.f.fenceId,expiresAt:deadline});});owned=true;
   const service=createRetentionService({db:restoredDb,projectId:sourceProject,firestoreHost:host,policy,clock,authorize:async()=>{await unchanged();return true;}});
   await snapshot();
   const result=await ledger.replay({service,verifyLedgerSnapshot:snapshot,isRestoreFenced:async()=>{await unchanged();return restoredDb.runTransaction(fence,{readOnly:true});},reapply:async({id,action,ledgerPermit})=>{
    await unchanged();const ref=restoredDb.collection('quote_requests').doc(id),current=await ref.get();if(!current.exists)throw Error('REPLAY_RECORD_ABSENT');const value=current.data();if(value.legalHold!==false)throw Error('REPLAY_LEGAL_HOLD');
    if(value.retentionRedacted===true){const keys=['dataMutationFrozen','legalHold','redactedAt','retentionFreeze','retentionRedacted','status','terminalAt'];if(JSON.stringify(Object.keys(value).sort())!==JSON.stringify(keys)||value.status!=='보유기간만료'||value.dataMutationFrozen!==true||value.retentionFreeze!=='retention-v1')throw Error('REPLAY_REDACTED_SHAPE_INVALID');const time=v=>v instanceof Date?v.getTime():typeof v?.toDate==='function'?v.toDate().getTime():NaN;if(!Number.isFinite(time(value.redactedAt))||!Number.isFinite(time(value.terminalAt))||(await ref.listCollections()).some(c=>c.id!=='status_history'))throw Error('REPLAY_REDACTED_SHAPE_INVALID');if(action==='redacted'){counts.already_applied++;return true;}}
    let plan=await service.process(id);
    if(action==='history_purged'&&plan.result==='already_purged'){counts.already_applied++;return true;}
    const expected=action==='redacted'?'would_redact':'would_purge_history';if(plan.result!==expected)throw Error('REPLAY_POLICY_OR_DEPENDENCY_BLOCKED');
    const frozen=await service.freeze(id,{expectedAction:action,expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence:fence});if(frozen.result!=='frozen')throw Error('REPLAY_FREEZE_FAILED');
    plan=await service.process(id);if(plan.result!==expected)throw Error('REPLAY_STATE_CHANGED');
    const applied=await service.process(id,{apply:true,expectedAction:action,expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence:fence,ledgerPermit});
    if(applied.result!==action)throw Error('REPLAY_APPLY_FAILED');counts[action]++;return true;
   }});
   await unchanged();completed=true;return {status:'reapplied',publishAllowed:false,counts,processed:result.processed};
  }finally{
   closed=true;
   if(owned)await restoredDb.runTransaction(async tx=>{const s=await tx.get(lockRef);if(s.exists&&s.data()?.owner===owner){tx.set(lockRef,{owner:null,restoreId:null,fenceId:null,expiresAt:0});tx.create(restoredDb.collection('restore_replay_runs').doc(),{at:clock(),counts,outcome:completed?'reapplied':'incomplete'});}});
  }
 }});
}
module.exports={createDemoRestoreReplay};
