'use strict';
// Actual Firebase Admin SDK + local Firestore emulator; synthetic identities and
// auth only. No live project, IAM fence or server commit deadline guarantee.
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const sdkRequire=require('node:module').createRequire(path.resolve(__dirname,'../server/package.json'));
const {initializeApp,deleteApp}=sdkRequire('firebase-admin/app'),{getFirestore}=sdkRequire('firebase-admin/firestore');
const {createFirestoreWriteProvider}=require('../server/firestore-write-provider.cjs');
const {createWriteIsolationAdapter}=require('../server/write-isolation-adapter.cjs');
const projectId='demo-write-provider',databaseId='write-copy';
if(process.env.GCLOUD_PROJECT!==projectId||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085')throw Error('LOOPBACK_DEMO_REQUIRED');
const app=initializeApp({projectId},'write-provider-emulator'),db=getFirestore(app,databaseId);
db.settings({host:'127.0.0.1:8085',ssl:false});
const sourceUid='11111111-1111-4111-8111-111111111111',targetUid='22222222-2222-4222-8222-222222222222';
const namespace='test-'+crypto.randomUUID(),root=db.collection('write_isolation').doc(namespace);
const ref=(kind,id)=>root.collection(kind).doc(id);
async function main(){
 const now=Date.now();
 await ref('control','active').create({databaseUid:targetUid,epoch:'epoch-001',quarantined:true,publishAllowed:false,fencingToken:1,expiresAt:now+600000,allowedOperations:['create','update','restore','delete'],checkpointDigest:'a'.repeat(64)});
 await ref('principals','operator').create({enabled:true,authVersion:1,admin:true,operations:['create','update','restore','delete']});
 const cfg={db,projectId,sourceDatabaseId:'(default)',targetDatabaseId:databaseId,sourceDatabaseUid:sourceUid,targetDatabaseUid:targetUid,epoch:'epoch-001',namespace,executionMode:'emulator',timeoutMs:30000,resolveDbIdentity:async({projectId,databaseId})=>({projectId,databaseId,uid:databaseId==='(default)'?sourceUid:targetUid})};
 const provider=createFirestoreWriteProvider(cfg);
 const ac={provider,sourceDatabaseUid:sourceUid,targetDatabaseUid:targetUid,epoch:'epoch-001',appId:'sample-app',leaseMs:30000,verifyIdentity:async()=>({uid:'operator',authVersion:1,revoked:false,expiresAt:now+600000}),verifyAppCheck:async()=>({appId:'sample-app',expiresAt:now+600000}),validatePayload:async(op,p)=>p,verifyRestore:async(e,b)=>({...b,authorizesOperation:true,historical:false,checkpointDigest:e.checkpointDigest,expiresAt:now+600000})};
 const adapter=createWriteIsolationAdapter(ac),r={operation:'create',requestId:'request-001',recordId:'record-001',traceId:'trace-001',expectedRevision:0,idToken:'synthetic',appCheckToken:'synthetic',payload:{value:'synthetic'}};
 const concurrent=await Promise.all([adapter.execute(r),adapter.execute(r),adapter.execute(r)]);
 assert.equal(concurrent.filter(x=>!x.replayed).length,1);
 assert.equal((await ref('records','record-001').get()).data().revision,1);
 assert.equal((await root.collection('audit').get()).size,1);
 await assert.rejects(adapter.execute({...r,payload:{value:'changed'}}),/IDEMPOTENCY_CONFLICT/);
 const updates=await Promise.allSettled(['request-002','request-003'].map(requestId=>adapter.execute({...r,operation:'update',requestId,expectedRevision:1})));
 assert.equal(updates.filter(x=>x.status==='fulfilled').length,1);
 assert.equal((await ref('records','record-001').get()).data().revision,2);
 // Failure after staging but before SDK flush leaves all three collections intact.
 const restore={...r,operation:'restore',requestId:'request-restore',expectedRevision:2,payload:{value:'restored-synthetic'},restoreEvidence:{checkpointDigest:'a'.repeat(64)}};
 assert.equal((await adapter.execute(restore)).replayed,false);
 assert.equal((await adapter.execute(restore)).replayed,true);
 assert.equal((await ref('records','record-001').get()).data().revision,3);
 assert.equal((await ref('records','record-001').get()).data().payload.value,'restored-synthetic');
 const before=(await ref('records','record-001').get()).data();
 await assert.rejects(provider.runTransaction(async tx=>{await tx.getControl();await tx.getPrincipal('operator');await tx.getRecord('record-001');await tx.getRequest('request-fail');await tx.putRecord('record-001',{revision:4,tombstone:false,payload:{value:'bad'}},{expectedRevision:3,fencingToken:1});throw Error('synthetic failure');},{databaseUid:targetUid,deadlineMs:Date.now()+30000}));
 assert.deepEqual((await ref('records','record-001').get()).data(),before);
 assert.equal((await ref('requests','request-fail').get()).exists,false);
 await adapter.execute({...r,operation:'delete',requestId:'request-delete',expectedRevision:3});
 assert.deepEqual((await ref('records','record-001').get()).data(),{revision:4,tombstone:true});
 await assert.rejects(adapter.execute({...restore,requestId:'request-no-resurrect',expectedRevision:4}),/TOMBSTONED/);
 await ref('principals','operator').update({enabled:false});
 await assert.rejects(adapter.execute({...r,requestId:'request-blocked',recordId:'record-blocked'}),/AUTHORIZATION/);
 assert.equal((await ref('records','record-blocked').get()).exists,false);
 assert.equal((await ref('control','active').get()).data().publishAllowed,false);
 await assert.rejects(createFirestoreWriteProvider({...cfg,executionMode:'production'}).runTransaction(()=>{},{}),/DISABLED/);
 console.log('FIRESTORE_WRITE_EMULATOR_OK: concurrent idempotency, revision conflict, restore/retry, tombstone protection, rollback, authority denial, production hard deny; UID/auth/restore evidence synthetic');
}
main().catch(()=>{console.error('FIRESTORE_WRITE_EMULATOR_FAILED');process.exitCode=1;}).finally(async()=>{await db.terminate();await deleteApp(app);});
