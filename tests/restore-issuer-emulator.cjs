'use strict';
// Synthetic Firestore projects only. OIDC, external validation and KMS are test
// doubles; this does not establish IAM, checkpoint independence or isolation.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http'),admin=require('firebase-admin');
const {createDeletionLedger}=require('../server/deletion-ledger.cjs');
const {createRestoreIssuer,validationMessage,recordBytes,auditRestoredDeletionState}=require('../server/restore-issuer.cjs');
const {createRestoreGate,startRestoreHealthMonitor}=require('../server/restore-gate.cjs');
const {createRestoreRenewer}=require('../server/restore-renewal.cjs');
const source='demo-okclean-integration',project='demo-okclean-ledger',restoreId='synthetic_epoch_123456';
if(process.env.GCLOUD_PROJECT!==source||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:project},'restore-issuer-test'),db=admin.firestore(app),ledger=createDeletionLedger({ledgerDb:db,primaryProjectId:source,ledgerProjectId:project});
 const controlApp=admin.initializeApp({projectId:'demo-okclean-control'},'restore-renew-control'),controlDb=admin.firestore(controlApp);
 const restoredApp=admin.initializeApp({projectId:source},'restore-audit-test'),restoredDb=admin.firestore(restoredApp);let server,monitor;
 let now=Date.now();const verifier=crypto.generateKeyPairSync('ed25519'),signer=crypto.generateKeyPairSync('ed25519'),pem=k=>k.export({format:'pem',type:'spki'}),aud='https://synthetic.run.app',email='issuer@demo-okclean.iam.gserviceaccount.com';
 try{
  const input={id:'synthetic-issuer',action:'redacted',expectedVersion:'1:0',expectedHistoryVersion:'a'.repeat(64)};
  await ledger.recordIntent(input);await ledger.markCommitted(input);
  const record={sourceProject:source,...input,state:'committed'},proof={sourceProject:source,ledgerProject:project,restoreId,checkpoint:crypto.createHash('sha256').update(recordBytes(record)).digest('hex'),ledgerRevision:2,recordCount:1,issuedAt:now,expiresAt:now+540000,isolated:true,replayed:true,state:'verified'};
  const audit={ledgerDb:db,restoredDb,sourceProject:source,ledgerProject:project,checkpoint:proof.checkpoint,ledgerRevision:proof.ledgerRevision,recordCount:1};
  const parent=restoredDb.collection('quote_requests').doc(input.id);
  await parent.set({name:'synthetic personal data'});
  await assert.rejects(auditRestoredDeletionState(audit),/RESTORE_REAPPLICATION_REQUIRED/);
  await parent.set({retentionRedacted:true,status:'보유기간만료',terminalAt:new Date(now-86400000),redactedAt:new Date(now),legalHold:false,dataMutationFrozen:true,retentionFreeze:'retention-v1'});
  assert.equal((await auditRestoredDeletionState(audit)).recordCount,1);
  const restoredHistory=parent.collection('status_history').doc('synthetic');
  await restoredHistory.set({from:'상담중',to:'종료',at:new Date(now),actorUid:'synthetic'});
  await assert.rejects(auditRestoredDeletionState(audit),/RESTORE_HISTORY_BASELINE_REQUIRED/);
  await restoredHistory.delete();
  await assert.rejects(auditRestoredDeletionState({...audit,checkpoint:'0'.repeat(64)}),/RESTORE_CHECKPOINT_MISMATCH/);
  await parent.collection('unexpected').doc('synthetic').set({x:1});
  await assert.rejects(auditRestoredDeletionState(audit),/RESTORE_UNKNOWN_DEPENDENCIES/);
  await parent.collection('unexpected').doc('synthetic').delete();
  proof.signature=crypto.sign(null,validationMessage(proof),verifier.privateKey).toString('base64url');
  await db.collection('restore_validation').doc(restoreId).create(proof);
  const handler=createRestoreIssuer({ledgerDb:db,ledger,sourceProject:source,ledgerProject:project,restoreId,authorityPublicKey:pem(verifier.publicKey),gatePublicKey:pem(signer.publicKey),callerEmail:email,audience:aud,verifyOidc:async()=>({aud,iss:'https://accounts.google.com',email,email_verified:true}),sign:async m=>crypto.sign(null,m,signer.privateKey),now:()=>now});
  const res={setHeader(){},end(v){this.body=JSON.parse(v);return this}};await handler({method:'POST',headers:{authorization:'Bearer synthetic'}},res);assert.equal(res.statusCode,200);
  const gate=createRestoreGate({ledgerDb:db,sourceProject:source,ledgerProject:project,restoreId,publicKey:pem(signer.publicKey),now:()=>now});assert.equal(await gate.verify(),true);
  const previous=(await db.collection('restore_control').doc('serving').get()).data().expiresAt;now+=240000;
  server=http.createServer((req,res)=>{if(req.url!=='/_internal/restore/issue'){res.writeHead(404);return res.end();}void handler(req,res);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=aud;
  const renew=createRestoreRenewer({controlDb,controlProjectId:'demo-okclean-control',sourceProjectId:source,ledgerProjectId:project,issuerOrigin:origin,clock:()=>now,createClient:async audience=>({request:async options=>{assert.equal(audience,origin);assert.equal(options.url,origin+'/_internal/restore/issue');const r=await fetch(`http://127.0.0.1:${server.address().port}/_internal/restore/issue`,{method:'POST',headers:{authorization:'Bearer synthetic'}});return {status:r.status,data:await r.json()};}})});
  monitor=startRestoreHealthMonitor(gate,{renew,clock:()=>now,report:()=>{},setIntervalFn:()=>({unref(){}}),clearIntervalFn:()=>{}});
  for(let i=0;i<100;i++){if((await gate.inspect()).remainingMs>120000)break;await new Promise(r=>setTimeout(r,50));}
  const renewed=(await db.collection('restore_control').doc('serving').get()).data();assert.ok(renewed.expiresAt>previous);assert.equal(await gate.verify(),true);monitor.stop();
  await ledger.recordIntent({...input,id:'synthetic-pending'});assert.equal(await gate.verify(),false);
  await assert.rejects(auditRestoredDeletionState(audit),/RESTORE_LEDGER_UNSTABLE/);
  await assert.rejects(renew(),/ISSUER_REJECTED/);assert.equal(await gate.verify(),false);
  const retry={setHeader(){},end(v){this.body=JSON.parse(v);return this}};await handler({method:'POST',headers:{authorization:'Bearer synthetic'}},retry);assert.equal(retry.statusCode,503);
  console.log('PASS synthetic renewal via loopback HTTP and Firestore emulator; OIDC, validator and KMS are test doubles');
 }finally{if(monitor)monitor.stop();if(server)await new Promise(resolve=>server.close(resolve));await Promise.all([app.delete(),controlApp.delete(),restoredApp.delete()]);}
}
main().catch(()=>{console.error('RESTORE_ISSUER_EMULATOR_TEST_FAILED');process.exitCode=1;});
