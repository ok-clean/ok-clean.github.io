'use strict';
const {createHash}=require('node:crypto');
// Emulator-only retention execution. Not a deployable worker and not exposed through HTTP.
// No real project or customer data may be accessed by this module.
const TERMINAL=new Set(['작업완료','종료','취소']);
const DAY=86400000;
const toMs=x=>x instanceof Date?x.getTime():typeof x?.toDate==='function'?x.toDate().getTime():NaN;
const version=x=>x && Number.isInteger(x.seconds) && Number.isInteger(x.nanoseconds)?`${x.seconds}:${x.nanoseconds}`:null;
function policyCheck(p){
  if(!p || !Number.isInteger(p.reservationDays) || !Number.isInteger(p.historyDays) || p.reservationDays<1 || p.historyDays<1 || p.reservationDays>36500 || p.historyDays>36500)throw Error('RETENTION_POLICY_REQUIRED');
}
function ensureEmulator(projectId,host){
  if(typeof projectId!=='string'||!/^demo-[a-z0-9-]+$/.test(projectId)||host!=='127.0.0.1:8085')throw Error('DEMO_FIRESTORE_EMULATOR_REQUIRED');
}
function createRetentionService({db,projectId,firestoreHost,policy,clock=()=>new Date(),authorize=async()=>false}){
  policyCheck(policy);policy=Object.freeze({reservationDays:policy.reservationDays,historyDays:policy.historyDays});ensureEmulator(projectId,firestoreHost);
  // Never trust only caller-supplied emulator strings when destructive operations are available.
  if(require('node:process').env.FIRESTORE_EMULATOR_HOST!==firestoreHost || require('node:process').env.GCLOUD_PROJECT!==projectId || db?.projectId!==projectId)throw Error('DEMO_FIRESTORE_EMULATOR_REQUIRED');
  if(!db?.collection||!db?.runTransaction||typeof authorize!=='function')throw Error('INVALID_DEPENDENCIES');
  async function inspectChildren(ref){
    const cols=await ref.listCollections();
    if(cols.some(c=>c.id!=='status_history'))return false;
    const history=await ref.collection('status_history').limit(201).get();
    if(history.size>200)return false;
    for(const doc of history.docs)if((await doc.ref.listCollections()).length)return false;
    return true;
  }
  async function process(requestId,{apply=false,transactionFence=null,expectedVersion=null,expectedHistoryVersion=null,expectedAction=null}={}){
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(requestId))throw Error('INVALID_REQUEST_ID');
    if(typeof apply!=='boolean')throw Error('INVALID_MODE');
    if(transactionFence!==null && typeof transactionFence!=='function')throw Error('INVALID_FENCE');
    if(expectedVersion!==null && (typeof expectedVersion!=='string'||!/^\d+:\d{1,9}$/.test(expectedVersion)))throw Error('INVALID_VERSION');
    if(expectedHistoryVersion!==null && (typeof expectedHistoryVersion!=='string'||!/^[0-9a-f]{64}$/.test(expectedHistoryVersion)))throw Error('INVALID_HISTORY_VERSION');
    if(expectedAction!==null && !['redacted','history_purged'].includes(expectedAction))throw Error('INVALID_ACTION');
    if(apply && await authorize()!==true)throw Error('APPLY_NOT_AUTHORIZED');
    const at=clock();if(!(at instanceof Date)||!Number.isFinite(at.getTime()))throw Error('INVALID_CLOCK');
    const ref=db.collection('quote_requests').doc(requestId);
    try{
      const initial=await ref.get();if(!initial.exists)return {result:'absent'};
      // Never apply against a parent changed since dependency inspection.
      // This does not eliminate races for an unknown new subcollection.
      const inspectedVersion=version(initial.updateTime);
      if(apply && !inspectedVersion)return {result:'retry_needed'};
      if(!await inspectChildren(ref))return {result:'blocked_dependencies'};
      return await db.runTransaction(async tx=>{
        // Fencing is checked in the same transaction as any destructive writes.
        // A stale scheduler cannot continue deleting after its lease was replaced.
        if(apply && transactionFence && await transactionFence(tx)!==true)throw Error('FENCE_LOST');
        const snap=await tx.get(ref);if(!snap.exists)return {result:'absent'};
        if(apply && version(snap.updateTime)!==inspectedVersion)return {result:'changed'};
        if(expectedVersion!==null){
          const v=snap.updateTime;
          if(version(v)!==expectedVersion)return {result:'changed'};
        }
        const value=snap.data();
        // Retention cannot proceed until a trusted operator explicitly rules out
        // a legal hold. Missing or malformed flags are not treated as clearance.
        if(value.legalHold !== false)return {result:'blocked_legal_hold'};
        const historyQuery=ref.collection('status_history').orderBy('at','desc').limit(201);
        const history=await tx.get(historyQuery);
        if(history.size>200)return {result:'blocked_dependencies'};
        const versions=history.docs.map(doc=>[doc.id||doc.ref?.id,version(doc.updateTime)]);
        if(versions.some(([id,v])=>typeof id!=='string'||!v))return {result:'retry_needed'};
        versions.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
        const historyVersion=createHash('sha256').update(JSON.stringify(versions)).digest('hex');
        if(expectedHistoryVersion!==null && expectedHistoryVersion!==historyVersion)return {result:'changed'};
        if(expectedAction!==null && expectedAction!==(value.retentionRedacted?'history_purged':'redacted'))return {result:'changed'};
        if(!value.retentionRedacted){
          if(!TERMINAL.has(value.status)||!history.docs.length)return {result:'preserved'};
          const latest=history.docs[0].data(),terminalAt=toMs(latest.at);
          if(latest.to!==value.status||!Number.isFinite(terminalAt)||terminalAt>at.getTime()-policy.reservationDays*DAY)return {result:'preserved'};
          if(!apply)return {result:'would_redact',version:version(snap.updateTime),historyVersion};
          // Full replacement removes name, phone, notes, UID, fingerprint and other request fields.
          // Keep a receipt tombstone to prevent reuse and preserve separately retained history.
          tx.set(ref,{retentionRedacted:true,status:'보유기간만료',terminalAt:new Date(terminalAt),redactedAt:at,legalHold:false});
          tx.create(db.collection('retention_audit').doc(),{action:'redacted',at});
          return {result:'redacted'};
        }
        const terminalAt=toMs(value.terminalAt);
        if(!Number.isFinite(terminalAt)||terminalAt>at.getTime()-policy.historyDays*DAY)return {result:'preserved'};
        if(!history.size)return {result:'already_purged'};
        if(!apply)return {result:'would_purge_history',version:version(snap.updateTime),historyVersion};
        for(const doc of history.docs)tx.delete(doc.ref);
        if(history.size)tx.create(db.collection('retention_audit').doc(),{action:'history_purged',at});
        // Keep the irreversible, non-owner tombstone to prevent replay of a deleted ID.
        // A later policy/implementation must establish when this tombstone may be deleted.
        return {result:history.size?'history_purged':'already_purged'};
      });
    }catch{return {result:'retry_needed'};}
  }
  // Scan only document IDs in bounded batches. A trusted caller must keep the
  // cursor private; receipt IDs can be linkable and must not be logged.
  async function scan({limit=50,after=null}={}){
    if(!Number.isInteger(limit)||limit<1||limit>100 || (after!==null && (typeof after!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(after))))throw Error('INVALID_SCAN');
    let q=db.collection('quote_requests').orderBy('__name__');
    if(after!==null)q=q.startAfter(after);
    const snapshot=await q.limit(limit+1).get();
    const ids=snapshot.docs.slice(0,limit).map(d=>d.id);
    return {ids,next: snapshot.docs.length>limit ? ids[ids.length-1] : null};
  }
  // Caller selects explicit IDs and retains per-run counts; never log IDs or personal data.
  async function processBatch(ids,options){
    if(!Array.isArray(ids)||ids.length>100)throw Error('INVALID_BATCH');
    const counts={};for(const id of ids){const {result}=await process(id,options);counts[result]=(counts[result]||0)+1;}return counts;
  }
  return {process,processBatch,scan,schedulerSafety:Object.freeze({projectId,firestoreHost,reservationDays:policy.reservationDays,historyDays:policy.historyDays})};
}
module.exports={createRetentionService};
