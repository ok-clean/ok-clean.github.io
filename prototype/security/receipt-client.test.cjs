'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {setTimeout:wait} = require('node:timers/promises');
const {createReceiptClient} = require('./receipt-client.js');
const {createReceiptStatusHandler} = require('./receipt-status-handler.cjs');
const {createReceiptHttpHandler} = require('./receipt-http-adapter.cjs');
const {createSubmissionController} = require('./submission-controller.cjs');
const endpoint='https://backend.example/api/receipt-status';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function client(options={}) {return createReceiptClient({endpoint,getIdToken:async()=> 'fake.token',...options});}
async function serve(t,handler) {
 const server=http.createServer((req,res)=>void Promise.resolve(handler(req,res)).catch(()=>res.destroy()));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 return 'http://127.0.0.1:'+server.address().port+'/api/receipt-status';
}
test('rejects insecure/non-receipt endpoints, credentials, URL tokens and invalid timeouts',()=>{
 for(const value of ['http://backend.example/api/receipt-status','https://user:pass@backend.example/api/receipt-status',endpoint+'?token=x',endpoint+'#x','https://backend.example/wrong']) assert.throws(()=>client({endpoint:value}));
 assert.throws(()=>client({timeoutMs:Infinity}));assert.throws(()=>client({endpoint:'http://127.0.0.1/api/receipt-status'}));
});
test('invalid request ID never invokes token or network callbacks',async()=>{
 let calls=0;const check=client({getIdToken:async()=>{calls++;return 'fake'},fetchImpl:async()=>{calls++;return json({status:'confirmed'})}});
 await assert.rejects(check('../bad'));assert.equal(calls,0);
});
test('missing token never sends a request',async()=>{
 let calls=0;const check=client({getIdToken:async()=>null,fetchImpl:async()=>{calls++;return json({status:'confirmed'})}});
 assert.equal(await check('demo'),'unavailable');assert.equal(calls,0);
});
test('read-only request uses no cookies, redirects, referrer or cache; token stays out of URL/body',async()=>{
 let count=0;const check=client({fetchImpl:async(url,options)=>{
  count++;assert.equal(url,endpoint);assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.headers.Authorization,'Bearer fake.token');
  assert.equal(options.body,'{"requestId":"demo"}');assert.equal(options.signal instanceof AbortSignal,true);return json({status:'confirmed'});
 }});
 assert.equal(await check('demo'),'confirmed');assert.equal(count,1);
});
for(const code of [401,403,404,429,503])test('HTTP '+code+' is unavailable with no automatic retry',async()=>{
 let count=0;const check=client({fetchImpl:async()=>{count++;return json({status:'unavailable'},code)}});
 assert.equal(await check('demo'),'unavailable');assert.equal(count,1);
});
test('extra fields, HTML, oversized replies and invalid UTF-8 are not accepted as confirmation',async()=>{
 const replies=[json({status:'confirmed',phone:'fake-private'}),new Response('<html>login</html>'),json({status:'x'.repeat(500)}),new Response(Buffer.from([0xff]),{headers:{'content-type':'application/json'}})];
 for(const reply of replies)assert.equal(await client({fetchImpl:async()=>reply})('demo'),'unavailable');
});
test('timeout during token retrieval prevents a late network request',async()=>{
 let release,calls=0;const token=new Promise(r=>{release=r});
 const check=client({getIdToken:()=>token,timeoutMs:20,fetchImpl:async()=>{calls++;return json({status:'confirmed'})}});
 assert.equal(await check('demo'),'unavailable');release('fake.token');await wait(5);assert.equal(calls,0);
});
test('lookup has a deadline even when a broken fetch ignores AbortSignal',async()=>{
 let signal;const check=client({timeoutMs:20,fetchImpl:async(_,o)=>{signal=o.signal;return new Promise(()=>{})}});
 assert.equal(await check('demo'),'unavailable');assert.equal(signal.aborted,true);
});
test('redirects never forward a bearer token to another endpoint',async t=>{
 let leaked=0;const url=await serve(t,(req,res)=>{
  if(req.url==='/api/receipt-status'){res.writeHead(302,{location:'/other'});res.end();}
  else{leaked++;res.end('{}');}
 });
 assert.equal(await client({endpoint:url,allowLocalTesting:true})('demo'),'unavailable');assert.equal(leaked,0);
});
test('client -> HTTP -> verified-owner handler -> synthetic database and submission reconciliation',async t=>{
 let uid='owner',provider='password',verified=true,blocked=false,reads=0,writes=0;
 const core=createReceiptStatusHandler({
  verifyIdToken:async token=>{assert.equal(token,'fake.token');return {uid,email_verified:verified,firebase:{sign_in_provider:provider}}},
  enforceRateLimit:async()=>!blocked,
  loadRequest:async id=>{reads++;return id==='demo'?{ownerUid:'owner',name:'PRIVATE',phone:'NOT_A_REAL_NUMBER'}:null}
 });
 const url=await serve(t,createReceiptHttpHandler({lookupReceipt:core,allowedOrigins:['https://ok-clean.github.io']}));
 const check=client({endpoint:url,allowLocalTesting:true});
 assert.equal(await check('demo'),'confirmed');
 uid='other';assert.equal(await check('demo'),'unavailable');assert.equal(await check('missing'),'unavailable');
 uid='owner';provider='anonymous';const before=reads;assert.equal(await check('demo'),'unavailable');assert.equal(reads,before);
 provider='password';verified=false;assert.equal(await check('demo'),'unavailable');assert.equal(reads,before);
 verified=true;blocked=true;assert.equal(await check('demo'),'unavailable');assert.equal(reads,before);
 blocked=false;
 const controller=createSubmissionController(async()=>{writes++;throw Error('write acknowledgement lost')});
 await assert.rejects(controller.submit('demo',{}));assert.equal(controller.getState(),'unknown');
 assert.equal(await controller.reconcile(check),'confirmed');assert.equal(controller.getState(),'success');
 assert.throws(()=>controller.submit('demo',{}));assert.equal(writes,1);
});
