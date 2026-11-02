'use strict';
// Real local Firestore SDK transactions; all projects/data/keys are synthetic.
// This is NOT production IAM, physical fencing, or a production backup restore.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {initializeApp}=require('firebase-admin/app'),{getFirestore}=require('firebase-admin/firestore');
const {createDemoRestoreReplay}=require('../server/demo-restore-replay.cjs');
const {fenceMessage,checkpointMessage}=require('../server/independent-restore-verifier.cjs');
const {recordBytes}=require('../server/restore-issuer.cjs');
const source='demo-okclean-integration',lp='demo-replay-ledger',rid='synthetic_replay_epoch_123',uid='123e4567-e89b-42d3-a456-426614174000',dbid='replay-copy';
if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!==source)throw Error('DEMO_EMULATOR_REQUIRED');
const a=initializeApp({projectId:source},'demo-replay-source'),b=initializeApp({projectId:lp},'demo-replay-ledger'),sourceDb=getFirestore(a),restore=getFirestore(a,dbid),ledger=getFirestore(b),keys=crypto.generateKeyPairSync('ed25519');
const pem=keys.publicKey.export({format:'pem',type:'spki'}),now=Date.parse('2030-06-01T00:00:00Z'),clock=()=>new Date(now);
const row=action=>({sourceProject:source,id:'synthetic-receipt',action,state:'committed',expectedVersion:'1:0',expectedHistoryVersion:'a'.repeat(64)});
const key=r=>crypto.createHash('sha256').update(source).update('\0').update(r.action).update('\0').update(r.id).digest('hex');
const cfg={ledgerDb:ledger,sourceDb,restoredDb:restore,sourceProject:source,ledgerProject:lp,restoreId:rid,resolveDbIdentity:async({projectId,databaseId})=>({projectId,databaseId,uid}),controlAuthorityPublicKey:pem,policy:{reservationDays:30,historyDays:90},clock};
let rows,checkpoint,fence;
async function clear(db,n){const refs=await db.collection(n).listDocuments();for(const r of refs)await db.recursiveDelete(r);}
async function seed(){
 for(const n of ['deletion_ledger','deletion_ledger_meta','restore_fence_evidence','restore_checkpoint_evidence'])await clear(ledger,n);
 for(const n of ['quote_requests','retention_audit','restore_replay_control','restore_replay_runs'])await clear(restore,n);
 rows=['history_purged','redacted'].map(row).sort((a,b)=>key(a).localeCompare(key(b)));
 for(const r of rows)await ledger.collection('deletion_ledger').doc(key(r)).set(r);
 await ledger.collection('deletion_ledger_meta').doc(source).set({revision:4});
 const bind={sourceProject:source,ledgerProject:lp,restoreId:rid,servedDatabaseId:dbid,servedDatabaseUid:uid,fenceId:'synthetic_fence_12345',issuedAt:now-1,expiresAt:now+60000};
 fence={...bind,state:'held'};checkpoint={...bind,state:'immutable-complete',checkpoint:crypto.createHash('sha256').update(rows.map(recordBytes).join('')).digest('hex'),ledgerRevision:4,recordCount:2};await saveEvidence();
 const ref=restore.collection('quote_requests').doc('synthetic-receipt');await ref.set({name:'가상 고객',phone:'01000001111',ownerUid:'synthetic-owner',status:'종료',legalHold:false});await ref.collection('status_history').doc('h1').set({at:new Date('2030-01-01'),to:'종료',actorUid:'synthetic-admin'});
}
async function saveEvidence(){fence.signature=crypto.sign(null,fenceMessage(fence),keys.privateKey).toString('base64url');checkpoint.signature=crypto.sign(null,checkpointMessage(checkpoint),keys.privateKey).toString('base64url');await ledger.collection('restore_fence_evidence').doc(rid).set(fence);await ledger.collection('restore_checkpoint_evidence').doc(rid).set(checkpoint);}
const parent=()=>restore.collection('quote_requests').doc('synthetic-receipt');
async function run(){
 await seed();let out=await createDemoRestoreReplay(cfg).replay();assert.deepEqual(out,{status:'reapplied',publishAllowed:false,counts:{redacted:1,history_purged:1,already_applied:0},processed:2});assert.equal((await parent().get()).data().name,undefined);assert.equal((await parent().collection('status_history').get()).size,0);
 const audits=(await restore.collection('retention_audit').get()).docs.map(d=>d.data());assert.deepEqual(audits.map(v=>v.action).sort(),['history_purged','redacted']);assert.doesNotMatch(JSON.stringify(audits),/가상|01000001111|synthetic-receipt|synthetic-owner/);
 out=await createDemoRestoreReplay(cfg).replay();assert.equal(out.counts.already_applied,2);assert.equal((await restore.collection('retention_audit').get()).size,2);console.log('PASS ordered replay, original PII removal, idempotent retry and count-only audit');
 await seed();await parent().update({legalHold:true});await assert.rejects(createDemoRestoreReplay(cfg).replay(),/REPLAY_LEGAL_HOLD/);assert.equal((await parent().get()).data().name,'가상 고객');console.log('PASS legal hold excludes destructive replay');
 await seed();await ledger.collection('deletion_ledger').doc(key(rows[0])).update({state:'pending'});await assert.rejects(createDemoRestoreReplay(cfg).replay(),/RECONCILIATION/);assert.equal((await parent().get()).data().name,'가상 고객');console.log('PASS pending intent blocks before source mutation');
 await seed();checkpoint.checkpoint='0'.repeat(64);await saveEvidence();await assert.rejects(createDemoRestoreReplay(cfg).replay(),/CHECKPOINT_MISMATCH/);assert.equal((await parent().get()).data().name,'가상 고객');console.log('PASS mismatched signed checkpoint blocks replay');
 await seed();let failOnce=true;
 const uncertain={projectId:source,databaseId:dbid,collection:restore.collection.bind(restore),runTransaction:async(fn,options)=>{const r=await restore.runTransaction(fn,options);if(failOnce&&(await parent().get()).data().retentionRedacted){failOnce=false;throw Error('synthetic lost acknowledgment');}return r;}};
 await assert.rejects(createDemoRestoreReplay({...cfg,restoredDb:uncertain}).replay());assert.equal((await parent().get()).data().retentionRedacted,true);out=await createDemoRestoreReplay(cfg).replay();assert.equal(out.counts.already_applied,1);assert.equal(out.counts.history_purged,1);console.log('PASS partial apply/lost response retries without duplicate redaction');
 await seed();let release,entered,calls=0;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const resolve=async args=>{if(++calls===4){entered();await blocked;}return cfg.resolveDbIdentity(args);};
 const adapter=createDemoRestoreReplay({...cfg,resolveDbIdentity:resolve}),first=adapter.replay();await started;await assert.rejects(adapter.replay(),/REPLAY_BUSY/);release();await first;console.log('PASS two workers serialize through DB lease');
 await seed();calls=0;
 const changing=async args=>{if(++calls===4)await ledger.collection('deletion_ledger_meta').doc(source).set({revision:5});return cfg.resolveDbIdentity(args);};await assert.rejects(createDemoRestoreReplay({...cfg,resolveDbIdentity:changing}).replay(),/LEDGER_CHANGED/);assert.equal((await parent().get()).data().name,'가상 고객');console.log('PASS concurrent revision update blocks before mutation');
 await seed();let inserted=false;
 const duringApply=async args=>{if(!inserted&&(await parent().get()).data().retentionRedacted){inserted=true;await ledger.collection('deletion_ledger').doc('new-pending').set({...row('redacted'),id:'new-synthetic',state:'pending'});await ledger.collection('deletion_ledger_meta').doc(source).set({revision:5});}return cfg.resolveDbIdentity(args);};
 await assert.rejects(createDemoRestoreReplay({...cfg,resolveDbIdentity:duringApply}).replay(),/LEDGER_CHANGED|RECONCILIATION/);assert.equal((await parent().get()).data().retentionRedacted,true);assert.equal((await parent().collection('status_history').get()).size,1);assert.equal((await restore.collection('restore_replay_runs').get()).docs[0].data().outcome,'incomplete');console.log('PASS new concurrent deletion intent stops remaining replay and records incomplete');
 await seed();fence.state='released';await saveEvidence();await assert.rejects(createDemoRestoreReplay(cfg).replay(),/SIGNED_REPLAY_EVIDENCE_REQUIRED/);assert.equal((await parent().get()).data().name,'가상 고객');console.log('PASS signed released fence never authorizes replay');
 for(const changed of [{sourceProject:'okclean-production'},{ledgerProject:source},{restoredDb:sourceDb}])assert.throws(()=>createDemoRestoreReplay({...cfg,...changed}),/DEMO_RESTORE_REPLAY_REQUIRED/);
 const saved=process.env.FIRESTORE_EMULATOR_HOST;process.env.FIRESTORE_EMULATOR_HOST='remote:8085';assert.throws(()=>createDemoRestoreReplay(cfg),/DEMO_RESTORE_REPLAY_REQUIRED/);process.env.FIRESTORE_EMULATOR_HOST=saved;console.log('PASS production project, live database and wrong host rejected');
 const logs=(await restore.collection('restore_replay_runs').get()).docs.map(d=>d.data());assert.ok(logs.every(v=>Object.keys(v).sort().join(',')==='at,counts,outcome'));assert.doesNotMatch(JSON.stringify(logs),/가상|01000001111|synthetic-receipt|synthetic-owner/);
}
run().finally(async()=>{await Promise.all([a.delete(),b.delete()]);}).catch(e=>{console.error(e);process.exitCode=1;});
