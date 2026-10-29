'use strict';
// Ledger lives in a different Firestore project from customer records. The
// deployed IAM boundary and the network isolation of a restored database must
// be configured independently; application code cannot enforce either one.
const {createHash}=require('node:crypto');
const idPattern=/^[A-Za-z0-9_-]{1,80}$/;
const actions=new Set(['redacted','history_purged']);
function valid({id,action,expectedVersion}){
  if(typeof id!=='string'||!idPattern.test(id)||!actions.has(action)||typeof expectedVersion!=='string'||!expectedVersion||expectedVersion.length>100)throw Error('INVALID_LEDGER_INPUT');
}
function key(source,id,action){return createHash('sha256').update(source).update('\0').update(action).update('\0').update(id).digest('hex');}
function createDeletionLedger({ledgerDb,primaryProjectId,ledgerProjectId,clock=()=>new Date()}){
  if(!ledgerDb?.collection||!ledgerDb?.runTransaction||typeof primaryProjectId!=='string'||!primaryProjectId||typeof ledgerProjectId!=='string'||!ledgerProjectId||primaryProjectId===ledgerProjectId||ledgerDb.projectId!==ledgerProjectId)throw Error('INDEPENDENT_LEDGER_REQUIRED');
  const collection=ledgerDb.collection('deletion_ledger');
  async function recordIntent(input){
    valid(input);const ref=collection.doc(key(primaryProjectId,input.id,input.action));
    return ledgerDb.runTransaction(async tx=>{
      const snap=await tx.get(ref);
      if(snap.exists){const row=snap.data();if(row.sourceProject!==primaryProjectId||row.id!==input.id||row.action!==input.action||row.expectedVersion!==input.expectedVersion)throw Error('LEDGER_CONFLICT');if(!['pending','committed'].includes(row.state))throw Error('LEDGER_INVALID');return row.state;}
      const at=clock();if(!(at instanceof Date)||!Number.isFinite(at.getTime()))throw Error('INVALID_CLOCK');
      tx.create(ref,{sourceProject:primaryProjectId,id:input.id,action:input.action,expectedVersion:input.expectedVersion,state:'pending',recordedAt:at});return 'pending';
    });
  }
  async function markCommitted(input){
    valid(input);const ref=collection.doc(key(primaryProjectId,input.id,input.action));
    return ledgerDb.runTransaction(async tx=>{
      const snap=await tx.get(ref);if(!snap.exists)throw Error('LEDGER_INTENT_REQUIRED');const row=snap.data();
      if(row.sourceProject!==primaryProjectId||row.id!==input.id||row.action!==input.action||row.expectedVersion!==input.expectedVersion)throw Error('LEDGER_CONFLICT');
      if(row.state==='committed')return 'committed';if(row.state!=='pending')throw Error('LEDGER_INVALID');
      const at=clock();if(!(at instanceof Date)||!Number.isFinite(at.getTime()))throw Error('INVALID_CLOCK');tx.update(ref,{state:'committed',committedAt:at});return 'committed';
    });
  }
  async function page({after,limit=50}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100||(after!==undefined&&(typeof after!=='string'||!/^[a-f0-9]{64}$/.test(after))))throw Error('INVALID_PAGE');
    let query=collection.orderBy('__name__');if(after!==undefined)query=query.startAfter(after);
    const snap=await query.limit(limit+1).get();const docs=snap.docs.slice(0,limit);
    return {records:docs.map(d=>d.data()),next:snap.docs.length>limit?docs[docs.length-1].id:null};
  }
  // The caller must enforce an external exclusive restore fence and network
  // isolation throughout this operation, including after this function returns.
  // Never expose a restored database until an independent check permits it.
  async function replay({isRestoreFenced,verifyLedgerSnapshot,reapply,pageSize=50}){
    if(typeof isRestoreFenced!=='function'||typeof verifyLedgerSnapshot!=='function'||typeof reapply!=='function')throw Error('RESTORE_GUARD_REQUIRED');
    // A separate immutable checkpoint/snapshot service must verify completeness.
    // Returning from this function is not permission to make a restore public.
    if(await verifyLedgerSnapshot()!==true)throw Error('LEDGER_SNAPSHOT_UNVERIFIED');
    let processed=0;
    async function visit(action){
      let after;
      for(;;){
        if(await isRestoreFenced()!==true)throw Error('RESTORE_FENCE_REQUIRED');
        const result=await page({after,limit:pageSize});
        for(const record of result.records){
          if(await isRestoreFenced()!==true)throw Error('RESTORE_FENCE_REQUIRED');
          valid(record);if(record.sourceProject!==primaryProjectId)throw Error('LEDGER_SOURCE_MISMATCH');if(record.state!=='committed')throw Error('LEDGER_RECONCILIATION_REQUIRED');
          if(action && record.action===action){
            if(await reapply({id:record.id,action:record.action,expectedVersion:record.expectedVersion})!==true)throw Error('RESTORE_REAPPLY_FAILED');
            processed++;
          }
        }
        if(!result.next)break;after=result.next;
      }
    }
    // Verify no intention is unresolved before changing the restored copy, then
    // process parent redaction before purging children regardless of hash order.
    await visit(null);await visit('redacted');await visit('history_purged');
    if(await isRestoreFenced()!==true)throw Error('RESTORE_FENCE_REQUIRED');
    if(await verifyLedgerSnapshot()!==true)throw Error('LEDGER_SNAPSHOT_UNVERIFIED');
    return {processed};
  }
  return {recordIntent,markCommitted,page,replay};
}
module.exports={createDeletionLedger};

// Integrate only with a worker whose process method rechecks expectedVersion
// inside the same transaction that modifies the original. A failed or uncertain
// operation deliberately leaves its ledger entry pending for reconciliation.
async function processWithLedger({ledger,service,id,action,expectedVersion}){
  if(!ledger?.recordIntent||!ledger?.markCommitted||!service?.process)throw Error('INCOMPLETE_DELETION_GUARD');
  const input={id,action,expectedVersion};valid(input);
  if(await ledger.recordIntent(input)==='committed')throw Error('LEDGER_ALREADY_COMMITTED');
  const result=await service.process(id,{apply:true,expectedVersion});
  if(result?.result===action || (action==='history_purged'&&result?.result==='already_purged'))await ledger.markCommitted(input);
  return result;
}
module.exports.processWithLedger=processWithLedger;
