'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {setTimeout:wait} = require('node:timers/promises');
const {createReceiptHttpHandler} = require('./receipt-http-adapter.cjs');
const {createSubmissionController} = require('./submission-controller.cjs');
const origin = 'https://ok-clean.github.io';
const good = {httpStatus:200, body:{status:'confirmed',private:'MUST_NOT_LEAK'}};
function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b}); return {promise,resolve,reject}; }
async function serverFor(t, options={}) {
 const handler=createReceiptHttpHandler({allowedOrigins:[origin], lookupReceipt:async()=>good, bodyTimeoutMs:60, lookupTimeoutMs:60, ...options});
 const server=http.createServer((req,res)=>void Promise.resolve(handler(req,res)).catch(()=>res.destroy()));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 return server.address().port;
}
function request(port,{method='POST',path='/api/receipt-status',headers={},chunks=['{"requestId":"demo"}'],stall=false}={}) {
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{'content-type':'application/json',authorization:'Bearer fake.token',origin,...headers}},res=>{
   let text='';res.on('data',b=>{text+=b});res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
  });
  req.on('error',reject);req.setTimeout(2000,()=>req.destroy(new Error('Test transport deadline exceeded')));
  for(const chunk of chunks) req.write(chunk);
  if(!stall)req.end(); else req.flushHeaders();
 });
}
test('verified success cannot be undone by the original write rejecting late',async()=>{
 const d=deferred();const c=createSubmissionController(()=>d.promise,{timeoutMs:10});
 const sent=c.submit('demo',{});const rejected=assert.rejects(sent);
 await wait(30);assert.equal(c.getState(),'unknown');await c.reconcile(async()=> 'confirmed');
 d.reject(new Error('late transport failure'));await rejected;assert.equal(c.getState(),'success');
 assert.throws(()=>c.submit('new',{}));
});
test('throwing and rejecting UI listeners never suppress the single write',async()=>{
 let writes=0,errors=0;const states=[];
 const c=createSubmissionController(async()=>{writes++;return {id:'demo'}},{onListenerError:()=>{errors++}});
 c.onChange(()=>{throw Error('render failed')});c.onChange(async()=>{throw Error('async render failed')});c.onChange(s=>states.push(s));
 await c.submit('demo',{});await wait(0);
 assert.equal(writes,1);assert.equal(c.getState(),'success');assert.deepEqual(states,['pending','success']);assert.equal(errors,4);
 assert.throws(()=>c.onChange(null),TypeError);
});
test('mismatched write acknowledgement never becomes success',async()=>{
 const c=createSubmissionController(async()=>({id:'wrong'}));await assert.rejects(c.submit('demo',{}));assert.equal(c.getState(),'unknown');
});
test('hanging reconciliation times out, ignores late success, and allows only another read',async()=>{
 const d=deferred();const c=createSubmissionController(async()=>{throw Error('lost acknowledgement')},{checkTimeoutMs:20});
 await assert.rejects(c.submit('demo',{}));assert.equal(await c.reconcile(()=>d.promise),'unavailable');
 d.resolve('confirmed');await wait(0);assert.equal(c.getState(),'unknown');assert.throws(()=>c.submit('demo',{}));
 assert.equal(await c.reconcile(async()=> 'confirmed'),'confirmed');assert.equal(c.getState(),'success');
});
test('concurrent reconciliation is one read and absence never unlocks resubmission',async()=>{
 const d=deferred();let reads=0;const c=createSubmissionController(async()=>{throw Error('offline')});await assert.rejects(c.submit('demo',{}));
 const a=c.reconcile(()=>{reads++;return d.promise});const b=c.reconcile();d.resolve('absent');
 assert.deepEqual(await Promise.all([a,b]),['absent','absent']);assert.equal(reads,1);assert.throws(()=>c.submit('other',{}));
});
test('invalid timers and origin configuration fail closed',()=>{
 for(const timeoutMs of [NaN,0,2**32,-1])assert.throws(()=>createSubmissionController(()=>{},{timeoutMs}));
 for(const bad of ['http://example.test','https://example.test/','https://user@example.test','https://example.test:99999']) {
  assert.throws(()=>createReceiptHttpHandler({lookupReceipt:async()=>good,allowedOrigins:[bad]}));
 }
});
test('slow incomplete body receives a bounded 408 without a lookup',async t=>{
 let reads=0;const port=await serverFor(t,{lookupReceipt:async()=>{reads++;return good}});
 const r=await request(port,{chunks:['{'],stall:true});assert.equal(r.status,408);assert.equal(reads,0);assert.equal(r.headers.connection,'close');
});
test('hanging lookup returns sanitized 503 and receives abort signal',async t=>{
 let signal;const port=await serverFor(t,{lookupReceipt:async(_,{signal:s})=>{signal=s;return new Promise(()=>{})}});
 const r=await request(port);assert.equal(r.status,503);assert.equal(signal.aborted,true);assert.equal(r.text,'{"status":"unavailable"}');
});
test('late lookup rejection after timeout is contained',async t=>{
 const d=deferred();const port=await serverFor(t,{lookupReceipt:()=>d.promise});
 assert.equal((await request(port)).status,503);d.reject(Error('private backend error'));await wait(10);
});
test('oversized chunked body receives 413 rather than losing the response',async t=>{
 const port=await serverFor(t);const r=await request(port,{chunks:['{"requestId":"','x'.repeat(1024),'"}']});assert.equal(r.status,413);
});
test('declared oversized body is rejected before its contents arrive',async t=>{
 const port=await serverFor(t);assert.equal((await request(port,{headers:{'content-length':'9999'},chunks:[],stall:true})).status,413);
});
test('invalid UTF-8 is rejected before authentication and lookup',async t=>{
 let reads=0;const port=await serverFor(t,{lookupReceipt:async()=>{reads++;return good}});
 const body=Buffer.concat([Buffer.from('{"requestId":"'),Buffer.from([0xff]),Buffer.from('"}')]);
 assert.equal((await request(port,{chunks:[body]})).status,400);assert.equal(reads,0);
});
for(const [label,body] of [['array','[]'],['null','null'],['extra owner','{"requestId":"demo","ownerUid":"forged"}'],['path ID','{"requestId":"../demo"}'],['empty ID','{"requestId":""}']]) {
 test('rejects '+label+' before calling trusted services',async t=>{
  let reads=0;const port=await serverFor(t,{lookupReceipt:async()=>{reads++;return good}});
  assert.equal((await request(port,{chunks:[body]})).status,400);assert.equal(reads,0);
 });
}
test('duplicate authorization headers are rejected',async t=>{
 const port=await serverFor(t);assert.equal((await request(port,{headers:{authorization:['Bearer first','Bearer second']}})).status,400);
});
test('untrusted origin, encoding, and query token are rejected',async t=>{
 const port=await serverFor(t);
 assert.equal((await request(port,{headers:{origin:'https://attacker.example'}})).status,403);
 assert.equal((await request(port,{headers:{'content-encoding':'gzip'}})).status,415);
 assert.equal((await request(port,{path:'/api/receipt-status?token=fake'})).status,404);
});
test('preflight validates requested method and headers and emits an empty body',async t=>{
 const port=await serverFor(t);const headers={'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'};
 const r=await request(port,{method:'OPTIONS',headers,chunks:[]});assert.equal(r.status,204);assert.equal(r.text,'');
 assert.equal((await request(port,{method:'OPTIONS',headers:{...headers,'access-control-request-method':'DELETE'},chunks:[]})).status,403);
 assert.equal((await request(port,{method:'OPTIONS',headers:{...headers,'access-control-request-headers':'x-admin'},chunks:[]})).status,403);
});
test('success and rate-limit responses never return database payloads and are not cacheable',async t=>{
 let blocked=false;const port=await serverFor(t,{lookupReceipt:async()=>blocked?{httpStatus:429,body:{private:'secret'}}:good});
 let r=await request(port);assert.equal(r.status,200);assert.equal(r.text,'{"status":"confirmed"}');assert.match(r.headers['cache-control'],/no-store/);
 blocked=true;r=await request(port);assert.equal(r.status,429);assert.equal(r.text,'{"status":"unavailable"}');
});
