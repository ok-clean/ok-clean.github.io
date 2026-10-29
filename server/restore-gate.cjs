'use strict';
// An application-layer gate, not an IAM or network fence. The isolated ledger
// project and the attestation signing key must be controlled independently.
const crypto=require('node:crypto');
const project=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const restore=/^[A-Za-z0-9_-]{16,80}$/;
const hash=/^[a-f0-9]{64}$/;
const b64=/^[A-Za-z0-9_-]{86}$/; // 64-byte Ed25519 signature, unpadded base64url
function message(v){
  return Buffer.from(JSON.stringify(['okclean-restore-gate-v1',v.sourceProject,v.ledgerProject,v.restoreId,v.checkpoint,v.ledgerRevision,v.issuedAt,v.expiresAt,v.state]));
}
function createRestoreGate({ledgerDb,sourceProject,ledgerProject,restoreId,publicKey,now=()=>Date.now(),readTimeoutMs=5000}){
  if(!project.test(sourceProject||'')||!project.test(ledgerProject||'')||sourceProject===ledgerProject||ledgerDb?.projectId!==ledgerProject||!ledgerDb?.collection||!ledgerDb?.runTransaction||!restore.test(restoreId||'')||!Number.isInteger(readTimeoutMs)||readTimeoutMs<1||readTimeoutMs>30000)throw Error('RESTORE_GATE_CONFIGURATION_REQUIRED');
  if(typeof publicKey!=='string'||!/^-----BEGIN PUBLIC KEY-----\n/.test(publicKey))throw Error('RESTORE_GATE_PUBLIC_KEY_INVALID');
  let key;try{key=crypto.createPublicKey(publicKey);}catch{throw Error('RESTORE_GATE_PUBLIC_KEY_INVALID');}
  if(key.asymmetricKeyType!=='ed25519')throw Error('RESTORE_GATE_PUBLIC_KEY_INVALID');
  const control=ledgerDb.collection('restore_control').doc('serving');
  const entries=ledgerDb.collection('deletion_ledger');
  const head=ledgerDb.collection('deletion_ledger_meta').doc(sourceProject);
  // The same transactional check is used both by the request gate and by the
  // health monitor. Never infer readiness solely from an expiry timestamp.
  async function inspect(){
    let timer;
    try{
      const reading=ledgerDb.runTransaction(async tx=>{
      const snap=await tx.get(control);if(!snap.exists)return {available:false};
      const v=snap.data(), t=now();
      if(!v||v.sourceProject!==sourceProject||v.ledgerProject!==ledgerProject||v.restoreId!==restoreId||v.state!=='cleared'||!hash.test(v.checkpoint||'')||!Number.isSafeInteger(v.ledgerRevision)||v.ledgerRevision<0||!Number.isSafeInteger(v.issuedAt)||!Number.isSafeInteger(v.expiresAt)||!Number.isFinite(t)||v.issuedAt>t+30000||v.expiresAt<=t||v.expiresAt<=v.issuedAt||v.expiresAt-v.issuedAt>600000||!b64.test(v.signature||''))return {available:false};
      if(!crypto.verify(null,message(v),key,Buffer.from(v.signature,'base64url')))return {available:false};
      const actualHead=await tx.get(head);if(!actualHead.exists||actualHead.data()?.revision!==v.ledgerRevision)return {available:false};
      // Pending intents make it unsafe to serve a restored snapshot. Query
      // failure or missing permission is a closed gate, never a soft warning.
      const pending=await tx.get(entries.where('state','==','pending').limit(1));
      return pending.empty===true?{available:true,expiresAt:v.expiresAt,issuedAt:v.issuedAt}:{available:false};
      },{readOnly:true});
      const value=await Promise.race([reading,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('RESTORE_READ_TIMEOUT')),readTimeoutMs);})]);
      // The proof can expire while the ledger transaction is in flight.
      // Check again after the read, before the middleware can allow a request.
      const finished=now();if(value?.available!==true||!Number.isFinite(finished)||value.issuedAt>finished+30000||value.expiresAt<=finished)return {available:false};
      return {available:true,remainingMs:value.expiresAt-finished};
    }catch{return {available:false};}finally{clearTimeout(timer);}
  }
  async function verify(){return (await inspect()).available===true;}
  async function middleware(req,res,next){
    res.setHeader('Cache-Control','no-store');
    if(await verify())return next();
    res.statusCode=503;res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({status:'unavailable'}));
  }
  return {inspect,verify,middleware};
}
// No gate bypass or evidence is cached. Renewal invokes a separate issuer
// that must independently verify proof, isolation, revision and KMS signature.
// Monitor and renewal contain no customer data, receipt IDs or token logging.
function startRestoreHealthMonitor(gate,{report=code=>console.warn(code),renew=null,intervalMs=60000,warningMs=120000,clock=()=>Date.now(),setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}){
  if(typeof gate?.inspect!=='function'||typeof report!=='function'||(renew!==null&&typeof renew!=='function')||typeof clock!=='function'||!Number.isInteger(intervalMs)||intervalMs<10000||!Number.isInteger(warningMs)||warningMs<intervalMs)throw Error('INVALID_HEALTH_MONITOR');
  let running=null,failures=0,nextAttempt=0,nextInspect=0;
  const lastReport=new Map();
  function note(code){
    let now;try{now=clock();}catch{now=Date.now();}if(!Number.isFinite(now))now=Date.now();
    const last=lastReport.get(code);if(Number.isFinite(last)&&now>=last&&now-last<intervalMs)return;
    lastReport.set(code,now);try{report(code);}catch{}
  }
  async function check(){
    // Share the bounded in-flight check so concurrent requests can use a
    // freshly renewed proof. Every request still runs the gate separately.
    if(running)return running;
    // Gate middleware independently revalidates every request. Throttle only
    // the advisory monitor reads, not that mandatory authorization check.
    let started;try{started=clock();}catch{return note('RESTORE_GATE_UNAVAILABLE');}if(!Number.isFinite(started))return note('RESTORE_GATE_UNAVAILABLE');
    if(started<nextInspect)return;nextInspect=started+Math.min(intervalMs,10000);
    running=(async()=>{try{
      let state=await gate.inspect();
      const healthy=s=>s?.available===true&&Number.isFinite(s.remainingMs)&&s.remainingMs>warningMs;
      if(healthy(state)){failures=0;nextAttempt=0;return;}
      const at=clock();if(!Number.isFinite(at))throw Error('INVALID_CLOCK');
      if(renew&&at>=nextAttempt){
        try{
          const result=await renew();
          if(result==='busy'){nextAttempt=at+intervalMs;note('RESTORE_GATE_RENEWAL_IN_PROGRESS');}
          else{
            state=await gate.inspect();
            if(healthy(state)){failures=0;nextAttempt=0;return;}
            throw Error('RENEWAL_NOT_VERIFIED');
          }
        }catch{
          failures=Math.min(failures+1,4);
          // Limit retry pressure but avoid extending an outage for many minutes
          // once independent issuance recovers.
          nextAttempt=at+Math.min(intervalMs*(2**(failures-1)),Math.max(intervalMs,120000));
          note('RESTORE_GATE_RENEWAL_FAILED');
        }
      }
      if(state?.available!==true||!Number.isFinite(state.remainingMs)||state.remainingMs<=0)note('RESTORE_GATE_UNAVAILABLE');
      else note('RESTORE_GATE_EXPIRING');
    }catch{note('RESTORE_GATE_UNAVAILABLE');}})();
    try{return await running;}finally{running=null;}
  }
  const timer=setIntervalFn(()=>{void check();},intervalMs);
  if(typeof timer?.unref==='function')timer.unref();
  void check();
  return {check,stop:()=>clearIntervalFn(timer)};
}
module.exports={createRestoreGate,startRestoreHealthMonitor,message};
