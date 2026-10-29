'use strict';
// Firebase emulator only; synthetic data only. Never run with production credentials.
const assert=require('node:assert/strict'),admin=require('firebase-admin');
const {createRetentionService}=require('../server/retention.cjs');
const {createScheduledRetentionHandler}=require('../server/retention-scheduler.cjs');
const {createDeletionLedger}=require('../server/deletion-ledger.cjs');
const project='demo-okclean-integration',host='127.0.0.1:8085';
if(process.env.FIRESTORE_EMULATOR_HOST!==host||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||process.env.GCLOUD_PROJECT!==project)throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:project},'retention-test'),db=admin.firestore(app),ref=db.collection('quote_requests').doc('synthetic-retention');
 const ledgerProject='demo-okclean-independent-ledger',ledgerApp=admin.initializeApp({projectId:ledgerProject},'retention-ledger-test'),ledgerDb=admin.firestore(ledgerApp);
 try{
  await ref.create({status:'종료',legalHold:false,name:'가상고객',phone:'01000000000',ownerUid:'synthetic',notes:'synthetic'});
  await ref.collection('status_history').doc('event').create({from:'상담중',to:'종료',at:new Date('2030-01-01T00:00:00Z'),actorUid:'synthetic-admin'});
  // Synthetic in-memory copies only: not a production backup or independent deletion ledger.
  const beforeDelete=(await ref.get()).data();
  const beforeDeleteHistory=(await ref.collection('status_history').doc('event').get()).data();
  const recoveryIds=[ref.id];
  const opts={db,projectId:project,firestoreHost:host,policy:{reservationDays:30,historyDays:90},clock:()=>new Date('2030-03-01T00:00:00Z'),authorize:async()=>true};
  const service=createRetentionService(opts);
  assert.equal((await service.process(ref.id)).result,'would_redact');assert.equal((await ref.get()).data().name,'가상고객');
  const page=await service.scan({limit:1});assert.deepEqual(page.ids,['synthetic-retention']);
  const raced=await Promise.all([service.process(ref.id,{apply:true}),service.process(ref.id,{apply:true})]);
  assert.equal(raced.filter(x=>x.result==='redacted').length,1);assert.equal(raced.filter(x=>['preserved','changed'].includes(x.result)).length,1);const row=(await ref.get()).data();assert.equal(row.retentionRedacted,true);assert.equal(row.name,undefined);assert.equal(row.phone,undefined);assert.equal(row.ownerUid,undefined);
  assert.equal((await ref.collection('status_history').get()).size,1);
  const later=createRetentionService({...opts,clock:()=>new Date('2030-05-01T00:00:00Z')});
  assert.equal((await later.process(ref.id,{apply:true})).result,'history_purged');assert.equal((await ref.collection('status_history').get()).size,0);assert.equal((await later.process(ref.id,{apply:true})).result,'already_purged');
  // Restore an old synthetic parent and child within this isolated emulator, then
  // reapply the existing retention operation using only in-memory test IDs.
  // This does not test an independently retained ledger or enforce network isolation.
  await ref.set(beforeDelete);await ref.collection('status_history').doc('event').set(beforeDeleteHistory);
  assert.equal((await ref.get()).data().name,'가상고객');
  const reapplied=await later.processBatch(recoveryIds,{apply:true});assert.equal(reapplied.redacted,1);
  assert.equal((await ref.get()).data().name,undefined);assert.equal((await ref.get()).data().ownerUid,undefined);
  const repurged=await later.processBatch(recoveryIds,{apply:true});assert.equal(repurged.history_purged,1);
  assert.equal((await ref.collection('status_history').get()).size,0);
  assert.equal((await later.processBatch(recoveryIds,{apply:true})).already_purged,1);
  const audit=await db.collection('retention_audit').get();assert.equal(audit.size,4);for(const d of audit.docs)assert.deepEqual(Object.keys(d.data()).sort(),['action','at']);
  // Firestore orderBy('at') silently excludes this malformed child. All-child
  // scanning must block both redaction and history cleanup instead.
  const malformed=db.collection('quote_requests').doc('z-synthetic-malformed-history');
  await malformed.create({status:'종료',legalHold:false,name:'가상보존'});
  await malformed.collection('status_history').doc('valid').create({to:'종료',at:new Date('2030-01-01T00:00:00Z')});
  await malformed.collection('status_history').doc('missing-time').create({to:'종료'});
  assert.equal((await service.process(malformed.id,{apply:true})).result,'blocked_dependencies');
  assert.equal((await malformed.get()).data().name,'가상보존');
  assert.equal((await malformed.collection('status_history').get()).size,2);
  // Scheduler integration uses real demo Firestore; only the OIDC verifier is a test double.
  const scheduled=db.collection('quote_requests').doc('a-synthetic-scheduler');
  await scheduled.create({status:'종료',legalHold:false,name:'가상고객2'});
  await scheduled.collection('status_history').doc('event').create({from:'상담중',to:'종료',at:new Date('2030-01-01T00:00:00Z')});
  const audience='https://scheduler.example.test/internal/retention',email='scheduler@demo-ok.iam.gserviceaccount.com';
  const ledger=createDeletionLedger({ledgerDb,primaryProjectId:project,ledgerProjectId:ledgerProject,clock:()=>new Date('2030-03-01T00:00:00Z')});
  const handler=createScheduledRetentionHandler({db,service,ledger,verifyOidc:async()=>({aud:audience,iss:'https://accounts.google.com',email_verified:true,email}),config:{enabled:true,reviewed:true,projectId:project,ledgerProjectId:ledgerProject,audience,serviceAccount:email,policyVersion:'synthetic-v1',reservationDays:30,historyDays:90},clock:()=>new Date('2030-03-01T00:00:00Z')});
  async function scheduledCall(){const res={code:0,body:null,set(){return this},status(c){this.code=c;return this},json(v){this.body=v;return this}};await handler({method:'POST',headers:{authorization:'Bearer synthetic'}},res);return res;}
  const scheduledResult=await scheduledCall();assert.equal(scheduledResult.code,200);assert.equal((await scheduled.get()).data().name,undefined);assert.equal((await scheduledCall()).code,200);
  const journal=await ledgerDb.collection('deletion_ledger').get();assert.equal(journal.size,1);assert.equal(journal.docs[0].data().state,'committed');
  assert.equal((await db.collection('retention_scheduler_runs').get()).size,2);
  console.log('PASS: retention and manual synthetic snapshot restore/reapply; independent ledger and isolation untested');
 }finally{await ledgerApp.delete();await app.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
