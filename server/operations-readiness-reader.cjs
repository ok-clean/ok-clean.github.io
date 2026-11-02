'use strict';
// Read-only normalized evidence adapter. Providers are trusted, separately reviewed
// SDK integrations, never HTTP request inputs. No provider is wired in production.
const {restrictedAppCheck}=require('./app-check-policy.cjs');
const crypto=require('node:crypto');
const copy=x=>structuredClone(x);
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Error(code);};
function createOperationsReadinessReader({provider,auth,appCheck,expected,clock=Date.now,timeoutMs=5000,mode='synthetic'}={}){
 if(!provider||!['readRevision','readInventory','readEffectiveIam','readAppCheck','readDatabasePolicy'].every(k=>typeof provider[k]==='function')||typeof auth?.verifyIdToken!=='function'||typeof clock!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!['synthetic','live-readonly'].includes(mode))fail('READINESS_CONFIGURATION_REQUIRED');
 const e=copy(expected);
 if(!e||typeof e.project!=='string'||!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(e.project)||!/^1:[0-9]+:web:[a-fA-F0-9]+$/.test(e.appId||'')||!Array.isArray(e.databases)||e.databases.length!==2||e.databases.some(d=>! /^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/.test(d.id||'')||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(d.uid||''))||new Set(e.databases.map(d=>d.uid)).size!==2||!Array.isArray(e.authorities)||e.authorities.length!==3||new Set(e.authorities.map(a=>a.principal)).size!==3||e.authorities.some(a=>!a.principal||!Array.isArray(a.permissions)||!a.permissions.length||a.permissions.some(p=>!p.resource||!p.permission||p.permission.includes('*'))))fail('READINESS_EXPECTATIONS_REQUIRED');
 const check=restrictedAppCheck(appCheck,e.appId);
 async function inspect({idToken,appCheckToken}={}){
  let timer,active=true;const started=clock();
  const alive=()=>{const t=clock();if(!active||!Number.isSafeInteger(t)||t<started||t-started>=timeoutMs)fail('READINESS_TIMEOUT');return t;};
  const denied=code=>({checked:false,mode,productionVerified:false,deployAllowed:false,errors:[code]});
  try{
   if(!Number.isSafeInteger(started))return denied('READINESS_CLOCK_INVALID');
   return await Promise.race([(async()=>{
    if(typeof idToken!=='string'||!idToken||typeof appCheckToken!=='string'||!appCheckToken)fail('READINESS_AUTH_REQUIRED');
    const claims=await auth.verifyIdToken(idToken,true);alive();
    if(!claims?.uid||claims.operations_auditor!==true||!Number.isFinite(claims.exp)||claims.exp*1000<=clock()||claims.aud!==e.project||claims.iss!=='https://securetoken.google.com/'+e.project)fail('READINESS_AUTH_REQUIRED');
    const app=await check.verifyToken(appCheckToken);alive();
    if(!Number.isFinite(app.token?.exp)||app.token.exp*1000<=clock())fail('READINESS_APPCHECK_REQUIRED');
    const rev=await provider.readRevision(e.project);alive();
    if(typeof rev!=='string'||!rev||rev.length>256)fail('READINESS_REVISION_REQUIRED');
    const [inventory,iam,appPolicy,dbPolicy]=await Promise.all([provider.readInventory(e.project),provider.readEffectiveIam(e.project),provider.readAppCheck(e.project,e.appId),provider.readDatabasePolicy(e.project)]);alive();
    const errors=[];const need=(ok,code)=>{if(!ok)errors.push(code);};
    const snapshots=[inventory,iam,appPolicy,dbPolicy];
    for(const v of snapshots)need(v?.project===e.project&&v.revision===rev&&Number.isSafeInteger(v.observedAt)&&v.observedAt>=started&&v.observedAt<=clock(),'EVIDENCE_BINDING_INVALID');
    need(inventory?.appId===e.appId&&Array.isArray(inventory.databases)&&inventory.databases.length===2&&e.databases.every(d=>inventory.databases.some(x=>x.id===d.id&&x.uid===d.uid)),'RESOURCE_IDENTITY_MISMATCH');
    // Absence of an explicit forbidden role is insufficient. Require a resolved,
    // complete effective permission expansion (including impersonation/inheritance).
    need(iam?.complete===true&&iam.inheritanceResolved===true&&iam.groupsResolved===true&&iam.impersonationResolved===true&&iam.conditionsResolved===true,'EFFECTIVE_IAM_INCOMPLETE');
    need(Array.isArray(iam?.principals)&&iam.principals.length===e.authorities.length,'IAM_PRINCIPAL_MISMATCH');
    for(const a of e.authorities){
     const matches=iam?.principals?.filter(x=>x.principal===a.principal)||[];
     const perms=matches[0]?.permissions;
     const canonical=xs=>xs.map(p=>JSON.stringify([p.resource,p.permission])).sort();
     need(matches.length===1&&Array.isArray(perms)&&perms.every(p=>typeof p.resource==='string'&&typeof p.permission==='string')&&JSON.stringify(canonical(perms))===JSON.stringify(canonical(a.permissions)),'IAM_PERMISSION_MISMATCH');
    }
    need(appPolicy?.appId===e.appId&&appPolicy.enforced===true&&appPolicy.debugTokenCount===0&&appPolicy.unknownProviders===0,'APPCHECK_POLICY_UNVERIFIED');
    need(dbPolicy?.directClientWrites===false&&dbPolicy.adminSdkWritersEnumerated===true&&dbPolicy.unknownWriters===0&&dbPolicy.rulesReviewed===true,'DATABASE_WRITE_POLICY_UNVERIFIED');
    const finalRev=await provider.readRevision(e.project);alive();
    need(finalRev===rev,'READINESS_EVIDENCE_CHANGED');
    // Recheck revocation at completion. No credentials appear in returned evidence.
    const finalClaims=await auth.verifyIdToken(idToken,true);alive();
    const finalApp=await check.verifyToken(appCheckToken);alive();
    need(Number.isFinite(finalApp.token?.exp)&&finalApp.token.exp*1000>clock(),'READINESS_APPCHECK_CHANGED');
    need(finalClaims?.uid===claims.uid&&finalClaims.operations_auditor===true&&finalClaims.exp*1000>clock()&&finalClaims.aud===e.project&&finalClaims.iss===claims.iss,'READINESS_AUTH_CHANGED');
    return {checked:errors.length===0,mode,productionVerified:false,deployAllowed:false,errors:[...new Set(errors)],evidenceHash:hash(snapshots),checks:['resource-identities','effective-iam','app-check','database-writers'],remaining:['EXTERNAL_FENCE_WORM_ATTESTATION','LIVE_ADAPTER_INTEGRATION','POLICY_AND_DEPLOYMENT_APPROVAL']};
   })(),new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;reject(Error('READINESS_TIMEOUT'));},timeoutMs);})]);
  }catch(err){return denied(['READINESS_TIMEOUT','READINESS_AUTH_REQUIRED','READINESS_APPCHECK_REQUIRED','READINESS_REVISION_REQUIRED'].includes(err?.message)?err.message:'READINESS_READ_FAILED');}finally{active=false;clearTimeout(timer);}
 }
 return Object.freeze({inspect});
}
module.exports={createOperationsReadinessReader};
