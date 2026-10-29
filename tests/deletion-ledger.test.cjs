'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createDeletionLedger}=require('../server/deletion-ledger.cjs');
function dbMock(projectId='demo-ledger'){
 const rows=new Map();
 const makeRef=id=>({id});
 const collection={doc:makeRef,orderBy(){let after='';let max=100;return {startAfter(a){after=a;return this;},limit(n){max=n;return this;},async get(){let ids=[...rows.keys()].sort().filter(id=>id>after).slice(0,max);return {docs:ids.map(id=>({id,data:()=>structuredClone(rows.get(id))}))};}};}};
 return {projectId,rows,collection(){return collection;},async runTransaction(fn){const writes=[];const tx={async get(ref){const val=rows.get(ref.id);return {exists:val!==undefined,data:()=>structuredClone(val)};},create(ref,v){writes.push(()=>{if(rows.has(ref.id))throw Error('conflict');rows.set(ref.id,structuredClone(v));});},update(ref,v){writes.push(()=>rows.set(ref.id,{...rows.get(ref.id),...structuredClone(v)}));}};const result=await fn(tx);writes.forEach(w=>w());return result;}};
}
function setup(){const db=dbMock();return {db,ledger:createDeletionLedger({ledgerDb:db,primaryProjectId:'demo-primary',ledgerProjectId:'demo-ledger',clock:()=>new Date('2030-01-01T00:00:00Z')})};}
const one={id:'request-1',action:'redacted',expectedVersion:'123:1'};
test('requires an independently configured project',()=>{const db=dbMock();assert.throws(()=>createDeletionLedger({ledgerDb:db,primaryProjectId:'demo-ledger',ledgerProjectId:'demo-ledger'}),/INDEPENDENT/);assert.throws(()=>createDeletionLedger({ledgerDb:db,primaryProjectId:'demo-primary',ledgerProjectId:'another'}),/INDEPENDENT/);});
test('records intention before commit; stable retries and conflicts',async()=>{const {ledger,db}=setup();assert.equal(await ledger.recordIntent(one),'pending');assert.equal(await ledger.recordIntent(one),'pending');await assert.rejects(ledger.recordIntent({...one,expectedVersion:'changed'}),/LEDGER_CONFLICT/);assert.equal(await ledger.markCommitted(one),'committed');assert.equal(await ledger.markCommitted(one),'committed');assert.equal(db.rows.size,1);const row=[...db.rows.values()][0];assert.deepEqual(Object.keys(row).sort(),['action','committedAt','expectedVersion','id','recordedAt','sourceProject','state']);});
test('fails closed on pending, lost fence, failed replay and missing ledger',async()=>{const {ledger}=setup();await ledger.recordIntent(one);await assert.rejects(ledger.replay({verifyLedgerSnapshot:async()=>true,isRestoreFenced:async()=>true,reapply:async()=>true}),/RECONCILIATION/);await ledger.markCommitted(one);await assert.rejects(ledger.replay({verifyLedgerSnapshot:async()=>true,isRestoreFenced:async()=>false,reapply:async()=>true}),/FENCE/);await assert.rejects(ledger.replay({verifyLedgerSnapshot:async()=>true,isRestoreFenced:async()=>true,reapply:async()=>false}),/REAPPLY/);await assert.rejects(ledger.markCommitted({...one,id:'missing'}),/INTENT_REQUIRED/);});
test('replays every committed record with paging under external fence',async()=>{const {ledger}=setup();const ids=['r1','r2','r3'];for(const id of ids){const record={...one,id};await ledger.recordIntent(record);await ledger.markCommitted(record);}const visited=[];assert.deepEqual(await ledger.replay({pageSize:1,verifyLedgerSnapshot:async()=>true,isRestoreFenced:async()=>true,reapply:async row=>{visited.push(row.id);return true;}}),{processed:3});assert.deepEqual(visited.sort(),ids);});
test('guard writes intent before worker, propagates version, keeps uncertain result pending',async()=>{
 const {processWithLedger}=require('../server/deletion-ledger.cjs');const {ledger}=setup();
 const service={async process(id,options){assert.equal(id,one.id);assert.deepEqual(options,{apply:true,expectedVersion:one.expectedVersion});assert.equal((await ledger.page()).records[0].state,'pending');return {result:'retry_needed'};}};
 assert.deepEqual(await processWithLedger({ledger,service,...one}),{result:'retry_needed'});await assert.rejects(ledger.replay({verifyLedgerSnapshot:async()=>true,isRestoreFenced:async()=>true,reapply:async()=>true}),/RECONCILIATION/);
 const successful={async process(){return {result:'redacted'};}};assert.deepEqual(await processWithLedger({ledger,service:successful,...one}),{result:'redacted'});assert.equal((await ledger.page()).records[0].state,'committed');
 await assert.rejects(processWithLedger({ledger,service:successful,...one}),/ALREADY_COMMITTED/);
});
test('requires independent snapshot verification before and after replay',async()=>{
 const {ledger}=setup();await assert.rejects(ledger.replay({isRestoreFenced:async()=>true,reapply:async()=>true}),/GUARD_REQUIRED/);
 await assert.rejects(ledger.replay({isRestoreFenced:async()=>true,verifyLedgerSnapshot:async()=>false,reapply:async()=>true}),/SNAPSHOT_UNVERIFIED/);
 let checks=0;await assert.rejects(ledger.replay({isRestoreFenced:async()=>true,verifyLedgerSnapshot:async()=>++checks===1,reapply:async()=>true}),/SNAPSHOT_UNVERIFIED/);
});
test('replays parent redaction before history purge regardless of key order',async()=>{
 const {ledger}=setup();for(const action of ['history_purged','redacted']){const row={...one,action};await ledger.recordIntent(row);await ledger.markCommitted(row);}
 const seen=[];await ledger.replay({isRestoreFenced:async()=>true,verifyLedgerSnapshot:async()=>true,reapply:async row=>{seen.push(row.action);return true;}});assert.deepEqual(seen,['redacted','history_purged']);
});
