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
function createRestoreGate({ledgerDb,sourceProject,ledgerProject,restoreId,publicKey,now=()=>Date.now()}){
  if(!project.test(sourceProject||'')||!project.test(ledgerProject||'')||sourceProject===ledgerProject||ledgerDb?.projectId!==ledgerProject||!ledgerDb?.collection||!ledgerDb?.runTransaction||!restore.test(restoreId||''))throw Error('RESTORE_GATE_CONFIGURATION_REQUIRED');
  if(typeof publicKey!=='string'||!/^-----BEGIN PUBLIC KEY-----\n/.test(publicKey))throw Error('RESTORE_GATE_PUBLIC_KEY_INVALID');
  let key;try{key=crypto.createPublicKey(publicKey);}catch{throw Error('RESTORE_GATE_PUBLIC_KEY_INVALID');}
  if(key.asymmetricKeyType!=='ed25519')throw Error('RESTORE_GATE_PUBLIC_KEY_INVALID');
  const control=ledgerDb.collection('restore_control').doc('serving');
  const entries=ledgerDb.collection('deletion_ledger');
  const head=ledgerDb.collection('deletion_ledger_meta').doc(sourceProject);
  async function verify(){
    try{
      return await ledgerDb.runTransaction(async tx=>{
      const snap=await tx.get(control);if(!snap.exists)return false;
      const v=snap.data(), t=now();
      if(!v||v.sourceProject!==sourceProject||v.ledgerProject!==ledgerProject||v.restoreId!==restoreId||v.state!=='cleared'||!hash.test(v.checkpoint||'')||!Number.isSafeInteger(v.ledgerRevision)||v.ledgerRevision<0||!Number.isSafeInteger(v.issuedAt)||!Number.isSafeInteger(v.expiresAt)||!Number.isFinite(t)||v.issuedAt>t+30000||v.expiresAt<=t||v.expiresAt<=v.issuedAt||v.expiresAt-v.issuedAt>600000||!b64.test(v.signature||''))return false;
      if(!crypto.verify(null,message(v),key,Buffer.from(v.signature,'base64url')))return false;
      const actualHead=await tx.get(head);if(!actualHead.exists||actualHead.data()?.revision!==v.ledgerRevision)return false;
      // Pending intents make it unsafe to serve a restored snapshot. Query
      // failure or missing permission is a closed gate, never a soft warning.
      const pending=await tx.get(entries.where('state','==','pending').limit(1));
      return pending.empty===true;
      },{readOnly:true});
    }catch{return false;}
  }
  async function middleware(req,res,next){
    res.setHeader('Cache-Control','no-store');
    if(await verify())return next();
    res.statusCode=503;res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({status:'unavailable'}));
  }
  return {verify,middleware};
}
module.exports={createRestoreGate,message};
