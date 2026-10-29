'use strict';
const {randomUUID}=require('node:crypto');

// Only an explicit Cloud Run issuer origin is allowed; no credentials, query,
// path or arbitrary destination can be supplied via configuration.
function parseIssuerOrigin(value){
  try{
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!/^[-a-z0-9]+(?:\.[-a-z0-9]+)*\.run\.app$/.test(u.hostname)||value!==u.origin)return null;
    return u.origin;
  }catch{return null;}
}
function createRestoreRenewer({controlDb,controlProjectId,sourceProjectId,ledgerProjectId,issuerOrigin,createClient,clock=()=>Date.now(),newId=randomUUID,controlTimeoutMs=5000,credentialTimeoutMs=8000,requestTimeoutMs=15000}){
  const origin=parseIssuerOrigin(issuerOrigin);
  if(!origin||typeof controlProjectId!=='string'||!sourceProjectId||!ledgerProjectId||new Set([controlProjectId,sourceProjectId,ledgerProjectId]).size!==3||controlDb?.projectId!==controlProjectId||!controlDb?.collection||!controlDb?.runTransaction||typeof createClient!=='function'||!Number.isInteger(controlTimeoutMs)||controlTimeoutMs<1||controlTimeoutMs>30000||!Number.isInteger(credentialTimeoutMs)||credentialTimeoutMs<1||credentialTimeoutMs>30000||!Number.isInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>30000)throw Error('RESTORE_RENEWAL_CONFIGURATION_INVALID');
  // Kept outside both source and ledger. Never write to a restored source just
  // to attempt recovery while the source is isolated.
  const lease=controlDb.collection('restore_renewal').doc('lease'),leaseMs=90000;
  const millis=x=>x instanceof Date?x.getTime():typeof x?.toDate==='function'?x.toDate().getTime():0;
  const time=()=>{const n=clock();if(!Number.isFinite(n))throw Error('INVALID_CLOCK');return n;};
  async function bounded(fn,ms,abort){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>{if(abort)abort.abort();reject(Error('RENEWAL_TIMEOUT'));},ms);})]);}finally{clearTimeout(timer);}}
  return async function renew(){
    const owner=newId();if(typeof owner!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(owner))throw Error('INVALID_LEASE_ID');
    const acquired=await bounded(()=>controlDb.runTransaction(async tx=>{
      const snap=await tx.get(lease),v=snap.exists?snap.data():null,now=time();
      if(snap.exists&&!(v?.owner===null&&v?.expiresAt===null)){
        const expiry=millis(v?.expiresAt);
        if(typeof v?.owner!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(v.owner)||!Number.isFinite(expiry)||expiry<=0)throw Error('CORRUPT_LEASE');
        if(expiry>now)return false;
      }
      tx.set(lease,{owner,expiresAt:new Date(now+leaseMs)});return true;
    }),controlTimeoutMs);
    if(!acquired)return 'busy';
    try{
      // Credential acquisition may be slow. Recheck before the external call;
      // the issuer transaction also prevents an older response overwriting a
      // newer signed certificate if an invocation stalls after this check.
      const client=await bounded(()=>createClient(origin),credentialTimeoutMs);
      if(!client||typeof client.request!=='function')throw Error('ISSUER_CLIENT_UNAVAILABLE');
      const stillOwner=await bounded(()=>controlDb.runTransaction(async tx=>{const snap=await tx.get(lease),v=snap.data();return snap.exists&&v?.owner===owner&&millis(v.expiresAt)>time();}),controlTimeoutMs);
      if(!stillOwner)throw Error('RENEWAL_LEASE_LOST');
      const controller=new AbortController();
      const response=await bounded(()=>client.request({url:origin+'/_internal/restore/issue',method:'POST',data:{},timeout:requestTimeoutMs,maxRedirects:0,signal:controller.signal}),requestTimeoutMs,controller);
      if(response?.status!==200||response?.data?.status!=='issued')throw Error('ISSUER_REJECTED');
      return 'issued';
    }finally{
      // Do not erase another instance's lease or log the request/response.
      try{await bounded(()=>controlDb.runTransaction(async tx=>{const snap=await tx.get(lease);if(snap.exists&&snap.data()?.owner===owner)tx.set(lease,{owner:null,expiresAt:null});}),controlTimeoutMs);}catch{}
    }
  };
}
module.exports={parseIssuerOrigin,createRestoreRenewer};
