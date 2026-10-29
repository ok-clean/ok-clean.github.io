'use strict';
process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8085';process.env.GCLOUD_PROJECT='demo-okclean';
const {test}=require('node:test');const assert=require('node:assert/strict');const {createRetentionService}=require('../server/retention.cjs');
const {createDeletionLedger,processWithLedger}=require('../server/deletion-ledger.cjs');
// Separate in-memory ledger for unit tests; real emulator exercises persistence.
function unitLedger(){const stores=new Map();const ledgerDb={projectId:'demo-ledger',collection(name){if(!stores.has(name))stores.set(name,new Map());const map=stores.get(name);return {doc:id=>({id,map})};},async runTransaction(fn){const writes=[];const tx={async get(ref){const value=ref.map.get(ref.id);return {exists:value!==undefined,data:()=>value};},create(ref,value){writes.push(()=>ref.map.set(ref.id,value));},set(ref,value){writes.push(()=>ref.map.set(ref.id,value));},update(ref,value){writes.push(()=>ref.map.set(ref.id,{...ref.map.get(ref.id),...value}));}};const result=await fn(tx);writes.forEach(fn=>fn());return result;}};return createDeletionLedger({ledgerDb,primaryProjectId:'demo-okclean',ledgerProjectId:'demo-ledger'});}
function fixture({mode='valid',status='종료',terminalDate='2030-01-01T00:00:00Z',clock='2030-03-01T00:00:00Z',preFrozen=true}={}){
 const audits=[];const docs=new Map([['x',{status,legalHold:false,name:'가상고객',phone:'01000000000',ownerUid:'synthetic',notes:'synthetic',...(preFrozen?{dataMutationFrozen:true,retentionFreeze:'retention-v1'}:{})}]]),histories=new Map([['x',[{id:'h1',to:status,at:new Date(terminalDate),actorUid:'synthetic-admin'}]]]);let beforeTx=null,fail=false,unknown=false,version={seconds:100,nanoseconds:2};
 const mkRef=id=>({id,get:async()=>({exists:docs.has(id),updateTime:{...version},data:()=>docs.get(id)}),listCollections:async()=>unknown?[{id:'offers'}]:[{id:'status_history'}],collection:()=>({id:'status_history',_id:id,orderBy(){return this},limit(){return this},get:async()=>({size:(histories.get(id)||[]).length,docs:(histories.get(id)||[]).map(h=>({id:h.id,updateTime:h.updateTime||{seconds:200,nanoseconds:1},ref:{id:h.id,parentId:id,listCollections:async()=>[]},data:()=>h}))})})});
 const db={projectId:'demo-okclean',collection:name=>({doc:name==='retention_audit'?()=>({audit:true}):mkRef}),runTransaction:async fn=>{if(fail)throw Error('synthetic failure');if(beforeTx){beforeTx();beforeTx=null;}return fn({get:async target=>target._id?target.get():target.get(),set:(ref,v)=>docs.set(ref.id,v),update:(ref,v)=>docs.set(ref.id,{...docs.get(ref.id),...v}),create:(ref,v)=>{assert.equal(ref.audit,true);audits.push(v);},delete:ref=>histories.set(ref.parentId,(histories.get(ref.parentId)||[]).filter(h=>h.id!==ref.id))});}};
 const options={db,projectId:'demo-okclean',firestoreHost:'127.0.0.1:8085',policy:{reservationDays:30,historyDays:90},clock:()=>new Date(clock),authorize:async()=>true};
 return {docs,histories,audits,options,make:()=>{const svc=createRetentionService(options);const guarded=o=>o?.apply&&o.transactionFence===undefined?{...o,transactionFence:async()=>true}:o;return {...svc,async process(id,o){const opts=guarded(o),result=await svc.process(id,opts);if(result.result!=='ledger_required')return result;const plan=await svc.process(id);const action=plan.result==='would_redact'?'redacted':'history_purged';return processWithLedger({ledger:unitLedger(),service:svc,id,action,expectedVersion:opts.expectedVersion||plan.version,expectedHistoryVersion:opts.expectedHistoryVersion||plan.historyVersion,transactionFence:opts.transactionFence});},processBatch:(ids,o)=>svc.processBatch(ids,guarded(o))};},setBeforeTx:fn=>{beforeTx=fn;},setVersion:v=>{version=v;},setFail:v=>{fail=v;},setUnknown:v=>{unknown=v;}};
}
test('policy absent, real project, and real host always fail closed',()=>{const x=fixture();for(const changed of [{policy:null},{projectId:'production-project'},{firestoreHost:'other:8085'},{db:{...x.options.db,projectId:'actual-production'}}])assert.throws(()=>createRetentionService({...x.options,...changed}));});
test('dry run never writes; unfinished and recent records are kept',async()=>{const x=fixture();assert.equal((await x.make().process('x')).result,'would_redact');assert.equal(x.docs.get('x').name,'가상고객');const recent=fixture({terminalDate:'2030-02-25T00:00:00Z'});assert.equal((await recent.make().process('x',{apply:true})).result,'preserved');const active=fixture({status:'상담중'});assert.equal((await active.make().process('x',{apply:true})).result,'preserved');});
test('expired personal fields are replaced, history retained separately, repeat is safe',async()=>{const x=fixture(),api=x.make();assert.equal((await api.process('x',{apply:true})).result,'redacted');assert.equal(x.docs.get('x').name,undefined);assert.equal(x.docs.get('x').ownerUid,undefined);assert.equal(x.histories.get('x').length,1);assert.equal((await api.process('x',{apply:true})).result,'preserved');x.options.clock=()=>new Date('2030-05-01T00:00:00Z');const later=x.make();assert.equal((await later.process('x')).result,'would_purge_history');assert.equal(x.histories.get('x').length,1);assert.equal((await later.process('x',{apply:true})).result,'history_purged');assert.equal((await later.process('x',{apply:true})).result,'already_purged');assert.equal(x.docs.has('x'),true);assert.deepEqual(x.audits.map(a=>a.action),['redacted','history_purged']);assert.doesNotMatch(JSON.stringify(x.audits),/가상고객|01000000000|synthetic/);});
test('dependent records and changed status prevent destruction',async()=>{const x=fixture();x.setUnknown(true);assert.equal((await x.make().process('x',{apply:true})).result,'blocked_dependencies');assert.equal(x.docs.get('x').name,'가상고객');x.setUnknown(false);x.setBeforeTx(()=>{x.docs.set('x',{status:'상담중',legalHold:false,name:'가상고객'});});assert.equal((await x.make().process('x',{apply:true})).result,'preserved');});
test('failure does not claim deletion; explicit retry succeeds',async()=>{const x=fixture(),api=x.make();x.setFail(true);assert.equal((await api.process('x',{apply:true})).result,'retry_needed');assert.equal(x.docs.get('x').name,'가상고객');x.setFail(false);assert.equal((await api.process('x',{apply:true})).result,'redacted');});
test('apply requires separate authorization and batch reports counts only',async()=>{const x=fixture();x.options.authorize=async()=>false;const api=x.make();await assert.rejects(api.process('x',{apply:true}));assert.deepEqual(await api.processBatch(['x','missing']),{would_redact:1,absent:1});});

test('explicit legal-hold clearance required even after redaction',async()=>{const x=fixture(),api=x.make();const original=x.docs.get('x');for(const hold of [true,undefined,'false']){x.docs.set('x',{...original,legalHold:hold});assert.equal((await api.process('x',{apply:true})).result,'blocked_legal_hold');assert.equal(x.docs.get('x').name,'가상고객');}x.docs.set('x',{...original,legalHold:false});assert.equal((await api.process('x',{apply:true})).result,'redacted');x.docs.set('x',{...x.docs.get('x'),legalHold:true});x.options.clock=()=>new Date('2030-05-01T00:00:00Z');assert.equal((await x.make().process('x',{apply:true})).result,'blocked_legal_hold');assert.equal(x.histories.get('x').length,1);});

test('bounded scanner rejects unsafe limits and cursors',async()=>{const api=fixture().make();for(const x of [{limit:0},{limit:101},{after:'../secret'}])await assert.rejects(api.scan(x));});
test('scanner paginates stable receipt IDs without returning personal records',async()=>{const x=fixture();const base=x.options.db.collection;const all=['a','b','c'];x.options.db.collection=name=>{if(name!=='quote_requests')return base(name);return {doc:base(name).doc,orderBy(field){assert.equal(field,'__name__');let after='';return {startAfter(id){after=id;return this;},limit(max){return {get:async()=>({docs:all.filter(id=>id>after).slice(0,max).map(id=>({id,data:()=>{throw Error('must not read fields');}}))})};}};}};};const api=x.make(),first=await api.scan({limit:2});assert.deepEqual(first,{ids:['a','b'],next:'b'});const next=await api.scan({limit:2,after:first.next});assert.deepEqual(next,{ids:['c'],next:null});});
test('a legal hold added after inspection blocks transactional deletion',async()=>{const x=fixture();x.setBeforeTx(()=>x.docs.set('x',{...x.docs.get('x'),legalHold:true}));assert.equal((await x.make().process('x',{apply:true})).result,'blocked_legal_hold');assert.equal(x.docs.get('x').name,'가상고객');assert.equal(x.audits.length,0);});
test('a lost scheduler fence blocks deletion within the same transaction',async()=>{const x=fixture();assert.equal((await x.make().process('x',{apply:true,transactionFence:async()=>false})).result,'retry_needed');assert.equal(x.docs.get('x').name,'가상고객');assert.equal(x.audits.length,0);});
test('different snapshot version blocks deletion; matching version allows it',async()=>{const x=fixture(),api=x.make();assert.equal((await api.process('x',{apply:true,expectedVersion:'100:1'})).result,'changed');assert.equal(x.docs.get('x').name,'가상고객');assert.equal((await api.process('x',{apply:true,expectedVersion:'100:2'})).result,'redacted');await assert.rejects(api.process('x',{expectedVersion:'bad'}));});
test('changes after dependency inspection block transactional deletion',async()=>{const x=fixture();x.setBeforeTx(()=>x.setVersion({seconds:100,nanoseconds:3}));assert.equal((await x.make().process('x',{apply:true})).result,'changed');assert.equal(x.docs.get('x').name,'가상고객');assert.equal(x.audits.length,0);});
test('journaled action, parent and history version must all match before apply',async()=>{const x=fixture(),api=x.make(),check=await api.process('x');assert.equal(check.result,'would_redact');assert.equal(check.version,'100:2');assert.match(check.historyVersion,/^[a-f0-9]{64}$/);const common={apply:true,expectedVersion:check.version,expectedHistoryVersion:check.historyVersion};assert.equal((await api.process('x',{...common,expectedAction:'history_purged'})).result,'changed');assert.equal((await api.process('x',{...common,expectedAction:'redacted',expectedHistoryVersion:'a'.repeat(64)})).result,'changed');assert.equal(x.docs.get('x').name,'가상고객');assert.equal((await api.process('x',{...common,expectedAction:'redacted'})).result,'redacted');});
test('a changed related history document blocks the scheduled action',async()=>{const x=fixture(),api=x.make(),check=await api.process('x');x.histories.get('x')[0].updateTime={seconds:200,nanoseconds:2};assert.equal((await api.process('x',{apply:true,expectedAction:'redacted',expectedVersion:check.version,expectedHistoryVersion:check.historyVersion})).result,'changed');assert.equal(x.docs.get('x').name,'가상고객');assert.equal(x.audits.length,0);});
test('a child without a valid at field blocks redaction and history purge',async()=>{const x=fixture();x.histories.get('x').push({id:'malformed',to:'종료'});assert.equal((await x.make().process('x',{apply:true})).result,'blocked_dependencies');assert.equal(x.docs.get('x').name,'가상고객');assert.equal(x.histories.get('x').length,2);x.docs.set('x',{status:'보유기간만료',retentionRedacted:true,legalHold:false,terminalAt:new Date('2030-01-01T00:00:00Z')});x.options.clock=()=>new Date('2030-05-01T00:00:00Z');assert.equal((await x.make().process('x',{apply:true})).result,'blocked_dependencies');assert.equal(x.histories.get('x').length,2);assert.equal(x.audits.length,0);});
test('latest status is selected from all history without Firestore ordering',async()=>{const x=fixture();x.histories.get('x').unshift({id:'older',to:'상담중',at:new Date('2029-12-01T00:00:00Z')});assert.equal((await x.make().process('x')).result,'would_redact');x.histories.get('x').push({id:'newer',to:'상담중',at:new Date('2030-02-01T00:00:00Z')});assert.equal((await x.make().process('x',{apply:true})).result,'preserved');assert.equal(x.docs.get('x').name,'가상고객');});
test('conflicting statuses at the same latest time block deletion',async()=>{const x=fixture();x.histories.get('x').push({id:'tie',to:'상담중',at:new Date('2030-01-01T00:00:00Z')});assert.equal((await x.make().process('x',{apply:true})).result,'blocked_dependencies');assert.equal(x.docs.get('x').name,'가상고객');});

test('retention freeze rechecks known dependencies and rejects unrelated locks',async()=>{
  const x=fixture({preFrozen:false}),api=x.make(),plan=await api.process('x');
  const options={expectedAction:'redacted',expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence:async()=>true};
  assert.equal((await api.freeze('x',options)).result,'frozen');
  assert.equal(x.docs.get('x').dataMutationFrozen,true);
  assert.equal(x.docs.get('x').retentionFreeze,'retention-v1');
  assert.equal((await api.freeze('x',options)).result,'frozen');
  // Known administrator writes must reject the frozen parent; an unrelated
  // account deletion lock must not be repurposed by retention.
  const y=fixture({preFrozen:false}),other=y.make(),p=await other.process('x');
  y.docs.set('x',{...y.docs.get('x'),dataMutationFrozen:true});
  assert.equal((await other.freeze('x',{...options,expectedVersion:p.version,expectedHistoryVersion:p.historyVersion})).result,'blocked_dependencies');
  assert.equal(y.docs.get('x').name,'가상고객');
});
test('freeze rejects changed history, legal hold, lost fence, and unknown later children',async()=>{
  for(const change of ['history','hold','fence']){
    const x=fixture({preFrozen:false}),api=x.make(),plan=await api.process('x');
    if(change==='history')x.histories.get('x')[0].updateTime={seconds:201,nanoseconds:0};
    if(change==='hold')x.docs.set('x',{...x.docs.get('x'),legalHold:true});
    const got=await api.freeze('x',{expectedAction:'redacted',expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence:async()=>change!=='fence'});
    assert.ok(['changed','blocked_legal_hold','retry_needed'].includes(got.result));
    assert.equal(x.docs.get('x').dataMutationFrozen,undefined);
    assert.equal(x.docs.get('x').name,'가상고객');
  }
  const x=fixture({preFrozen:false}),api=x.make(),plan=await api.process('x');
  assert.equal((await api.freeze('x',{expectedAction:'redacted',expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence:async()=>true})).result,'frozen');
  x.setUnknown(true);
  assert.equal((await api.process('x',{apply:true})).result,'blocked_dependencies');
  assert.equal(x.docs.get('x').name,'가상고객');
  assert.equal(x.docs.get('x').dataMutationFrozen,true);
});

test('freeze cannot be used on active, recent or wrong-stage records',async()=>{
  const historyVersion=require('node:crypto').createHash('sha256').update(JSON.stringify([['h1','200:1']])).digest('hex');
  for(const x of [fixture({status:'상담중',preFrozen:false}),fixture({terminalDate:'2030-02-28T00:00:00Z',preFrozen:false})]){
    const got=await x.make().freeze('x',{expectedAction:'redacted',expectedVersion:'100:2',expectedHistoryVersion:historyVersion,transactionFence:async()=>true});
    assert.equal(got.result,'preserved');assert.equal(x.docs.get('x').dataMutationFrozen,undefined);
  }
});

test('direct destructive calls cannot bypass the parent freeze',async()=>{
  const x=fixture({preFrozen:false}),api=x.make(),plan=await api.process('x');
  assert.equal((await api.process('x',{apply:true})).result,'freeze_required');
  assert.equal(x.docs.get('x').name,'가상고객');
  assert.equal((await api.freeze('x',{expectedAction:'redacted',expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence:async()=>true})).result,'frozen');
  assert.equal((await api.process('x',{apply:true})).result,'redacted');
});

test('all destructive calls require a transaction fence',async()=>{
  const x=fixture(),api=createRetentionService(x.options);
  await assert.rejects(api.process('x',{apply:true}),/TRANSACTION_FENCE_REQUIRED/);
  assert.equal(x.docs.get('x').name,'가상고객');assert.equal(x.audits.length,0);
});
test('direct apply and batch cannot bypass the independent ledger',async()=>{
  const x=fixture(),api=createRetentionService(x.options),plan=await api.process('x');
  const opts={apply:true,expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,expectedAction:'redacted',transactionFence:async()=>true};
  assert.equal((await api.process('x',opts)).result,'ledger_required');
  assert.deepEqual(await api.processBatch(['x'],opts),{ledger_required:1});
  assert.equal(x.docs.get('x').name,'가상고객');assert.equal(x.audits.length,0);
  assert.equal((await api.process('x',{...opts,ledgerPermit:{}})).result,'ledger_required');
  await assert.rejects(processWithLedger({ledger:{recordIntent:async()=> 'pending',markCommitted:async()=>{}},service:api,id:'x',action:'redacted',expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence:opts.transactionFence}),/INCOMPLETE_DELETION_GUARD/);
});
test('a failed intent or a stale permit cannot authorize destruction',async()=>{
  const x=fixture(),api=createRetentionService(x.options),plan=await api.process('x'),transactionFence=async()=>true;
  const input={id:'x',action:'redacted',expectedVersion:plan.version,expectedHistoryVersion:plan.historyVersion,transactionFence};
  const brokenDb={projectId:'demo-broken-ledger',collection:()=>({doc:()=>({})}),runTransaction:async()=>{throw Error('synthetic ledger outage');}};
  const broken=createDeletionLedger({ledgerDb:brokenDb,primaryProjectId:'demo-okclean',ledgerProjectId:'demo-broken-ledger'});
  await assert.rejects(processWithLedger({ledger:broken,service:api,...input}),/synthetic ledger outage/);
  assert.equal(x.docs.get('x').name,'가상고객');assert.equal(x.audits.length,0);
  let stale;const capture={schedulerSafety:api.schedulerSafety,async process(id,opts){stale=opts;return {result:'retry_needed'};}};
  await processWithLedger({ledger:unitLedger(),service:capture,...input});
  assert.equal((await api.process('x',stale)).result,'ledger_required');
  assert.equal(x.docs.get('x').name,'가상고객');
});
