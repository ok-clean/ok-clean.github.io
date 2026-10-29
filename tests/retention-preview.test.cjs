'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createRetentionService}=require('../server/retention.cjs');
const {createRetentionPreviewHandler,attachRetentionPreview}=require('../server/retention-scheduler.cjs');
const cfg={enabled:true,reviewed:true,projectId:'production-source',controlProjectId:'production-control',ledgerProjectId:'production-ledger',audience:'https://service.example.test/_internal/retention/preview',serviceAccount:'scheduler@production-source.iam.gserviceaccount.com',policyVersion:'policy-v1',reservationDays:30,historyDays:90};
const claims={aud:cfg.audience,iss:'https://accounts.google.com',email:cfg.serviceAccount,email_verified:true};
function fixture({config={},verify=async()=>claims,scan,process:proc}={}){
 const rows=new Map();let q=Promise.resolve(),serial=0;
 const controlDb={projectId:'production-control',collection:name=>({doc:id=>({key:name+'/'+id})}),runTransaction:fn=>{const p=q.then(()=>fn({get:async r=>({exists:rows.has(r.key),data:()=>rows.get(r.key)}),set:(r,v)=>rows.set(r.key,v),create:(r,v)=>{if(rows.has(r.key))throw Error('exists');rows.set(r.key,v)}}));q=p.catch(()=>{});return p;}};
 const db={projectId:'production-source',collection(){throw Error('unexpected write/read')}};
 const service={schedulerSafety:{projectId:cfg.projectId,previewOnly:true,reservationDays:30,historyDays:90},scan:scan|| (async()=>({ids:['receipt_private'],next:null})),process:proc|| (async(id,opts)=>{assert.equal(opts,undefined);return {result:'would_redact'};})};
 const h=createRetentionPreviewHandler({db,controlDb,service,verifyOidc:verify,config:{...cfg,...config},clock:()=>new Date('2030-01-01T00:00:00Z'),newId:()=>`run-${++serial}`});
 async function call(auth='Bearer fake',method='POST'){const r={code:null,body:null,set(){return this},status(c){this.code=c;return this},json(b){this.body=b;return this}};await h({method,headers:{authorization:auth}},r);return r;}
 return {rows,call,service};
}
test('no policy or project mismatch means no preview access',async()=>{for(const config of [{enabled:false},{reviewed:false},{reservationDays:0},{reservationDays:31},{controlProjectId:'production-source'},{controlProjectId:'production-ledger'},{ledgerProjectId:''},{policyVersion:''},{audience:'http://service.test/a'},{serviceAccount:'x@example.test'}]){let called=false;const x=fixture({config,scan:async()=>{called=true;throw Error()}});assert.equal((await x.call()).code,503);assert.equal(called,false);}});
test('exact signed OIDC identity and audience required before scanning',async()=>{for(const verify of [async()=>{throw Error('signature')},async()=>({...claims,aud:'wrong'}),async()=>({...claims,iss:'invalid'}),async()=>({...claims,email_verified:false}),async()=>({...claims,email:'other@production-source.iam.gserviceaccount.com'})])assert.equal((await fixture({verify}).call()).code,401);assert.equal((await fixture().call('','POST')).code,401);assert.equal((await fixture().call('Bearer test','GET')).code,405);});
test('preview returns counts only and checkpoints in separate control project',async()=>{const f=fixture({scan:async()=>({ids:['receipt_private'],next:'receipt_private'})});const r=await f.call();assert.deepEqual(r.body,{status:'completed',hasMore:true,counts:{would_redact:1}});assert.doesNotMatch(JSON.stringify(r.body),/receipt_private/);assert.equal(f.rows.get('retention_preview/control').cursor,'receipt_private');assert.doesNotMatch(JSON.stringify(f.rows.get('retention_preview_runs/run-1')),/receipt_private/);});
test('failed item records private hash and retries original page',async()=>{let calls=0;const f=fixture({process:async()=>++calls===1?{result:'retry_needed'}:{result:'would_redact'}});assert.equal((await f.call()).code,503);assert.equal(f.rows.get('retention_preview/control').cursor,null);const record=f.rows.get('retention_preview_runs/run-1');assert.match(record.failureDigest,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(record),/receipt_private/);assert.equal((await f.call()).code,200);});
test('concurrent previews cannot own the same lease',async()=>{let enter,release;const started=new Promise(r=>enter=r),wait=new Promise(r=>release=r);const f=fixture({scan:async()=>{enter();await wait;return {ids:[],next:null}}});const first=f.call();await started;assert.equal((await f.call()).code,409);release();assert.equal((await first).code,200);});
test('production preview service refuses all destructive operation',async()=>{const env=process.env,previous={OKCLEAN_PROJECT_ID:env.OKCLEAN_PROJECT_ID,FIRESTORE_EMULATOR_HOST:env.FIRESTORE_EMULATOR_HOST,FIREBASE_AUTH_EMULATOR_HOST:env.FIREBASE_AUTH_EMULATOR_HOST};try{env.OKCLEAN_PROJECT_ID='production-source';delete env.FIRESTORE_EMULATOR_HOST;delete env.FIREBASE_AUTH_EMULATOR_HOST;const db={projectId:'production-source',collection:()=>{throw Error('must not access')},runTransaction:async()=>{throw Error('must not access')}};const service=createRetentionService({db,projectId:'production-source',policy:{reservationDays:30,historyDays:90},previewOnly:true,authorize:async()=>true});await assert.rejects(service.process('receipt',{apply:true}),/PREVIEW_READ_ONLY/);assert.throws(()=>createRetentionService({db,projectId:'other-project',policy:{reservationDays:30,historyDays:90},previewOnly:true}),/PREVIEW_PROJECT_MISMATCH/);env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8085';assert.throws(()=>createRetentionService({db,projectId:'production-source',policy:{reservationDays:30,historyDays:90},previewOnly:true}),/PREVIEW_PROJECT_MISMATCH/);}finally{for(const [k,v]of Object.entries(previous)){if(v===undefined)delete env[k];else env[k]=v;}}});
test('entry route is disabled by default',()=>{let mounted=false;assert.equal(attachRetentionPreview({app:{post(){mounted=true}},db:{},controlDb:{},env:{}}),false);assert.equal(mounted,false);});
test('enabled entrypoint uses production project and remains read-only',async()=>{
 const env=process.env, keys=['OKCLEAN_PROJECT_ID','OKCLEAN_LEDGER_PROJECT_ID','OKCLEAN_RETENTION_PREVIEW_ENABLED','OKCLEAN_RETENTION_POLICY_REVIEWED','OKCLEAN_RETENTION_CONTROL_PROJECT_ID','OKCLEAN_RETENTION_RESERVATION_DAYS','OKCLEAN_RETENTION_HISTORY_DAYS','OKCLEAN_RETENTION_PREVIEW_AUDIENCE','OKCLEAN_RETENTION_SCHEDULER_ACCOUNT','OKCLEAN_RETENTION_POLICY_VERSION','FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'];const prev=Object.fromEntries(keys.map(k=>[k,env[k]]));
 try{
  Object.assign(env,{OKCLEAN_PROJECT_ID:cfg.projectId,OKCLEAN_LEDGER_PROJECT_ID:cfg.ledgerProjectId,OKCLEAN_RETENTION_PREVIEW_ENABLED:'true',OKCLEAN_RETENTION_POLICY_REVIEWED:'true',OKCLEAN_RETENTION_CONTROL_PROJECT_ID:cfg.controlProjectId,OKCLEAN_RETENTION_RESERVATION_DAYS:'30',OKCLEAN_RETENTION_HISTORY_DAYS:'90',OKCLEAN_RETENTION_PREVIEW_AUDIENCE:cfg.audience,OKCLEAN_RETENTION_SCHEDULER_ACCOUNT:cfg.serviceAccount,OKCLEAN_RETENTION_POLICY_VERSION:cfg.policyVersion});delete env.FIRESTORE_EMULATOR_HOST;delete env.FIREBASE_AUTH_EMULATOR_HOST;
  const db={projectId:cfg.projectId,collection:()=>({}),runTransaction:async()=>{throw Error('unexpected')}};const controlDb={projectId:cfg.controlProjectId,collection:()=>({doc:()=>({})}),runTransaction:async()=>{throw Error('unexpected')}};let route;
  assert.equal(attachRetentionPreview({app:{post(path,handler){assert.equal(path,'/_internal/retention/preview');route=handler;}},db,controlDb,verifyOidc:async()=>claims}),true);assert.equal(typeof route,'function');
 }finally{for(const [k,v]of Object.entries(prev)){if(v===undefined)delete env[k];else env[k]=v;}}
});
test('preview service runtime requires three distinct real projects and separated service identities',()=>{
 const {validateRetentionPreviewRuntime}=require('../server/retention-scheduler.cjs');const {generateKeyPairSync}=require('node:crypto');const {publicKey}=generateKeyPairSync('ed25519');
 const env={NODE_ENV:'production',OKCLEAN_PROJECT_ID:cfg.projectId,GOOGLE_CLOUD_PROJECT:cfg.projectId,OKCLEAN_LEDGER_PROJECT_ID:cfg.ledgerProjectId,OKCLEAN_RETENTION_CONTROL_PROJECT_ID:cfg.controlProjectId,OKCLEAN_RETENTION_PREVIEW_ENABLED:'true',OKCLEAN_RETENTION_POLICY_REVIEWED:'true',OKCLEAN_RETENTION_RESERVATION_DAYS:'30',OKCLEAN_RETENTION_HISTORY_DAYS:'90',OKCLEAN_RETENTION_PREVIEW_AUDIENCE:'https://preview-service-abc.run.app/_internal/retention/preview',OKCLEAN_RETENTION_SCHEDULER_ACCOUNT:'scheduler@production-source.iam.gserviceaccount.com',OKCLEAN_RETENTION_PREVIEW_IDENTITY:'preview-worker@production-source.iam.gserviceaccount.com',OKCLEAN_RETENTION_POLICY_VERSION:'reviewed-v1',OKCLEAN_RESTORE_EPOCH:'synthetic-epoch-123456',OKCLEAN_RESTORE_PUBLIC_KEY:publicKey.export({type:'spki',format:'pem'})};assert.deepEqual(validateRetentionPreviewRuntime(env),[]);
 for(const patch of [{OKCLEAN_RETENTION_POLICY_REVIEWED:'false'},{OKCLEAN_RETENTION_RESERVATION_DAYS:''},{OKCLEAN_RETENTION_CONTROL_PROJECT_ID:cfg.ledgerProjectId},{OKCLEAN_RETENTION_PREVIEW_IDENTITY:env.OKCLEAN_RETENTION_SCHEDULER_ACCOUNT},{OKCLEAN_RETENTION_POLICY_VERSION:'test-v1'},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8085'},{GOOGLE_CLOUD_PROJECT:'wrong-project'},{OKCLEAN_RESTORE_PUBLIC_KEY:''},{OKCLEAN_FIRESTORE_DATABASE_ID:'../untrusted'}])assert.ok(validateRetentionPreviewRuntime({...env,...patch}).length);
});

test('corrupt preview lease cannot be reclaimed and fails closed',async()=>{
  for(const expiry of [new Date('invalid'),null,'invalid']){
    const f=fixture();f.rows.set('retention_preview/control',{owner:'other',expiresAt:expiry,cursor:null,policyVersion:cfg.policyVersion});
    assert.equal((await f.call()).code,503);
    assert.equal(f.rows.get('retention_preview/control').owner,'other');
  }
});
test('preview lease corruption during scan stops the worker before inspection',async()=>{
  let f,called=false;
  f=fixture({scan:async()=>{const key='retention_preview/control';f.rows.set(key,{...f.rows.get(key),expiresAt:new Date('invalid')});return {ids:['receipt_private'],next:null};},process:async()=>{called=true;return {result:'would_redact'};}});
  assert.equal((await f.call()).code,503);assert.equal(called,false);
});

test('preview rejects malformed or ambiguously released lease owner',async()=>{
  for(const state of [{owner:'',expiresAt:new Date('2030-01-01T00:01:00Z')},{owner:0,expiresAt:new Date('2030-01-01T00:01:00Z')},{expiresAt:new Date('2030-01-01T00:01:00Z')},{owner:null},{owner:null,expiresAt:new Date('2030-01-01T00:01:00Z')}]){
    const f=fixture();f.rows.set('retention_preview/control',{...state,cursor:null,policyVersion:cfg.policyVersion});assert.equal((await f.call()).code,503);
  }
});
