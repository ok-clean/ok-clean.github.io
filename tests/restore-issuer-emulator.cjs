'use strict';
// Synthetic Firestore projects only. OIDC, external validation and KMS are test
// doubles; this does not establish IAM, checkpoint independence or isolation.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),admin=require('firebase-admin');
const {createDeletionLedger}=require('../server/deletion-ledger.cjs');
const {createRestoreIssuer,validationMessage,recordBytes}=require('../server/restore-issuer.cjs');
const {createRestoreGate}=require('../server/restore-gate.cjs');
const source='demo-okclean-integration',project='demo-okclean-ledger',restoreId='synthetic_epoch_123456';
if(process.env.GCLOUD_PROJECT!==source||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:project},'restore-issuer-test'),db=admin.firestore(app),ledger=createDeletionLedger({ledgerDb:db,primaryProjectId:source,ledgerProjectId:project});
 const verifier=crypto.generateKeyPairSync('ed25519'),signer=crypto.generateKeyPairSync('ed25519'),pem=k=>k.export({format:'pem',type:'spki'}),now=Date.now(),aud='https://issuer.example.test',email='issuer@demo-okclean.iam.gserviceaccount.com';
 try{
  const input={id:'synthetic-issuer',action:'redacted',expectedVersion:'1:0',expectedHistoryVersion:'a'.repeat(64)};
  await ledger.recordIntent(input);await ledger.markCommitted(input);
  const record={sourceProject:source,...input,state:'committed'},proof={sourceProject:source,ledgerProject:project,restoreId,checkpoint:crypto.createHash('sha256').update(recordBytes(record)).digest('hex'),ledgerRevision:2,recordCount:1,issuedAt:now,expiresAt:now+60000,isolated:true,replayed:true,state:'verified'};
  proof.signature=crypto.sign(null,validationMessage(proof),verifier.privateKey).toString('base64url');
  await db.collection('restore_validation').doc(restoreId).create(proof);
  const handler=createRestoreIssuer({ledgerDb:db,ledger,sourceProject:source,ledgerProject:project,restoreId,authorityPublicKey:pem(verifier.publicKey),gatePublicKey:pem(signer.publicKey),callerEmail:email,audience:aud,verifyOidc:async()=>({aud,iss:'https://accounts.google.com',email,email_verified:true}),sign:async m=>crypto.sign(null,m,signer.privateKey),now:()=>now});
  const res={setHeader(){},end(v){this.body=JSON.parse(v);return this}};await handler({method:'POST',headers:{authorization:'Bearer synthetic'}},res);assert.equal(res.statusCode,200);
  const gate=createRestoreGate({ledgerDb:db,sourceProject:source,ledgerProject:project,restoreId,publicKey:pem(signer.publicKey),now:()=>now});assert.equal(await gate.verify(),true);
  await ledger.recordIntent({...input,id:'synthetic-pending'});assert.equal(await gate.verify(),false);
  const retry={setHeader(){},end(v){this.body=JSON.parse(v);return this}};await handler({method:'POST',headers:{authorization:'Bearer synthetic'}},retry);assert.equal(retry.statusCode,503);
  console.log('PASS synthetic issuer and restore gate with Firestore emulator; OIDC, validator and KMS are test doubles');
 }finally{await app.delete();}
}
main().catch(()=>{console.error('RESTORE_ISSUER_EMULATOR_TEST_FAILED');process.exitCode=1;});
