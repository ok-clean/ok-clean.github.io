'use strict';
// Synthetic Firestore emulator projects only. The fence below is a test double;
// this test does not establish operational IAM or network isolation.
const assert=require('node:assert/strict'),admin=require('firebase-admin');
const {createRetentionService}=require('../server/retention.cjs');
const {createDeletionLedger,processWithLedger}=require('../server/deletion-ledger.cjs');
const primary='demo-okclean-integration',secondary='demo-okclean-ledger',host='127.0.0.1:8085';
if(process.env.FIRESTORE_EMULATOR_HOST!==host||process.env.GCLOUD_PROJECT!==primary)throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:primary},'ledger-primary-test');
 const separate=admin.initializeApp({projectId:secondary},'ledger-independent-test');
 const db=admin.firestore(app),ledgerDb=admin.firestore(separate),ref=db.collection('quote_requests').doc('synthetic-ledger');
 try{
  await ref.create({status:'종료',legalHold:false,name:'가상고객',phone:'01000000000',ownerUid:'synthetic'});
  const hist=ref.collection('status_history').doc('event');await hist.create({from:'상담중',to:'종료',at:new Date('2030-01-01T00:00:00Z')});
  const before=(await ref.get()).data(),beforeHist=(await hist.get()).data();
  const ledger=createDeletionLedger({ledgerDb,primaryProjectId:primary,ledgerProjectId:secondary});
  const service=createRetentionService({db,projectId:primary,firestoreHost:host,policy:{reservationDays:30,historyDays:90},clock:()=>new Date('2030-03-01T00:00:00Z'),authorize:async()=>true});
  const transactionFence=async()=>true; // test-only; not an operational fence
  async function freezeCandidate(id){const p=await service.process(id);assert.equal(p.result,'would_redact');assert.equal((await service.freeze(id,{expectedAction:'redacted',expectedVersion:p.version,expectedHistoryVersion:p.historyVersion,transactionFence})).result,'frozen');return service.process(id);}
  const preview=await freezeCandidate(ref.id);const input={id:ref.id,action:'redacted',expectedVersion:preview.version,expectedHistoryVersion:preview.historyVersion};
  // A direct, frozen transaction with matching versions must not bypass the ledger.
  assert.equal((await service.process(ref.id,{apply:true,transactionFence,expectedAction:input.action,expectedVersion:input.expectedVersion,expectedHistoryVersion:input.expectedHistoryVersion})).result,'ledger_required');
  assert.equal((await ref.get()).data().name,'가상고객');
  assert.equal((await ledger.page()).records.length,0);
  assert.equal((await processWithLedger({ledger,service,transactionFence,...input})).result,'redacted');assert.equal((await ref.get()).data().name,undefined);
  assert.equal((await ledger.page()).records[0].state,'committed');
  await ref.set(before);await hist.set(beforeHist);assert.equal((await ref.get()).data().name,'가상고객');
  // Fence is a test double; production requires network isolation + independent IAM.
  const replay=await ledger.replay({service,verifyLedgerSnapshot:async()=>true,isRestoreFenced:async()=>true,reapply:async({id,action,ledgerPermit})=>{if(action!=='redacted')return false;const current=await freezeCandidate(id);return (await service.process(id,{apply:true,expectedAction:action,expectedVersion:current.version,expectedHistoryVersion:current.historyVersion,transactionFence,ledgerPermit})).result==='redacted';}});
  assert.deepEqual(replay,{processed:1});assert.equal((await ref.get()).data().name,undefined);
  // If data changes after the durable intention, the worker must not delete it.
  const raced=db.collection('quote_requests').doc('synthetic-ledger-changed');
  await raced.create({...before});await raced.collection('status_history').doc('event').create(beforeHist);
  const beforeRace=await freezeCandidate(raced.id);const changed={id:raced.id,action:'redacted',expectedVersion:beforeRace.version,expectedHistoryVersion:beforeRace.historyVersion};
  await ledger.recordIntent(changed);await raced.update({notes:'synthetic concurrent change'});
  assert.equal((await processWithLedger({ledger,service,transactionFence,...changed})).result,'changed');
  assert.equal((await raced.get()).data().name,'가상고객');
  await assert.rejects(ledger.replay({verifyLedgerSnapshot:async()=>true,isRestoreFenced:async()=>true,reapply:async()=>true}),/LEDGER_RECONCILIATION_REQUIRED/);
  console.log('PASS: emulator ledger reapplication under simulated isolation; actual isolation untested');
 }finally{await Promise.all([app.delete(),separate.delete()]);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
