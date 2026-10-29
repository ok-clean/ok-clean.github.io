'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createGoogleOidcVerifier,attachDemoRetentionRoute}=require('../server/demo-retention-route.cjs');
test('Google verifier delegates signature and audience verification to OAuth2Client',async()=>{
 let called;class FakeClient{async verifyIdToken(arg){called=arg;return {getPayload:()=>({iss:'https://accounts.google.com',aud:'https://example.test'})};}}
 const verify=createGoogleOidcVerifier(FakeClient);assert.equal((await verify('signed-token','https://example.test')).aud,'https://example.test');assert.deepEqual(called,{idToken:'signed-token',audience:'https://example.test'});
});
test('Google verifier rejects library errors without accepting claims',async()=>{class FakeClient{async verifyIdToken(){throw Error('bad signature');}}await assert.rejects(createGoogleOidcVerifier(FakeClient)('bad','https://example.test'));});
test('route is off by default, and cannot be enabled against a production project',()=>{
 let called=false;const app={post(){called=true;}};assert.equal(attachDemoRetentionRoute({app,db:{},env:{}}),false);
 assert.throws(()=>attachDemoRetentionRoute({app,db:{projectId:'real-project'},env:{OKCLEAN_DEMO_RETENTION_ENABLED:'true',GCLOUD_PROJECT:'real-project'}}),/DEMO_EMULATOR_REQUIRED/);assert.equal(called,false);
});
test('demo route is mounted before application authentication and rejects missing tokens',async()=>{
 const keys=['GCLOUD_PROJECT','FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{GCLOUD_PROJECT:'demo-okclean-integration',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8085',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
 try{
  const env={...process.env,OKCLEAN_DEMO_RETENTION_ENABLED:'true',OKCLEAN_DEMO_POLICY_REVIEWED:'true',OKCLEAN_DEMO_RESERVATION_DAYS:'30',OKCLEAN_DEMO_HISTORY_DAYS:'90',OKCLEAN_DEMO_POLICY_VERSION:'demo-1',OKCLEAN_DEMO_SCHEDULER_AUDIENCE:'https://scheduler.example.test',OKCLEAN_DEMO_SCHEDULER_ACCOUNT:'scheduler@demo-ok.iam.gserviceaccount.com'};
  let handler,path;const app={post(p,h){path=p;handler=h;}};const db={projectId:'demo-okclean-integration',runTransaction(){throw Error('unexpected read');},collection(){return {doc(){return {}}};}};
  assert.throws(()=>attachDemoRetentionRoute({app,db,createLedgerDb:()=>db,env,verifyOidc:async()=>({})}),/DEMO_LEDGER_REQUIRED/);
  const ledgerDb={...db,projectId:'demo-okclean-ledger'};
  assert.equal(attachDemoRetentionRoute({app,db,createLedgerDb:()=>ledgerDb,env,verifyOidc:async()=>{throw Error('unexpected verify');}}),true);assert.equal(path,'/_internal/demo/retention/run');
  const res={set(){return this},status(c){this.code=c;return this},json(v){this.body=v;return this}};await handler({method:'POST',headers:{}},res);assert.equal(res.code,401);
 }finally{for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}
});
