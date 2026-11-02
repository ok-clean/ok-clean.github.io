'use strict';
// All records, tokens, keys and DB identity metadata are synthetic. Real local
// Firestore transactions, not an actual IAM fence/WORM or customer deletion.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),child=require('node:child_process');
const {initializeApp}=require('firebase-admin/app'),{getFirestore}=require('firebase-admin/firestore');
const {createDemoRestoreControl,stateMessage}=require('../server/demo-restore-control.cjs');
const {createDemoRestoreReplay}=require('../server/demo-restore-replay.cjs');
const {createIndependentRestoreVerifier}=require('../server/independent-restore-verifier.cjs');
const source='demo-okclean-integration',lp='demo-control-ledger',cp='demo-restore-control',rid='synthetic_control_epoch_123',trace='synthetic_trace_123456',uid='123e4567-e89b-42d3-a456-426614174000';
if(process.env.GCLOUD_PROJECT!==source||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085')throw Error('DEMO_EMULATOR_REQUIRED');
const apps=[initializeApp({projectId:source},'control-source'),initializeApp({projectId:lp},'control-ledger'),initializeApp({projectId:cp},'control-authority')];
const sourceDb=getFirestore(apps[0]),restoredDb=getFirestore(apps[0],'control-copy'),ledgerDb=getFirestore(apps[1]),controlDb=getFirestore(apps[2]);
const authority=crypto.generateKeyPairSync('ed25519'),validator=crypto.generateKeyPairSync('ed25519'),issuer=crypto.generateKeyPairSync('ed25519'),pem=k=>k.export({format:'pem',type:'spki'}),now=Date.parse('2030-06-01T00:00:00Z');
const resolveDbIdentity=async({projectId,databaseId})=>({projectId,databaseId,uid});
const cfg={controlDb,ledgerDb,sourceDb,restoredDb,sourceProject:source,ledgerProject:lp,restoreId:rid,resolveDbIdentity,publicKey:pem(authority.publicKey),sign:async x=>crypto.sign(null,x,authority.privateKey),verifyIdToken:async token=>{if(token==='bad')throw Error('invalid');return {uid:token==='other'?'other-synthetic':'synthetic-operator',restoreAdmin:token!=='normal'};},clock:()=>now};
const receipt=restoredDb.collection('quote_requests').doc('synthetic-control-receipt');
async function clear(db,collection){for(const ref of await db.collection(collection).listDocuments())await db.recursiveDelete(ref);}
async function seed(){
 for(const n of ['deletion_ledger','deletion_ledger_meta','restore_fence_evidence','restore_checkpoint_evidence','restore_validation'])await clear(ledgerDb,n);
 for(const n of ['restore_adapter_runs','restore_state_checkpoints','restore_adapter_audit'])await clear(controlDb,n);
 for(const n of ['quote_requests','restore_replay_control','restore_replay_runs','retention_audit'])await clear(restoredDb,n);
 await sourceDb.collection('quote_requests').doc('live-sentinel').set({name:'untouched-synthetic-live'});
 await ledgerDb.collection('deletion_ledger_meta').doc(source).set({revision:4});
 for(const action of ['redacted','history_purged']){
  const row={sourceProject:source,id:receipt.id,action,state:'committed',expectedVersion:'1:0',expectedHistoryVersion:'a'.repeat(64)};
  const id=crypto.createHash('sha256').update(source+'\0'+action+'\0'+receipt.id).digest('hex');await ledgerDb.collection('deletion_ledger').doc(id).set(row);
 }
 await receipt.set({name:'synthetic-private-name',phone:'01000001111',ownerUid:'synthetic-owner',status:'종료',legalHold:false});
 await receipt.collection('status_history').doc('h').set({at:new Date('2030-01-01'),to:'종료',actorUid:'synthetic-admin'});
}
async function main(){
 await seed();const controller=createDemoRestoreControl(cfg),request={idToken:'admin',traceId:trace};
 await assert.rejects(controller.prepare({...request,idToken:'normal'}),/OPERATOR_REQUIRED/);
 await assert.rejects(controller.prepare({...request,idToken:'bad'}));
 assert.equal((await controlDb.collection('restore_adapter_runs').get()).size,0);
 const prepared=await controller.prepare(request);assert.equal(prepared.publishAllowed,false);
 assert.deepEqual(await controller.prepare(request),prepared);
 await assert.rejects(controller.prepare({...request,traceId:'different_trace_12345'}),/BUSY/);
 await assert.rejects(controller.prepare({...request,idToken:'other'}),/BUSY/);
 console.log('PASS verified operator, quarantine ownership, duplicate prepare and concurrent claimant rejection');
 const before=await controller.capture({...request,phase:'before'});assert.deepEqual(await controller.capture({...request,phase:'before'}),before);
 assert.ok(crypto.verify(null,stateMessage(before),authority.publicKey,Buffer.from(before.signature,'base64url')));
 await receipt.update({name:'changed-synthetic-name'});await assert.rejects(controller.capture({...request,phase:'before'}),/IMMUTABLE/);await receipt.update({name:'synthetic-private-name'});
 console.log('PASS signed before checkpoint is create-only and changed state cannot overwrite it');
 const replay=createDemoRestoreReplay({ledgerDb,sourceDb,restoredDb,sourceProject:source,ledgerProject:lp,restoreId:rid,resolveDbIdentity,controlAuthorityPublicKey:cfg.publicKey,policy:{reservationDays:30,historyDays:90},clock:()=>new Date(now)});
 assert.equal((await replay.replay()).publishAllowed,false);assert.equal((await replay.replay()).counts.already_applied,2);
 const after=await controller.capture({...request,phase:'after'});assert.notEqual(before.digest,after.digest);assert.equal(after.recordCount,1);
 assert.equal((await sourceDb.collection('quote_requests').doc('live-sentinel').get()).data().name,'untouched-synthetic-live');
 await controller.recordOutcome({...request,outcome:'after_checkpoint'});
 await assert.rejects(controller.recordOutcome({...request,outcome:'synthetic-private-name'}),/AUDIT_CODE/);
 const audit=(await controlDb.collection('restore_adapter_audit').get()).docs.map(d=>d.data());assert.ok(audit.every(v=>Object.keys(v).sort().join(',')==='at,outcome,publishAllowed,reason,traceId'));
 const stored=(await controlDb.collection('restore_state_checkpoints').get()).docs.map(d=>d.data());assert.doesNotMatch(JSON.stringify(stored)+JSON.stringify(audit),/synthetic-private-name|01000001111|synthetic-owner|synthetic-control-receipt/);
 console.log('PASS complete control→checkpoint→replay→after flow preserves live DB and audits no customer payload');
 const verifier=createIndependentRestoreVerifier({...cfg,restoredDatabaseId:restoredDb.databaseId,controlAuthorityPublicKey:cfg.publicKey,validatorPublicKey:pem(validator.publicKey),issuerPublicKey:pem(issuer.publicKey),sign:async x=>crypto.sign(null,x,validator.privateKey),now:()=>now});
 const proof=await verifier.verify();assert.equal(proof.replayed,true);assert.equal(proof.isolated,true);assert.equal((await controlDb.collection('restore_adapter_runs').doc(rid).get()).data().publishAllowed,false);
 const blocked=child.spawnSync(process.execPath,['server/restore-issuer-index.cjs'],{encoding:'utf8',env:{...process.env,OKCLEAN_RESTORE_ISSUER_ENABLED:'true'}});assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/INDEPENDENT_RESTORE_VERIFIER_REQUIRED/);
 console.log('PASS separately signed demo audit never opens production issuer');
 await assert.rejects(controller.capture({...request,phase:'promote'}),/PHASE/);
 for(const x of [{sourceProject:'okclean-production'},{restoredDb:sourceDb},{controlDb:ledgerDb}])assert.throws(()=>createDemoRestoreControl({...cfg,...x}),/DEMO_RESTORE_CONTROL_REQUIRED/);
 console.log('PASS production projects, serving DB, shared authority store and publish phase rejected');
 await seed();await controller.prepare(request);await ledgerDb.collection('restore_checkpoint_evidence').doc(rid).update({recordCount:999});await assert.rejects(controller.prepare(request),/CHECKPOINT_IMMUTABLE/);
 await controller.recordOutcome({...request,outcome:'blocked',reason:'evidence_invalid'});
 const failure=(await controlDb.collection('restore_adapter_audit').get()).docs[0].data();assert.equal(failure.reason,'evidence_invalid');assert.equal(failure.traceId,trace);assert.equal(failure.publishAllowed,false);
 await assert.rejects(controller.recordOutcome({...request,outcome:'blocked',reason:'synthetic-private-name'}),/AUDIT_CODE_INVALID/);
 console.log('PASS tampered checkpoint refuses replacement and records only fixed failure code and trace');

 await seed();const stalled=createDemoRestoreControl({...cfg,timeoutMs:5,verifyIdToken:async()=>new Promise(()=>{})});await assert.rejects(stalled.prepare(request),/CONTROL_TIMEOUT/);assert.equal((await controlDb.collection('restore_adapter_runs').get()).size,0);
 await assert.rejects(createDemoRestoreControl({...cfg,sign:async()=>Buffer.alloc(64)}).prepare(request),/SIGNATURE_INVALID/);assert.equal((await ledgerDb.collection('restore_checkpoint_evidence').get()).size,0);
 console.log('PASS authentication timeout and invalid signer never emit checkpoint evidence');
 await seed();const row=(await ledgerDb.collection('deletion_ledger').limit(1).get()).docs[0];await row.ref.update({state:'pending'});await assert.rejects(controller.prepare(request),/LEDGER_PENDING/);
 assert.equal((await ledgerDb.collection('restore_fence_evidence').get()).size,0);
 console.log('PASS pending deletion intent blocks preparation without modifying source');
 await seed();let count=0;const changing=createDemoRestoreControl({...cfg,resolveDbIdentity:async a=>({...await resolveDbIdentity(a),uid:++count>1?'223e4567-e89b-42d3-a456-426614174000':uid})});await assert.rejects(changing.prepare(request),/IDENTITY_CHANGED/);assert.equal((await ledgerDb.collection('restore_checkpoint_evidence').get()).size,0);
 console.log('PASS replacement database identity blocks issuance');
}
main().finally(async()=>{await Promise.all(apps.map(a=>a.delete()));}).catch(e=>{console.error(e);process.exitCode=1;});
