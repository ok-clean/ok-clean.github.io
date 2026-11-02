'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createOperationsReadinessReader}=require('../server/operations-readiness-reader.cjs');
function fixture(){
 const t=100000,project='sample-source',appId='1:123:web:abcd';
 const expected={project,appId,databases:[{id:'source',uid:'11111111-1111-4111-8111-111111111111'},{id:'restore',uid:'22222222-2222-4222-8222-222222222222'}],authorities:['control','validator','issuer'].map(principal=>({principal,permissions:[{resource:'keys/'+principal,permission:'sign'}]}))};
 const common={project,revision:'revision-1',observedAt:t};
 const data={inventory:{...common,appId,databases:expected.databases},iam:{...common,complete:true,inheritanceResolved:true,groupsResolved:true,impersonationResolved:true,conditionsResolved:true,principals:structuredClone(expected.authorities)},app:{...common,appId,enforced:true,debugTokenCount:0,unknownProviders:0},db:{...common,directClientWrites:false,adminSdkWritersEnumerated:true,unknownWriters:0,rulesReviewed:true}};
 const calls=[];const provider={readRevision:async()=> 'revision-1',readInventory:async()=>data.inventory,readEffectiveIam:async()=>data.iam,readAppCheck:async()=>data.app,readDatabasePolicy:async()=>data.db};
 const auth={verifyIdToken:async(token,revoked)=>{calls.push({revoked});return {uid:'auditor',operations_auditor:true,exp:200,aud:project,iss:'https://securetoken.google.com/'+project};}};
 const appCheck={verifyToken:async()=>({appId,token:{exp:200}})};
 const config={provider,auth,appCheck,expected,clock:()=>t};
 return {config,data,calls,request:{idToken:'synthetic-secret-auth',appCheckToken:'synthetic-secret-app'}};
}
test('complete synthetic evidence remains non-deployable and revocation is checked twice',async()=>{const f=fixture(),r=await createOperationsReadinessReader(f.config).inspect(f.request);assert.equal(r.checked,true);assert.equal(r.productionVerified,false);assert.equal(r.deployAllowed,false);assert.deepEqual(f.calls,[{revoked:true},{revoked:true}]);assert.ok(!JSON.stringify(r).includes('synthetic-secret'));});
for(const [name,change,code] of [
 ['DB replaced',f=>f.data.inventory.databases=[{id:'source',uid:'different'}],'RESOURCE_IDENTITY_MISMATCH'],
 ['inherited grants missing',f=>f.data.iam.inheritanceResolved=false,'EFFECTIVE_IAM_INCOMPLETE'],
 ['impersonation unknown',f=>f.data.iam.impersonationResolved=false,'EFFECTIVE_IAM_INCOMPLETE'],
 ['extra permission',f=>f.data.iam.principals[0].permissions.push({resource:'*',permission:'owner'}),'IAM_PERMISSION_MISMATCH'],
 ['missing permission',f=>f.data.iam.principals[0].permissions=[],'IAM_PERMISSION_MISMATCH'],
 ['unexpected principal',f=>f.data.iam.principals.push({principal:'external',permissions:[]}),'IAM_PRINCIPAL_MISMATCH'],
 ['debug appcheck',f=>f.data.app.debugTokenCount=1,'APPCHECK_POLICY_UNVERIFIED'],
 ['appcheck unenforced',f=>f.data.app.enforced=false,'APPCHECK_POLICY_UNVERIFIED'],
 ['direct client writes',f=>f.data.db.directClientWrites=true,'DATABASE_WRITE_POLICY_UNVERIFIED'],
 ['unknown admin writer',f=>f.data.db.unknownWriters=1,'DATABASE_WRITE_POLICY_UNVERIFIED'],
 ['stale snapshot',f=>f.data.iam.observedAt=0,'EVIDENCE_BINDING_INVALID'],
 ['wrong project',f=>f.data.db.project='other','EVIDENCE_BINDING_INVALID']
])test(name,async()=>{const f=fixture();change(f);const r=await createOperationsReadinessReader(f.config).inspect(f.request);assert.equal(r.checked,false);assert.ok(r.errors.includes(code));});
test('missing auth and expired appcheck refuse before resource reads',async()=>{const f=fixture();let reads=0;f.config.provider.readRevision=async()=>{reads++;return 'revision-1';};let a=createOperationsReadinessReader(f.config);assert.equal((await a.inspect({})).checked,false);f.config.appCheck.verifyToken=async()=>({appId:f.config.expected.appId,token:{exp:1}});a=createOperationsReadinessReader(f.config);assert.equal((await a.inspect(f.request)).checked,false);assert.equal(reads,0);});
test('forged token SDK rejection and error secrets never returned',async()=>{const f=fixture();f.config.auth.verifyIdToken=async()=>{throw Error('synthetic-secret-auth');};const r=await createOperationsReadinessReader(f.config).inspect(f.request);assert.equal(r.checked,false);assert.ok(!JSON.stringify(r).includes('synthetic-secret'));});
test('revision changes and administrator revoked while reading are blocked',async()=>{const f=fixture();let n=0;f.config.provider.readRevision=async()=>++n===1?'revision-1':'revision-2';f.config.auth.verifyIdToken=async()=>({uid:'auditor',operations_auditor:++n<3,exp:200,aud:f.config.expected.project,iss:'https://securetoken.google.com/'+f.config.expected.project});assert.equal((await createOperationsReadinessReader(f.config).inspect(f.request)).checked,false);});
test('hanging provider timeout fails closed',async()=>{const f=fixture();f.config.timeoutMs=5;f.config.provider.readRevision=()=>new Promise(()=>{});const r=await createOperationsReadinessReader(f.config).inspect(f.request);assert.deepEqual(r.errors,['READINESS_TIMEOUT']);});
test('missing provider and unresolved permission patterns cannot construct',()=>{assert.throws(()=>createOperationsReadinessReader(),/CONFIGURATION/);const f=fixture();f.config.expected.authorities[0].permissions[0].permission='*';assert.throws(()=>createOperationsReadinessReader(f.config),/EXPECTATIONS/);});
test('stable auth with changed revision is rejected specifically',async()=>{const f=fixture();let n=0;f.config.provider.readRevision=async()=>++n===1?'revision-1':'revision-2';const r=await createOperationsReadinessReader(f.config).inspect(f.request);assert.ok(r.errors.includes('READINESS_EVIDENCE_CHANGED'));});
test('auditor claim removed at completion is rejected specifically',async()=>{const f=fixture();const original=f.config.auth.verifyIdToken;let n=0;f.config.auth.verifyIdToken=async(...args)=>({...await original(...args),operations_auditor:++n===1});const r=await createOperationsReadinessReader(f.config).inspect(f.request);assert.ok(r.errors.includes('READINESS_AUTH_CHANGED'));});
test('App Check expires during read and is reverified at completion',async()=>{const f=fixture();let n=0;f.config.appCheck.verifyToken=async()=>({appId:f.config.expected.appId,token:{exp:++n===1?200:1}});const r=await createOperationsReadinessReader(f.config).inspect(f.request);assert.ok(r.errors.includes('READINESS_APPCHECK_CHANGED'));});
