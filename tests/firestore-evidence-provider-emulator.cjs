'use strict';
// Real Firebase Admin SDK + loopback Firestore emulator; synthetic documents only.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {createRequire}=require('node:module');const sdk=createRequire(path.resolve(__dirname,'../server/package.json'));
const {initializeApp,deleteApp}=sdk('firebase-admin/app'),{getFirestore}=sdk('firebase-admin/firestore');
const {createFirestoreKeyRegistry,createFirestoreCheckpointProvider,checkpointScopeHash}=require('../server/firestore-evidence-provider.cjs');
const {createKeyLifecycleAdapter,fingerprint}=require('../server/key-lifecycle-adapter.cjs');
const {createCheckpointStoreAdapter,checkpointStorageMessage}=require('../server/checkpoint-store-adapter.cjs');
const {checkpointMessage}=require('../server/independent-restore-verifier.cjs');
async function main(){
 if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!=='demo-write-provider')throw Error('DEMO_REQUIRED');
 const app=initializeApp({projectId:'demo-write-provider'},'evidence-provider-'+crypto.randomUUID()),db=getFirestore(app,'evidence-copy');
 try{
 const now=100000,unique=crypto.randomUUID().replaceAll('-',''),config={db,projectId:'demo-write-provider',databaseId:'evidence-copy',registryId:unique,clock:()=>now,writeGate:async({projectId,databaseId})=>({allowed:true,mode:'emulator',projectId,databaseId})};
 const pair=crypto.generateKeyPairSync('ed25519'),keyId='projects/demo-control/locations/global/keyRings/synthetic/cryptoKeys/control/cryptoKeyVersions/1',pem=pair.publicKey.export({type:'spki',format:'pem'}),sa='control-agent@demo-control.iam.gserviceaccount.com';
 await db.collection('operations_key_registry').doc(unique).create({version:0,state:{revision:0,active:{control:keyId},keys:{[keyId]:{keyId,role:'control',status:'active',serviceAccount:sa,notBefore:0,expiresAt:1000000,publicKey:pem,publicKeySha256:fingerprint(pem)}},receipts:{},audit:[]}});
 const registry=createFirestoreKeyRegistry(config),lifecycle=createKeyLifecycleAdapter({registry,kms:{inspect:async()=>({keyId,state:'ENABLED',algorithm:'EC_SIGN_ED25519',publicKeySha256:fingerprint(pem)}),sign:async({data})=>crypto.sign(null,data,pair.privateKey)},authorize:async({action,role,keyId})=>({action,role,keyId,authenticated:true,principal:sa}),clock:()=>now});
 const binding={sourceProject:'demo-source',ledgerProject:'demo-ledger',restoreId:'restore_'+unique,servedDatabaseId:'restore-copy',servedDatabaseUid:'123e4567-e89b-42d3-a456-426614174000',fenceId:'fence_'+unique},contextHash=crypto.createHash('sha256').update(JSON.stringify(binding)).digest('hex');
 await db.collection('operations_checkpoint_heads').doc(checkpointScopeHash(binding)).create({scope:binding,sequence:0,hash:'0'.repeat(64)});
 const checkpoint=createCheckpointStoreAdapter({provider:createFirestoreCheckpointProvider(config),binding,publicKeys:{[keyId]:pem},authorize:async()=>({uid:'synthetic-admin',checkpointAdmin:true}),verifyEvidence:async({proof,keyId,payload,historical})=>{const v=await lifecycle.verify({envelope:proof,role:'control',purpose:'checkpoint',contextHash,payload,historical,consume:false});return {verified:v.valid&&(historical?v.historical:v.currentKeyValid),historicalOnly:v.historical,keyId};},now:()=>now});
 const evidence={...binding,issuedAt:now,expiresAt:now+10000,checkpoint:'a'.repeat(64),ledgerRevision:1,recordCount:0,state:'immutable-complete'};evidence.signature=crypto.sign(null,checkpointMessage(evidence),pair.privateKey).toString('base64url');const record={id:'checkpoint_'+unique,sequence:1,previousHash:'0'.repeat(64),evidence,retentionUntil:now+100000,legalHold:false,keyId,signature:'',keyProof:null};record.signature=crypto.sign(null,checkpointStorageMessage(record),pair.privateKey).toString('base64url');record.keyProof=await lifecycle.sign({role:'control',purpose:'checkpoint',keyId,requestId:'sign_'+unique,contextHash,payload:checkpointStorageMessage(record)});
 const attempts=await Promise.all([checkpoint.append({record}),checkpoint.append({record})]);assert.equal(attempts.filter(v=>v.replayed===false).length,1);assert.equal(attempts.filter(v=>v.replayed===true).length,1);
 const anchor={sequence:1,hash:attempts[0].hash};assert.equal((await checkpoint.inspect({expectedAnchor:anchor})).records.length,1);
 await lifecycle.revoke({role:'control',keyId,expectedRevision:0,traceId:'revoke_'+unique});assert.equal((await checkpoint.inspect({expectedAnchor:anchor})).historicalOnly,true);
 await assert.rejects(lifecycle.sign({role:'control',purpose:'checkpoint',keyId,requestId:'blocked_'+unique,contextHash,payload:Buffer.from('synthetic')}));
 const final=(await db.collection('operations_key_registry').doc(unique).get()).data();assert.equal(final.state.keys[keyId].status,'revoked');assert.equal(Object.keys(final.state.receipts).length,1);
 console.log('Firestore evidence SDK emulator: lifecycle signing/revocation, atomic concurrent checkpoint, historical verification PASS');
 }finally{await db.terminate();await deleteApp(app);}
}
main().catch(()=>{console.error('FIRESTORE_EVIDENCE_EMULATOR_FAILED');process.exitCode=1;});
