'use strict';
// Loopback HTTP with synthetic token verifier. Real Firestore emulator, no real OIDC token.
const http=require('node:http'),assert=require('node:assert/strict'),admin=require('firebase-admin');
const {attachDemoRetentionRoute}=require('../server/demo-retention-route.cjs');
const project='demo-okclean-integration';
if(process.env.GCLOUD_PROJECT!==project||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const firebase=admin.initializeApp({projectId:project},'demo-retention-http'),db=admin.firestore(firebase),ref=db.collection('quote_requests').doc('synthetic-http-retention');
 let server;
 try{
  await ref.create({status:'종료',legalHold:false,name:'가상고객'});
  await ref.collection('status_history').doc('event').create({from:'상담중',to:'종료',at:new Date('2020-01-01T00:00:00Z')});
  const aud='https://scheduler.example.test',email='scheduler@demo-ok.iam.gserviceaccount.com';
  const env={...process.env,OKCLEAN_DEMO_RETENTION_ENABLED:'true',OKCLEAN_DEMO_POLICY_REVIEWED:'true',OKCLEAN_DEMO_RESERVATION_DAYS:'30',OKCLEAN_DEMO_HISTORY_DAYS:'90',OKCLEAN_DEMO_POLICY_VERSION:'demo-1',OKCLEAN_DEMO_SCHEDULER_AUDIENCE:aud,OKCLEAN_DEMO_SCHEDULER_ACCOUNT:email};
  let handler;const app={post(path,fn){assert.equal(path,'/_internal/demo/retention/run');handler=fn;}};
  attachDemoRetentionRoute({app,db,env,verifyOidc:async token=>{if(token!=='synthetic')throw Error('invalid');return {aud,iss:'https://accounts.google.com',email_verified:true,email};}});
  server=http.createServer(async(req,res)=>{
   if(req.url!=='/_internal/demo/retention/run'){res.writeHead(404).end();return;}
   res.set=(key,value)=>{res.setHeader(key,value);return res;};res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return res;};
   await handler(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/_internal/demo/retention/run`;
  assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal((await ref.get()).data().name,'가상고객');
  const ok=await fetch(url,{method:'POST',headers:{authorization:'Bearer synthetic'}});assert.equal(ok.status,200);assert.equal((await ref.get()).data().name,undefined);
  assert.equal((await db.collection('retention_scheduler_runs').get()).size,1);
  console.log('PASS demo scheduler via loopback HTTP and synthetic Firestore; OIDC verification is a test double');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await firebase.delete();}
}
main().catch(()=>{console.error('DEMO_HTTP_TEST_FAILED');process.exitCode=1;});
