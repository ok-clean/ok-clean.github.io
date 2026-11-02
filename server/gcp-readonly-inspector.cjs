'use strict';
// Real google-auth-library REST transport, read operations only (getIamPolicy is
// POST but does not mutate). Project policy alone cannot prove effective IAM.
const crypto=require('node:crypto');
function createGcpReadOnlyInspector({auth,projectId,projectNumber,appId,databases,serviceAccounts,allowedProjectRoles,timeoutMs=5000,clock=Date.now}={}){
 const project=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
 if(typeof auth?.getClient!=='function'||!project.test(projectId||'')||! /^[1-9][0-9]{4,20}$/.test(projectNumber||'')||!new RegExp('^1:'+projectNumber+':web:[a-fA-F0-9]+$').test(appId||'')||!Array.isArray(databases)||databases.length!==2||new Set(databases.map(d=>d.id)).size!==2||new Set(databases.map(d=>d.uid)).size!==2||databases.some(d=>! /^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/.test(d.id||'')||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(d.uid||''))||!Array.isArray(serviceAccounts)||serviceAccounts.length!==3||new Set(serviceAccounts).size!==3||serviceAccounts.some(a=>! /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(a))||!allowedProjectRoles||serviceAccounts.some(a=>!Array.isArray(allowedProjectRoles[a])||allowedProjectRoles[a].some(r=>! /^(roles\/[A-Za-z0-9_.]+|projects\/[a-z0-9-]+\/roles\/[A-Za-z0-9_]+)$/.test(r)))||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||typeof clock!=='function')throw Error('GCP_READ_CONFIGURATION_REQUIRED');
 const expected=structuredClone({databases,serviceAccounts,allowedProjectRoles});
 async function inspect(){
  const abort=new AbortController();let timer;
  try{return await Promise.race([(async()=>{
   const client=await auth.getClient();
   const request=async(url,method='GET',data)=>{if(abort.signal.aborted)throw Error();const r=await client.request({url,method,...(data?{data}:{}),timeout:timeoutMs,signal:abort.signal,maxRedirects:0,redirect:'error',retry:false,maxContentLength:262144});if(!r?.data||abort.signal.aborted)throw Error();return r.data;};
   const projectName='projects/'+projectNumber,appName=projectName+'/apps/'+appId;
   const [projectInfo,web,policy,service,dbs]=await Promise.all([
    request('https://cloudresourcemanager.googleapis.com/v3/'+projectName),
    request('https://firebase.googleapis.com/v1beta1/projects/'+projectId+'/webApps/'+encodeURIComponent(appId)),
    request('https://cloudresourcemanager.googleapis.com/v3/'+projectName+':getIamPolicy','POST',{options:{requestedPolicyVersion:3}}),
    request('https://firebaseappcheck.googleapis.com/v1/'+projectName+'/services/firestore.googleapis.com'),
    Promise.all(expected.databases.map(d=>request('https://firestore.googleapis.com/v1/projects/'+projectId+'/databases/'+encodeURIComponent(d.id))))
   ]);
   let debugCount=0,pageToken='',pages=0;const seen=new Set();
   do{if(++pages>10)throw Error();const q='?pageSize=20'+(pageToken?'&pageToken='+encodeURIComponent(pageToken):'');const result=await request('https://firebaseappcheck.googleapis.com/v1/'+appName+'/debugTokens'+q);if(result.debugTokens!==undefined&&!Array.isArray(result.debugTokens))throw Error();debugCount+=(result.debugTokens||[]).length;pageToken=result.nextPageToken||'';if(typeof pageToken!=='string'||pageToken.length>4096||pageToken&&seen.has(pageToken))throw Error();seen.add(pageToken);}while(pageToken);
   const errors=[];const need=(ok,c)=>{if(!ok)errors.push(c);};
   need(projectInfo.name===projectName&&projectInfo.projectId===projectId&&projectInfo.state==='ACTIVE','GCP_PROJECT_MISMATCH');
   need(web.appId===appId&&web.projectId===projectId&&web.state==='ACTIVE','GCP_WEB_APP_MISMATCH');
   need(dbs.every((d,i)=>d.name==='projects/'+projectId+'/databases/'+expected.databases[i].id&&d.uid===expected.databases[i].uid),'GCP_DATABASE_MISMATCH');
   need(service.name===projectName+'/services/firestore.googleapis.com'&&service.enforcementMode==='ENFORCED','GCP_APPCHECK_NOT_ENFORCED');
   need(debugCount===0,'GCP_DEBUG_TOKENS_PRESENT');
   need(typeof policy.etag==='string'&&!!policy.etag&&Array.isArray(policy.bindings)&&[1,3].includes(policy.version||1),'GCP_IAM_POLICY_INVALID');
   const bindings=policy.bindings||[];
   need(bindings.every(b=>Array.isArray(b.members)&&!b.members.some(m=>['allUsers','allAuthenticatedUsers'].includes(m))),'GCP_PUBLIC_IAM_BINDING');
   for(const a of expected.serviceAccounts){const found=bindings.filter(b=>b.members?.includes('serviceAccount:'+a));const roles=found.map(b=>b.role).sort();need(!found.some(b=>b.condition)&&JSON.stringify(roles)===JSON.stringify([...expected.allowedProjectRoles[a]].sort())&&!roles.some(r=>['roles/owner','roles/editor'].includes(r)),'GCP_PROJECT_ROLE_MISMATCH');}
   const observedAt=clock();if(!Number.isSafeInteger(observedAt))throw Error();
   // No raw IAM member list, etag, token, URL or error body is returned/logged.
   const evidenceHash=crypto.createHash('sha256').update(JSON.stringify([projectInfo,web,policy,service,dbs,debugCount])).digest('hex');
   return {metadataChecksPassed:errors.length===0,observedAt,evidenceHash,errors:[...new Set(errors)],project:projectId,appId,databases:expected.databases,debugTokenCount:debugCount,effectiveIamComplete:false,customBackendEnforcementVerified:false,productionVerified:false,deployAllowed:false,blockers:['INHERITED_RESOURCE_GROUP_CONDITIONAL_IAM_UNRESOLVED','IMPERSONATION_AND_DENY_POLICY_UNRESOLVED','CUSTOM_BACKEND_APPCHECK_DEPLOYMENT_UNVERIFIED','EXTERNAL_FENCE_WORM_UNVERIFIED']};
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(Error());},timeoutMs);})]);}
  catch{throw Error('GCP_READ_UNAVAILABLE');}finally{clearTimeout(timer);abort.abort();}
 }
 return Object.freeze({inspect});
}
module.exports={createGcpReadOnlyInspector};
