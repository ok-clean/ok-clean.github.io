'use strict';
// Two synthetic projects on one local emulator. This tests the server gate,
// not production IAM, firewall isolation, nor external checkpoint verification.
const http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict'),admin=require('firebase-admin');
const {createRestoreGate,message}=require('../server/restore-gate.cjs');
const servedDatabaseId='(default)',servedDatabaseUid='123e4567-e89b-42d3-a456-426614174000';
const resolveDbIdentity=async()=>({projectId:'demo-okclean-integration',databaseId:servedDatabaseId,uid:servedDatabaseUid});
const source='demo-okclean-integration',ledger='demo-okclean-ledger',host='127.0.0.1:8085',restoreId='synthetic-restore-0001';
if(process.env.GCLOUD_PROJECT!==source||process.env.FIRESTORE_EMULATOR_HOST!==host||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:ledger},'restore-gate-test'),db=admin.firestore(app);let server;
 try{
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519'),gate=createRestoreGate({ledgerDb:db,sourceProject:source,ledgerProject:ledger,restoreId,servedDatabaseId,resolveDbIdentity,publicKey:publicKey.export({type:'spki',format:'pem'})});
  server=http.createServer((req,res)=>gate.middleware(req,res,()=>{res.writeHead(200);res.end('synthetic-ok')}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`;
  assert.equal((await fetch(url)).status,503);
  await db.collection('deletion_ledger_meta').doc(source).create({revision:1});
  const issuedAt=Date.now(),v={sourceProject:source,ledgerProject:ledger,restoreId,servedDatabaseId,servedDatabaseUid,checkpoint:'a'.repeat(64),ledgerRevision:1,issuedAt,expiresAt:issuedAt+300000,state:'cleared'};
  await db.collection('restore_control').doc('serving').create({...v,signature:crypto.sign(null,message(v),privateKey).toString('base64url')});
  assert.equal((await fetch(url)).status,200);
  const pending=db.collection('deletion_ledger').doc('synthetic');await pending.create({state:'pending'});assert.equal((await fetch(url)).status,503);
  await pending.update({state:'committed'});assert.equal((await fetch(url)).status,200);
  await db.collection('deletion_ledger_meta').doc(source).update({revision:2});assert.equal((await fetch(url)).status,503);
  await db.collection('restore_control').doc('serving').update({checkpoint:'b'.repeat(64)});assert.equal((await fetch(url)).status,503);
  console.log('PASS loopback restore gate and synthetic Firestore; operational isolation remains unverified');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await app.delete();}
}
main().catch(()=>{console.error('RESTORE_GATE_EMULATOR_FAILED');process.exitCode=1;});
