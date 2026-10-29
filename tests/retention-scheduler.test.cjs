'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8085';process.env.GCLOUD_PROJECT='demo-okclean';
const {createScheduledRetentionHandler}=require('../server/retention-scheduler.cjs');
const config={enabled:true,reviewed:true,projectId:'demo-okclean',ledgerProjectId:'demo-independent-ledger',audience:'https://service.example.test/internal/retention',serviceAccount:'scheduler@demo-ok.iam.gserviceaccount.com',policyVersion:'reviewed-v1',reservationDays:30,historyDays:90};
const valid={aud:config.audience,iss:'https://accounts.google.com',email:config.serviceAccount,email_verified:true};
function fixture({conf={},verify=async()=>valid,process,scan,ledgerOverride,clock=()=>new Date('2030-01-01T00:00:00Z')}={}){
  const rows=new Map(),ledgerRows=new Map();let chain=Promise.resolve(),counter=0;
  const doc=key=>({key});
  const db={projectId:'demo-okclean',collection:name=>({doc:id=>doc(name+'/'+id)}),runTransaction:fn=>{const action=chain.then(()=>fn({get:async ref=>({exists:rows.has(ref.key),data:()=>rows.get(ref.key)}),set:(ref,value)=>rows.set(ref.key,value),create:(ref,value)=>{if(rows.has(ref.key))throw Error('EXISTS');rows.set(ref.key,value)}}));chain=action.catch(()=>{});return action;}};
  const service={schedulerSafety:{projectId:'demo-okclean',firestoreHost:'127.0.0.1:8085',reservationDays:30,historyDays:90},scan:scan|| (async()=>({ids:['synthetic'],next:null})),freeze:async(id,options)=>{assert.equal(await db.runTransaction(options.transactionFence),true);return {result:'frozen'};},process:async(id,options={})=>{if(!options.apply)return {result:'would_redact',version:'100:2',historyVersion:'a'.repeat(64)};if(process)return process(id,options);assert.equal(options.expectedAction,'redacted');assert.equal(await db.runTransaction(options.transactionFence),true);return {result:'redacted'};}};
  const ledger=ledgerOverride||{safety:{sourceProjectId:'demo-okclean',ledgerProjectId:'demo-independent-ledger'},assertNoPending:async()=>{if([...ledgerRows.values()].includes('pending'))throw Error('PENDING')},recordIntent:async input=>{ledgerRows.set(input.id,'pending');return 'pending';},markCommitted:async input=>{assert.equal(ledgerRows.get(input.id),'pending');ledgerRows.set(input.id,'committed');return 'committed';}};
  const handler=createScheduledRetentionHandler({db,service,ledger,verifyOidc:verify,config:{...config,...conf},clock,newId:()=>`run-${++counter}`});
  async function call(auth='Bearer valid',method='POST'){const res={code:null,data:null,set(){return this},status(code){this.code=code;return this},json(data){this.data=data;return this;}};await handler({method,headers:{authorization:auth}},res);return res;}
  return {call,rows,ledgerRows};
}
test('requires reviewed policy, explicit days and demo project; no data access when unavailable',async()=>{
  for(const conf of [{enabled:false},{reviewed:false},{reservationDays:0},{historyDays:0},{reservationDays:31},{historyDays:91},{policyVersion:''},{projectId:'production'},{ledgerProjectId:'demo-okclean'},{ledgerProjectId:'production'}]){const x=fixture({conf,scan:async()=>{throw Error('must not scan')}});assert.equal((await x.call()).code,503);}
});
test('OIDC verification and exact verified scheduler identity are mandatory',async()=>{
  for(const verify of [async()=>{throw Error('invalid signature')},async()=>({...valid,aud:'wrong'}),async()=>({...valid,iss:'wrong'}),async()=>({...valid,email_verified:false}),async()=>({...valid,email:'other@demo-ok.iam.gserviceaccount.com'})])assert.equal((await fixture({verify}).call()).code,401);
  assert.equal((await fixture().call('','POST')).code,401);assert.equal((await fixture().call('Bearer valid','GET')).code,405);
});
test('uses fenced transactions, count-only audit and a durable pagination cursor',async()=>{
  const x=fixture({scan:async()=>({ids:['synthetic'],next:'synthetic'})});const res=await x.call();assert.equal(res.code,200);assert.deepEqual(res.data,{status:'completed',hasMore:true,counts:{redacted:1}});
  assert.equal(x.rows.get('retention_scheduler/control').cursor,'synthetic');const audit=x.rows.get('retention_scheduler_runs/run-1');assert.deepEqual(Object.keys(audit).sort(),['at','counts','outcome','policyVersion']);assert.doesNotMatch(JSON.stringify(audit),/synthetic|valid/);
  assert.equal(x.ledgerRows.get('synthetic'),'committed');
});
test('concurrent invocations return busy and do not start a second page',async()=>{
  let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);let calls=0;
  const x=fixture({process:async()=>{calls++;entered();await wait;return {result:'redacted'}}});const first=x.call();await started;assert.equal((await x.call()).code,409);release();assert.equal((await first).code,200);assert.equal(calls,1);
});
test('failure retains original cursor and next invocation can retry',async()=>{
  let calls=0;const x=fixture({scan:async()=>{if(++calls===1)throw Error('transient scan failure');return {ids:['synthetic'],next:null}}});assert.equal((await x.call()).code,503);assert.equal(x.rows.get('retention_scheduler/control').cursor,null);assert.equal((await x.call()).code,200);assert.equal(calls,2);assert.equal(x.rows.get('retention_scheduler_runs/run-1').outcome,'retry_needed');
});
test('ledger intent failure blocks source modification',async()=>{let modified=false;const x=fixture({ledgerOverride:{safety:{sourceProjectId:'demo-okclean',ledgerProjectId:'demo-independent-ledger'},assertNoPending:async()=>{},recordIntent:async()=>{throw Error('unavailable')},markCommitted:async()=>{}},process:async()=>{modified=true;return {result:'redacted'}}});assert.equal((await x.call()).code,503);assert.equal(modified,false);});
test('ledger completion failure remains pending and blocks later retry',async()=>{let pending=false,writes=0;const x=fixture({ledgerOverride:{safety:{sourceProjectId:'demo-okclean',ledgerProjectId:'demo-independent-ledger'},assertNoPending:async()=>{if(pending)throw Error('unresolved')},recordIntent:async()=>{pending=true;return 'pending'},markCommitted:async()=>{throw Error('unavailable')}},process:async()=>{writes++;return {result:'redacted'}}});assert.equal((await x.call()).code,503);assert.equal(pending,true);assert.equal(x.rows.get('retention_scheduler/control').cursor,null);assert.equal((await x.call()).code,503);assert.equal(writes,1);});

test('corrupt lease expiry fails closed; an actually expired lease can be reclaimed',async()=>{
  for(const expiry of [new Date('invalid'),null,'invalid']){
    const x=fixture();x.rows.set('retention_scheduler/control',{owner:'stale',expiresAt:expiry,cursor:null,policyVersion:config.policyVersion});
    assert.equal((await x.call()).code,503);
    assert.equal(x.rows.get('retention_scheduler/control').owner,'stale');
    assert.equal(x.ledgerRows.size,0);
  }
  const x=fixture();x.rows.set('retention_scheduler/control',{owner:'stale',expiresAt:new Date('2029-12-31T23:00:00Z'),cursor:null,policyVersion:config.policyVersion});
  assert.equal((await x.call()).code,200);
});
test('lease corruption while scanning blocks freeze and deletion',async()=>{
  let x; x=fixture({scan:async()=>{const key='retention_scheduler/control';x.rows.set(key,{...x.rows.get(key),expiresAt:new Date('invalid')});return {ids:['synthetic'],next:null};}});
  assert.equal((await x.call()).code,503);assert.equal(x.ledgerRows.size,0);
});
test('expired worker cannot write a successful completion',async()=>{
  let at=new Date('2030-01-01T00:00:00Z');
  const x=fixture({clock:()=>at,process:async()=>{at=new Date('2030-01-01T00:06:00Z');return {result:'redacted'};}});
  assert.equal((await x.call()).code,503);
  assert.equal(x.rows.has('retention_scheduler_runs/run-1'),false);
});

test('malformed owner with any expiry is not treated as an unlocked lease',async()=>{
  for(const state of [{owner:'',expiresAt:new Date('2030-01-01T00:01:00Z')},{owner:0,expiresAt:new Date('2030-01-01T00:01:00Z')},{expiresAt:new Date('2030-01-01T00:01:00Z')},{owner:null},{owner:null,expiresAt:new Date('2030-01-01T00:01:00Z')}]){
    const x=fixture();x.rows.set('retention_scheduler/control',{...state,cursor:null,policyVersion:config.policyVersion});
    assert.equal((await x.call()).code,503);assert.equal(x.ledgerRows.size,0);
  }
});
