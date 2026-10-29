'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createFirestoreIdentityResolver}=require('../server/firestore-identity.cjs');
const projectId='sample-clean-prod',databaseId='(default)',uid='123e4567-e89b-42d3-a456-426614174000';
test('resolver binds a fixed Google API resource to its system UID',async()=>{
 let request;
 const resolve=createFirestoreIdentityResolver({auth:{getClient:async()=>({request:async x=>{request=x;return {data:{name:`projects/${projectId}/databases/${databaseId}`,uid}};}})}});
 assert.deepEqual(await resolve({projectId,databaseId}),{projectId,databaseId,uid});
 assert.equal(request.url,`https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}`);
 assert.equal(request.maxRedirects,0);assert.equal(request.method,'GET');
});
test('resolver rejects wrong resource, malformed UID, error and stalled credentials',async()=>{
 for(const data of [{name:'projects/other-project/databases/(default)',uid},{name:`projects/${projectId}/databases/${databaseId}`,uid:'not-a-uuid'}]){
  const resolve=createFirestoreIdentityResolver({auth:{getClient:async()=>({request:async()=>({data})})}});
  await assert.rejects(resolve({projectId,databaseId}),/DATABASE_IDENTITY_INVALID/);
 }
 const failed=createFirestoreIdentityResolver({auth:{getClient:async()=>{throw Error('transport failure');}}});await assert.rejects(failed({projectId,databaseId}));
 const stalled=createFirestoreIdentityResolver({auth:{getClient:()=>new Promise(()=>{})},timeoutMs:10});await assert.rejects(stalled({projectId,databaseId}),/DATABASE_IDENTITY_TIMEOUT/);
 await assert.rejects(failed({projectId:'bad/',databaseId}),/DATABASE_IDENTITY_CONFIGURATION_INVALID/);
});
