'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRestoreRenewer,parseIssuerOrigin}=require('../server/restore-renewal.cjs');
const {startRestoreHealthMonitor}=require('../server/restore-gate.cjs');
function memory(){
 let row=null,chain=Promise.resolve();
 const db={projectId:'demo-control',collection:()=>({doc:()=>({})}),runTransaction(fn){const work=chain.then(async()=>{let next;const tx={get:async()=>({exists:row!==null,data:()=>row}),set:(_r,v)=>next=v};const r=await fn(tx);if(next!==undefined)row=next;return r;});chain=work.catch(()=>{});return work;}};
 return {db,get:()=>row,set:v=>row=v};
}
function fixture({clock=()=>100000,createClient=async()=>({request:async()=>({status:200,data:{status:'issued'}})}),id=()=>require('node:crypto').randomUUID()}={}){
 const m=memory();const config={controlDb:m.db,controlProjectId:'demo-control',sourceProjectId:'demo-source',ledgerProjectId:'demo-ledger',issuerOrigin:'https://synthetic.run.app',createClient,clock,newId:id};return {...m,config};
}
test('issuer URL and independent control project are strictly required',()=>{
 for(const x of ['http://synthetic.run.app','https://synthetic.run.app/path','https://synthetic.run.app?token=x','https://x@synthetic.run.app','https://synthetic.run.app.evil.test','https://synthetic.run.app:8443'])assert.equal(parseIssuerOrigin(x),null);
 assert.equal(parseIssuerOrigin('https://synthetic.run.app'),'https://synthetic.run.app');const s=fixture();assert.throws(()=>createRestoreRenewer({...s.config,controlProjectId:'demo-source'}),/CONFIGURATION_INVALID/);
});
test('single lease fences concurrent calls and only targets expected issuer',async()=>{
 let release,started;const held=new Promise(r=>release=r),firstStarted=new Promise(r=>started=r),calls=[];
 const s=fixture({createClient:async aud=>({request:async input=>{calls.push({aud,input});started();await held;return {status:200,data:{status:'issued'}};}})});
 const renew=createRestoreRenewer(s.config),first=renew();await firstStarted;assert.equal(await renew(),'busy');release();assert.equal(await first,'issued');assert.equal(calls.length,1);assert.equal(calls[0].aud,'https://synthetic.run.app');assert.equal(calls[0].input.url,'https://synthetic.run.app/_internal/restore/issue');assert.equal(calls[0].input.maxRedirects,0);assert.deepEqual(s.get(),{owner:null,expiresAt:null});
});
test('corrupt lease stops renewal and valid expired lease can be reclaimed',async()=>{
 const s=fixture();const renew=createRestoreRenewer(s.config);
 for(const row of [{owner:'active',expiresAt:new Date(NaN)},{owner:'active',expiresAt:null},{owner:'active',expiresAt:'invalid'},{owner:'',expiresAt:new Date(1)}]){s.set(row);await assert.rejects(renew(),/CORRUPT_LEASE/);assert.deepEqual(s.get(),row);}
 s.set({owner:'old',expiresAt:new Date(99999)});assert.equal(await renew(),'issued');
});
test('lost lease prevents external call; issuer failure remains retryable',async()=>{
 let calls=0;const s=fixture();s.config.createClient=async()=>{s.set({owner:'other',expiresAt:new Date(145000)});return {request:async()=>{calls++;}}};await assert.rejects(createRestoreRenewer(s.config)(),/LEASE_LOST/);assert.equal(calls,0);assert.equal(s.get().owner,'other');
 s.set(null);s.config.createClient=async()=>({request:async()=>{throw Error('network')}});await assert.rejects(createRestoreRenewer(s.config)());assert.deepEqual(s.get(),{owner:null,expiresAt:null});s.config.createClient=async()=>({request:async()=>({status:200,data:{status:'issued'}})});assert.equal(await createRestoreRenewer(s.config)(),'issued');
});
test('credential and request deadlines fail closed and release the lease',async()=>{
 let calls=0;const s=fixture();s.config.credentialTimeoutMs=10;s.config.createClient=()=>new Promise(()=>{});
 await assert.rejects(createRestoreRenewer(s.config)(),/RENEWAL_TIMEOUT/);assert.deepEqual(s.get(),{owner:null,expiresAt:null});
 s.config.requestTimeoutMs=10;s.config.createClient=async()=>({request:async options=>{calls++;await new Promise(resolve=>options.signal.addEventListener('abort',resolve));throw Error('aborted')}});
 await assert.rejects(createRestoreRenewer(s.config)());assert.equal(calls,1);assert.deepEqual(s.get(),{owner:null,expiresAt:null});
});
test('a stalled control database times out without calling the issuer',async()=>{
 const s=fixture();let calls=0;s.config.controlTimeoutMs=10;s.config.controlDb.runTransaction=()=>new Promise(()=>{});s.config.createClient=async()=>{calls++;return {request:async()=>{}}};
 await assert.rejects(createRestoreRenewer(s.config)(),/RENEWAL_TIMEOUT/);assert.equal(calls,0);
});
test('monitor renews before expiry and verifies returned certificate before readiness',async()=>{
 let state={available:true,remainingMs:110000},calls=0;const reports=[];
 const monitor=startRestoreHealthMonitor({inspect:async()=>state},{renew:async()=>{calls++;state={available:true,remainingMs:240000};return 'issued';},report:x=>reports.push(x),setIntervalFn:()=>({unref(){}}),clearIntervalFn:()=>{}});
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.deepEqual(reports,[]);monitor.stop();
});
test('unavailable gate never opens on failed renewal and retries with backoff',async()=>{
 let t=100000,calls=0;const reports=[];const gate={inspect:async()=>({available:false})};
 const monitor=startRestoreHealthMonitor(gate,{clock:()=>t,renew:async()=>{calls++;throw Error('not safe')},report:x=>reports.push(x),setIntervalFn:()=>({unref(){}}),clearIntervalFn:()=>{}});
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);await monitor.check();assert.equal(calls,1);t+=60000;await monitor.check();assert.equal(calls,2);t+=60000;await monitor.check();assert.equal(calls,2);assert.ok(reports.includes('RESTORE_GATE_UNAVAILABLE'));assert.ok(reports.includes('RESTORE_GATE_RENEWAL_FAILED'));monitor.stop();
});
test('expired gate becomes ready only after independently verified issuer succeeds',async()=>{
 let state={available:false},calls=0;const monitor=startRestoreHealthMonitor({inspect:async()=>state},{renew:async()=>{calls++;state={available:true,remainingMs:240000};return 'issued'},report:()=>{},setIntervalFn:()=>({unref(){}}),clearIntervalFn:()=>{}});await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.equal(state.available,true);monitor.stop();
});

test('advisory checks and identical warning logs are throttled under request load',async()=>{
 let t=100000,reads=0;const reports=[];
 const m=startRestoreHealthMonitor({inspect:async()=>{reads++;return {available:false};}},{clock:()=>t,report:x=>reports.push(x),setIntervalFn:()=>({unref(){}}),clearIntervalFn:()=>{}});
 await new Promise(r=>setImmediate(r));for(let i=0;i<100;i++)await m.check();assert.equal(reads,1);assert.deepEqual(reports,['RESTORE_GATE_UNAVAILABLE']);
 t+=10000;await m.check();assert.equal(reads,2);assert.deepEqual(reports,['RESTORE_GATE_UNAVAILABLE']);
 t+=50000;await m.check();assert.equal(reads,3);assert.deepEqual(reports,['RESTORE_GATE_UNAVAILABLE','RESTORE_GATE_UNAVAILABLE']);m.stop();
});
test('concurrent requests wait for the same bounded renewal before their gate rechecks',async()=>{
 let release,started,calls=0;const held=new Promise(r=>release=r),began=new Promise(r=>started=r);let state={available:false};
 const m=startRestoreHealthMonitor({inspect:async()=>state},{renew:async()=>{calls++;started();await held;state={available:true,remainingMs:240000};return 'issued'},report:()=>{},setIntervalFn:()=>({unref(){}}),clearIntervalFn:()=>{}});
 await began;let done=false;const waiting=m.check().then(()=>{done=true});await new Promise(r=>setImmediate(r));assert.equal(done,false);assert.equal(calls,1);release();await waiting;assert.equal(done,true);assert.equal(state.available,true);m.stop();
});
