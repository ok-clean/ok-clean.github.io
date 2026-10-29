'use strict';
// This scheduler orchestration is wired only to the demo-only retention service.
// It does not itself make retention safe for production or enable a schedule.
const {randomUUID}=require('node:crypto');

function createScheduledRetentionHandler({db,service,verifyOidc,config,clock=()=>new Date(),newId=randomUUID}){
  if(!db?.collection||!db?.runTransaction||!service?.scan||!service?.process||typeof verifyOidc!=='function')throw Error('INVALID_SCHEDULER_DEPENDENCIES');
  const cfg=config||{};
  const ready=cfg.enabled===true && cfg.reviewed===true && /^demo-[a-z0-9-]+$/.test(cfg.projectId||'') &&
    process.env.FIRESTORE_EMULATOR_HOST==='127.0.0.1:8085' && process.env.GCLOUD_PROJECT===cfg.projectId && db.projectId===cfg.projectId &&
    service.schedulerSafety?.projectId===cfg.projectId && service.schedulerSafety?.firestoreHost===process.env.FIRESTORE_EMULATOR_HOST &&
    service.schedulerSafety?.reservationDays===cfg.reservationDays && service.schedulerSafety?.historyDays===cfg.historyDays &&
    typeof cfg.audience==='string' && /^https:\/\//.test(cfg.audience) &&
    typeof cfg.serviceAccount==='string' && /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(cfg.serviceAccount) &&
    typeof cfg.policyVersion==='string' && /^[A-Za-z0-9._-]{1,80}$/.test(cfg.policyVersion) &&
    Number.isInteger(cfg.reservationDays)&&cfg.reservationDays>0&&cfg.reservationDays<=36500 &&
    Number.isInteger(cfg.historyDays)&&cfg.historyDays>0&&cfg.historyDays<=36500;
  const control=db.collection('retention_scheduler').doc('control');
  const runs=db.collection('retention_scheduler_runs');
  const leaseMs=5*60*1000, limit=25;
  const now=()=>{const d=clock();if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw Error('INVALID_CLOCK');return d;};
  const ms=x=>x instanceof Date?x.getTime():typeof x?.toDate==='function'?x.toDate().getTime():0;
  async function acquire(id){
    return db.runTransaction(async tx=>{
      const snap=await tx.get(control), state=snap.exists?snap.data():{},at=now();
      if(state.owner && ms(state.expiresAt)>at.getTime())return null;
      const cursor=state.policyVersion===cfg.policyVersion&&typeof state.cursor==='string'?state.cursor:null;
      tx.set(control,{owner:id,expiresAt:new Date(at.getTime()+leaseMs),cursor,policyVersion:cfg.policyVersion});
      return {cursor};
    });
  }
  async function renew(id){return db.runTransaction(async tx=>{
    const snap=await tx.get(control),s=snap.exists?snap.data():{},at=now();
    if(s.owner!==id||ms(s.expiresAt)<=at.getTime())return false;
    tx.set(control,{...s,expiresAt:new Date(at.getTime()+leaseMs)});return true;
  });}
  async function finish(id,cursor,counts,outcome){return db.runTransaction(async tx=>{
    const snap=await tx.get(control),s=snap.exists?snap.data():{};
    if(s.owner!==id)return false;
    tx.set(control,{owner:null,expiresAt:null,cursor,policyVersion:cfg.policyVersion});
    // No document IDs, user data, tokens, or error objects in run history.
    tx.create(runs.doc(id),{at:now(),outcome,counts,policyVersion:cfg.policyVersion});return true;
  });}
  async function run(){
    const id=newId();if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw Error('INVALID_RUN_ID');
    const lease=await acquire(id);if(!lease)return {status:409,body:{status:'busy'}};
    const counts={};let next=lease.cursor;
    try{
      const page=await service.scan({limit,after:lease.cursor});
      for(const requestId of page.ids){
        if(!await renew(id))throw Error('FENCE_LOST');
        const transactionFence=async tx=>{const snap=await tx.get(control),s=snap.exists?snap.data():{};return s.owner===id&&ms(s.expiresAt)>now().getTime();};
        const {result}=await service.process(requestId,{apply:true,transactionFence});
        if(result==='retry_needed')throw Error('RETRY_NEEDED');
        // Results are fixed server-side labels, never request-supplied strings.
        if(!['absent','blocked_dependencies','blocked_legal_hold','preserved','changed','redacted','history_purged','already_purged'].includes(result))throw Error('INVALID_RESULT');
        counts[result]=(counts[result]||0)+1;
      }
      next=page.next;
      if(!await finish(id,next,counts,'completed'))throw Error('FENCE_LOST');
      return {status:200,body:{status:'completed',hasMore:next!==null,counts}};
    }catch{
      // Retain original cursor on partial failure. Applied records are idempotent.
      try{await finish(id,lease.cursor,counts,'retry_needed');}catch{}
      return {status:503,body:{status:'retry_needed'}};
    }
  }
  return async function(req,res){
    res.set('Cache-Control','no-store');
    if(req.method!=='POST')return res.status(405).json({status:'unavailable'});
    if(!ready)return res.status(503).json({status:'unavailable'});
    const match=/^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization||'');
    if(!match)return res.status(401).json({status:'unauthorized'});
    try{
      // The real verifier MUST validate signature, expiry, issuer and audience.
      const payload=await verifyOidc(match[1],cfg.audience);
      if(!payload || payload.aud!==cfg.audience || !['https://accounts.google.com','accounts.google.com'].includes(payload.iss) || payload.email_verified!==true || payload.email!==cfg.serviceAccount)throw Error('UNAUTHORIZED');
    }catch{return res.status(401).json({status:'unauthorized'});}
    try{const result=await run();return res.status(result.status).json(result.body);}catch{return res.status(503).json({status:'unavailable'});}
  };
}
module.exports={createScheduledRetentionHandler};
