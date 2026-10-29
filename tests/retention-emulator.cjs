'use strict';
// Firebase emulator only; synthetic data only. Never run with production credentials.
const assert=require('node:assert/strict'),admin=require('firebase-admin');
const {createRetentionService}=require('../server/retention.cjs');
const project='demo-okclean-integration',host='127.0.0.1:8085';
if(process.env.FIRESTORE_EMULATOR_HOST!==host||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||process.env.GCLOUD_PROJECT!==project)throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:project},'retention-test'),db=admin.firestore(app),ref=db.collection('quote_requests').doc('synthetic-retention');
 try{
  await ref.create({status:'종료',legalHold:false,name:'가상고객',phone:'01000000000',ownerUid:'synthetic',notes:'synthetic'});
  await ref.collection('status_history').doc('event').create({from:'상담중',to:'종료',at:new Date('2030-01-01T00:00:00Z'),actorUid:'synthetic-admin'});
  const opts={db,projectId:project,firestoreHost:host,policy:{reservationDays:30,historyDays:90},clock:()=>new Date('2030-03-01T00:00:00Z'),authorize:async()=>true};
  const service=createRetentionService(opts);
  assert.equal((await service.process(ref.id)).result,'would_redact');assert.equal((await ref.get()).data().name,'가상고객');
  const page=await service.scan({limit:1});assert.deepEqual(page.ids,['synthetic-retention']);
  const raced=await Promise.all([service.process(ref.id,{apply:true}),service.process(ref.id,{apply:true})]);
  assert.equal(raced.filter(x=>x.result==='redacted').length,1);assert.equal(raced.filter(x=>x.result==='preserved').length,1);const row=(await ref.get()).data();assert.equal(row.retentionRedacted,true);assert.equal(row.name,undefined);assert.equal(row.phone,undefined);assert.equal(row.ownerUid,undefined);
  assert.equal((await ref.collection('status_history').get()).size,1);
  const later=createRetentionService({...opts,clock:()=>new Date('2030-05-01T00:00:00Z')});
  assert.equal((await later.process(ref.id,{apply:true})).result,'history_purged');assert.equal((await ref.collection('status_history').get()).size,0);assert.equal((await later.process(ref.id,{apply:true})).result,'already_purged');
  const audit=await db.collection('retention_audit').get();assert.equal(audit.size,2);for(const d of audit.docs)assert.deepEqual(Object.keys(d.data()).sort(),['action','at']);
  console.log('PASS: retention with synthetic Firestore emulator records');
 }finally{await app.delete();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
