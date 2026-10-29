'use strict';
// Emulator-only retention execution. Not a deployable worker and not exposed through HTTP.
// No real project or customer data may be accessed by this module.
const TERMINAL=new Set(['작업완료','종료','취소']);
const DAY=86400000;
const toMs=x=>x instanceof Date?x.getTime():typeof x?.toDate==='function'?x.toDate().getTime():NaN;
function policyCheck(p){
  if(!p || !Number.isInteger(p.reservationDays) || !Number.isInteger(p.historyDays) || p.reservationDays<1 || p.historyDays<1 || p.reservationDays>36500 || p.historyDays>36500)throw Error('RETENTION_POLICY_REQUIRED');
}
function ensureEmulator(projectId,host){
  if(typeof projectId!=='string'||!/^demo-[a-z0-9-]+$/.test(projectId)||host!=='127.0.0.1:8085')throw Error('DEMO_FIRESTORE_EMULATOR_REQUIRED');
}
function createRetentionService({db,projectId,firestoreHost,policy,clock=()=>new Date(),authorize=async()=>false}){
  policyCheck(policy);ensureEmulator(projectId,firestoreHost);
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
  async function process(requestId,{apply=false}={}){
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(requestId))throw Error('INVALID_REQUEST_ID');
    if(typeof apply!=='boolean')throw Error('INVALID_MODE');
    if(apply && await authorize()!==true)throw Error('APPLY_NOT_AUTHORIZED');
    const at=clock();if(!(at instanceof Date)||!Number.isFinite(at.getTime()))throw Error('INVALID_CLOCK');
    const ref=db.collection('quote_requests').doc(requestId);
    try{
      const initial=await ref.get();if(!initial.exists)return {result:'absent'};
      if(!await inspectChildren(ref))return {result:'blocked_dependencies'};
      return await db.runTransaction(async tx=>{
        const snap=await tx.get(ref);if(!snap.exists)return {result:'absent'};
        const value=snap.data();
        const historyQuery=ref.collection('status_history').orderBy('at','desc').limit(201);
        const history=await tx.get(historyQuery);
        if(history.size>200)return {result:'blocked_dependencies'};
        if(!value.retentionRedacted){
          if(!TERMINAL.has(value.status)||!history.docs.length)return {result:'preserved'};
          const latest=history.docs[0].data(),terminalAt=toMs(latest.at);
          if(latest.to!==value.status||!Number.isFinite(terminalAt)||terminalAt>at.getTime()-policy.reservationDays*DAY)return {result:'preserved'};
          if(!apply)return {result:'would_redact'};
          // Full replacement removes name, phone, notes, UID, fingerprint and other request fields.
          // Keep a receipt tombstone to prevent reuse and preserve separately retained history.
          tx.set(ref,{retentionRedacted:true,status:'보유기간만료',terminalAt:new Date(terminalAt),redactedAt:at});
          tx.create(db.collection('retention_audit').doc(),{action:'redacted',at});
          return {result:'redacted'};
        }
        const terminalAt=toMs(value.terminalAt);
        if(!Number.isFinite(terminalAt)||terminalAt>at.getTime()-policy.historyDays*DAY)return {result:'preserved'};
        if(!apply)return {result:'would_purge_history'};
        for(const doc of history.docs)tx.delete(doc.ref);
        if(history.size)tx.create(db.collection('retention_audit').doc(),{action:'history_purged',at});
        // Keep the irreversible, non-owner tombstone to prevent replay of a deleted ID.
        // A later policy/implementation must establish when this tombstone may be deleted.
        return {result:history.size?'history_purged':'already_purged'};
      });
    }catch{return {result:'retry_needed'};}
  }
  // Caller selects explicit IDs and retains per-run counts; never log IDs or personal data.
  async function processBatch(ids,options){
    if(!Array.isArray(ids)||ids.length>100)throw Error('INVALID_BATCH');
    const counts={};for(const id of ids){const {result}=await process(id,options);counts[result]=(counts[result]||0)+1;}return counts;
  }
  return {process,processBatch};
}
module.exports={createRetentionService};
