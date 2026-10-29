'use strict';
// This scheduler orchestration is wired only to the demo-only retention service.
// It does not itself make retention safe for production or enable a schedule.
const {randomUUID}=require('node:crypto');
const {processWithLedger}=require('./deletion-ledger.cjs');

function createScheduledRetentionHandler({db,service,ledger,verifyOidc,config,clock=()=>new Date(),newId=randomUUID}){
  if(!db?.collection||!db?.runTransaction||!service?.scan||!service?.process||!ledger?.recordIntent||!ledger?.markCommitted||!ledger?.assertNoPending||typeof verifyOidc!=='function')throw Error('INVALID_SCHEDULER_DEPENDENCIES');
  const cfg=config||{};
  const ready=cfg.enabled===true && cfg.reviewed===true && /^demo-[a-z0-9-]+$/.test(cfg.projectId||'') &&
    process.env.FIRESTORE_EMULATOR_HOST==='127.0.0.1:8085' && process.env.GCLOUD_PROJECT===cfg.projectId && db.projectId===cfg.projectId &&
    service.schedulerSafety?.projectId===cfg.projectId && service.schedulerSafety?.firestoreHost===process.env.FIRESTORE_EMULATOR_HOST &&
    service.schedulerSafety?.reservationDays===cfg.reservationDays && service.schedulerSafety?.historyDays===cfg.historyDays &&
    /^demo-[a-z0-9-]+$/.test(cfg.ledgerProjectId||'') && cfg.ledgerProjectId!==cfg.projectId &&
    ledger.safety?.sourceProjectId===cfg.projectId && ledger.safety?.ledgerProjectId===cfg.ledgerProjectId &&
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
      // An unresolved prior intent may represent a committed source deletion
      // whose journal completion failed. Never silently skip that record.
      await ledger.assertNoPending();
      const page=await service.scan({limit,after:lease.cursor});
      for(const requestId of page.ids){
        if(!await renew(id))throw Error('FENCE_LOST');
        await ledger.assertNoPending();
        const transactionFence=async tx=>{const snap=await tx.get(control),s=snap.exists?snap.data():{};return s.owner===id&&ms(s.expiresAt)>now().getTime();};
        const plan=await service.process(requestId);
        const action=plan.result==='would_redact'?'redacted':plan.result==='would_purge_history'?'history_purged':null;
        let result=plan.result;
        if(action){
          // Independent intent precedes source write; failure to commit its
          // completion is treated as uncertain and leaves this cursor pending.
          const applied=await processWithLedger({ledger,service,id:requestId,action,expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence});
          result=applied?.result;
          if(result!==action)throw Error('RECONCILIATION_REQUIRED');
        }
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

// A separately authenticated production-compatible inspection path. It NEVER
// calls apply:true or writes the customer database. Work checkpoints live in a
// different explicitly configured project and contain receipt IDs only as a
// private cursor; neither response nor logs include IDs or customer data.
// This path is not an automatic deletion worker.
function createRetentionPreviewHandler({db,controlDb,service,verifyOidc,config,clock=()=>new Date(),newId=randomUUID}){
  if(!db?.collection||!controlDb?.collection||!controlDb?.runTransaction||!service?.scan||!service?.process||typeof verifyOidc!=='function')throw Error('INVALID_PREVIEW_DEPENDENCIES');
  const c=config||{}, safety=service.schedulerSafety||{};
  const projectPattern=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
  let audienceValid=false;
  try{const u=new URL(c.audience);audienceValid=u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.href===c.audience;}catch{}
  const ready=c.enabled===true&&c.reviewed===true&&projectPattern.test(c.projectId||'')&&projectPattern.test(c.controlProjectId||'')&&projectPattern.test(c.ledgerProjectId||'')&&c.controlProjectId!==c.projectId&&c.controlProjectId!==c.ledgerProjectId&&c.ledgerProjectId!==c.projectId&&db.projectId===c.projectId&&controlDb.projectId===c.controlProjectId&&safety.projectId===c.projectId&&safety.previewOnly===true&&safety.reservationDays===c.reservationDays&&safety.historyDays===c.historyDays&&Number.isInteger(c.reservationDays)&&c.reservationDays>0&&c.reservationDays<=36500&&Number.isInteger(c.historyDays)&&c.historyDays>0&&c.historyDays<=36500&&typeof c.policyVersion==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(c.policyVersion)&&audienceValid&&typeof c.serviceAccount==='string'&&/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(c.serviceAccount);
  const control=controlDb.collection('retention_preview').doc('control');
  const runs=controlDb.collection('retention_preview_runs');
  const now=()=>{const d=clock();if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw Error('INVALID_CLOCK');return d;};
  const ms=x=>x instanceof Date?x.getTime():typeof x?.toDate==='function'?x.toDate().getTime():0;
  const leaseMs=300000,limit=25;
  async function acquire(id){return controlDb.runTransaction(async tx=>{const snap=await tx.get(control),s=snap.exists?snap.data():{},at=now();if(s.owner&&ms(s.expiresAt)>at.getTime())return null;const cursor=s.policyVersion===c.policyVersion&&typeof s.cursor==='string'?s.cursor:null;tx.set(control,{owner:id,expiresAt:new Date(at.getTime()+leaseMs),cursor,policyVersion:c.policyVersion});return {cursor};});}
  async function renew(id){return controlDb.runTransaction(async tx=>{const snap=await tx.get(control),s=snap.exists?snap.data():{},at=now();if(s.owner!==id||ms(s.expiresAt)<=at.getTime())return false;tx.set(control,{...s,expiresAt:new Date(at.getTime()+leaseMs)});return true;});}
  async function finish(id,cursor,counts,outcome,failureDigest){return controlDb.runTransaction(async tx=>{const snap=await tx.get(control),s=snap.exists?snap.data():{};if(s.owner!==id)return false;tx.set(control,{owner:null,expiresAt:null,cursor,policyVersion:c.policyVersion});tx.create(runs.doc(id),{at:now(),outcome,counts,policyVersion:c.policyVersion,...(failureDigest?{failureDigest}:{})});return true;});}
  async function run(){
    const id=newId();if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw Error('INVALID_RUN_ID');
    const lease=await acquire(id);if(!lease)return {status:409,body:{status:'busy'}};
    const counts={};let failedId=null;
    try{
      const page=await service.scan({limit,after:lease.cursor});
      for(const requestId of page.ids){
        if(!await renew(id))throw Error('FENCE_LOST');failedId=requestId;
        // No options are accepted here: in particular apply cannot be true.
        const {result}=await service.process(requestId);
        if(result==='retry_needed')throw Error('RETRY_NEEDED');
        if(!['absent','blocked_dependencies','blocked_legal_hold','preserved','changed','would_redact','would_purge_history','already_purged'].includes(result))throw Error('INVALID_RESULT');
        counts[result]=(counts[result]||0)+1;failedId=null;
      }
      if(!await finish(id,page.next,counts,'completed',null))throw Error('FENCE_LOST');
      return {status:200,body:{status:'completed',hasMore:page.next!==null,counts}};
    }catch{
      // A failed page is scanned again after restart; stable hashes help a
      // privileged operator correlate retries without exposing receipt numbers.
      const digest=failedId?require('node:crypto').createHash('sha256').update(failedId).digest('hex'):null;
      try{await finish(id,lease.cursor,counts,'retry_needed',digest);}catch{}
      return {status:503,body:{status:'retry_needed'}};
    }
  }
  return async function(req,res){
    res.set('Cache-Control','no-store');
    if(req.method!=='POST')return res.status(405).json({status:'unavailable'});
    if(!ready)return res.status(503).json({status:'unavailable'});
    const m=/^Bearer ([A-Za-z0-9._-]+)$/.exec(req.headers.authorization||'');if(!m)return res.status(401).json({status:'unauthorized'});
    try{const token=await verifyOidc(m[1],c.audience);if(!token||token.aud!==c.audience||!['https://accounts.google.com','accounts.google.com'].includes(token.iss)||token.email_verified!==true||token.email!==c.serviceAccount)throw Error('UNAUTHORIZED');}catch{return res.status(401).json({status:'unauthorized'});}
    try{const result=await run();return res.status(result.status).json(result.body);}catch{return res.status(503).json({status:'unavailable'});}
  };
}
module.exports.createRetentionPreviewHandler=createRetentionPreviewHandler;

// Called by the production entrypoint only after the restore access gate. No
// schedule is created here. Runtime settings and control-project IAM must be
// reviewed independently before setting the opt-in flag.
function attachRetentionPreview({app,db,controlDb,env=process.env,verifyOidc}){
  if(env.OKCLEAN_RETENTION_PREVIEW_ENABLED!=='true')return false;
  if(env!==process.env)throw Error('PREVIEW_ENV_MISMATCH');
  const projectId=env.OKCLEAN_PROJECT_ID,controlProjectId=env.OKCLEAN_RETENTION_CONTROL_PROJECT_ID,ledgerProjectId=env.OKCLEAN_LEDGER_PROJECT_ID;
  const reservationDays=Number(env.OKCLEAN_RETENTION_RESERVATION_DAYS),historyDays=Number(env.OKCLEAN_RETENTION_HISTORY_DAYS);
  const {createRetentionService}=require('./retention.cjs');
  const service=createRetentionService({db,projectId,policy:{reservationDays,historyDays},previewOnly:true});
  const verifier=verifyOidc||require('./demo-retention-route.cjs').createGoogleOidcVerifier();
  const handler=createRetentionPreviewHandler({db,controlDb,service,verifyOidc:verifier,config:{enabled:true,reviewed:env.OKCLEAN_RETENTION_POLICY_REVIEWED==='true',projectId,controlProjectId,ledgerProjectId,audience:env.OKCLEAN_RETENTION_PREVIEW_AUDIENCE,serviceAccount:env.OKCLEAN_RETENTION_SCHEDULER_ACCOUNT,policyVersion:env.OKCLEAN_RETENTION_POLICY_VERSION,reservationDays,historyDays}});
  app.post('/_internal/retention/preview',handler);return true;
}
module.exports.attachRetentionPreview=attachRetentionPreview;

// Static configuration checks for the dedicated read-only preview service.
// IAM grants, real identity and scheduler configuration must still be reviewed
// in Google Cloud; environment strings are not proof of actual permissions.
function validateRetentionPreviewRuntime(env){
 const errors=[],need=(ok,code)=>{if(!ok)errors.push(code)},p=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,source=env.OKCLEAN_PROJECT_ID,ledger=env.OKCLEAN_LEDGER_PROJECT_ID,control=env.OKCLEAN_RETENTION_CONTROL_PROJECT_ID;
 need(env.NODE_ENV==='production','NODE_ENV_INVALID');
 need([source,ledger,control].every(x=>typeof x==='string'&&p.test(x)&&! /^(demo|test|example)-/i.test(x))&&new Set([source,ledger,control]).size===3,'PROJECT_CONFIGURATION_INVALID');
 need(env.GOOGLE_CLOUD_PROJECT===source&&(!env.GCLOUD_PROJECT||env.GCLOUD_PROJECT===source),'CLOUD_PROJECT_MISMATCH');
 need(env.OKCLEAN_RETENTION_PREVIEW_ENABLED==='true'&&env.OKCLEAN_RETENTION_POLICY_REVIEWED==='true','PREVIEW_POLICY_NOT_REVIEWED');
 for(const name of ['OKCLEAN_RETENTION_RESERVATION_DAYS','OKCLEAN_RETENTION_HISTORY_DAYS']){const value=env[name];need(typeof value==='string'&&/^[1-9][0-9]{0,4}$/.test(value)&&Number(value)<=36500,name+'_INVALID');}
 need(typeof env.OKCLEAN_RETENTION_POLICY_VERSION==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(env.OKCLEAN_RETENTION_POLICY_VERSION)&&! /^(test|demo|example)[-_.]/i.test(env.OKCLEAN_RETENTION_POLICY_VERSION),'POLICY_VERSION_INVALID');
 let url;try{url=new URL(env.OKCLEAN_RETENTION_PREVIEW_AUDIENCE);}catch{}
 need(!!url&&url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.hostname.endsWith('.run.app')&&url.pathname==='/_internal/retention/preview'&&!url.search&&!url.hash,'PREVIEW_AUDIENCE_INVALID');
 const serviceAccountPattern=/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
 need(serviceAccountPattern.test(env.OKCLEAN_RETENTION_SCHEDULER_ACCOUNT||'')&&serviceAccountPattern.test(env.OKCLEAN_RETENTION_PREVIEW_IDENTITY||'')&&env.OKCLEAN_RETENTION_SCHEDULER_ACCOUNT!==env.OKCLEAN_RETENTION_PREVIEW_IDENTITY,'SERVICE_IDENTITIES_INVALID');
 if(env.OKCLEAN_SERVICE_ACCOUNT)need(env.OKCLEAN_RETENTION_PREVIEW_IDENTITY!==env.OKCLEAN_SERVICE_ACCOUNT,'PREVIEW_IDENTITY_MUST_BE_SEPARATE');
 need(typeof env.OKCLEAN_RESTORE_EPOCH==='string'&&/^[A-Za-z0-9_-]{16,80}$/.test(env.OKCLEAN_RESTORE_EPOCH),'RESTORE_EPOCH_INVALID');
 try{const k=env.OKCLEAN_RESTORE_PUBLIC_KEY;need(typeof k==='string'&&/^-----BEGIN PUBLIC KEY-----\n/.test(k)&&require('node:crypto').createPublicKey(k).asymmetricKeyType==='ed25519','RESTORE_PUBLIC_KEY_INVALID');}catch{errors.push('RESTORE_PUBLIC_KEY_INVALID');}
 for(const name of ['FIREBASE_AUTH_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','FIREBASE_EMULATOR_HUB','FIREBASE_APP_CHECK_DEBUG_TOKEN','FIREBASE_APPCHECK_DEBUG_TOKEN','APP_CHECK_DEBUG_TOKEN','GOOGLE_APPLICATION_CREDENTIALS'])if(env[name])errors.push('FORBIDDEN_ENV_'+name);
 return errors;
}
module.exports.validateRetentionPreviewRuntime=validateRetentionPreviewRuntime;
