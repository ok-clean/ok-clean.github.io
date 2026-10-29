'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {createComparisonHttpHandler}=require('./comparison-http-adapter.cjs');
const {createComparisonClient}=require('./comparison-client.js');
const endpoint='https://ok-clean.example/api/offer-comparison';
const accepted={status:'ok',offers:[{company:'가상업체',price:250000}]};
const response=(value,opts={})=>new Response(typeof value==='string'?value:JSON.stringify(value),{status:opts.status||200,headers:{'content-type':opts.type||'application/json'}});
const makeClient=(overrides={})=>createComparisonClient({endpoint,getIdToken:async()=> 'test.token',getRequestId:async()=> 'r',fetchImpl:async()=>response(accepted),...overrides});
test('client accepts validated fields and sends an authenticated noncached request',async()=>{
 let seen;
 const load=makeClient({fetchImpl:async(url,init)=>{seen={url,init};return response(accepted)}});
 assert.deepEqual(await load(),accepted.offers);
 assert.equal(seen.url,endpoint);assert.equal(seen.init.method,'POST');
 assert.equal(seen.init.credentials,'omit');assert.equal(seen.init.redirect,'error');assert.equal(seen.init.cache,'no-store');
 assert.deepEqual(JSON.parse(seen.init.body),{requestId:'r'});assert.equal(seen.init.headers.Authorization,'Bearer test.token');
});
test('client rejects insecure endpoint, malformed ID and missing token without sending',async()=>{
 assert.throws(()=>makeClient({endpoint:'http://ok-clean.example/api/offer-comparison'}),TypeError);
 assert.throws(()=>makeClient({endpoint:endpoint+'?token=secret'}),TypeError);
 let calls=0;const fetchImpl=async()=>{calls++;return response(accepted)};
 for(const overrides of [{getRequestId:async()=>'../bad'},{getIdToken:async()=>''}])await assert.rejects(makeClient({...overrides,fetchImpl})(),/불러오지/);
 assert.equal(calls,0);
});
test('client fails closed for extra fields, oversized payloads, invalid responses and timeout',async()=>{
 const bad=[{status:'ok',offers:[{company:'업체',price:0}]},{status:'ok',offers:[{company:'업체',price:1,phone:'PRIVATE'}]},
  {status:'ok',offers:Array(4).fill({company:'업체',price:1})},{status:'ok',offers:[],name:'PRIVATE'},'x'.repeat(2200)];
 for(const item of bad)await assert.rejects(makeClient({fetchImpl:async()=>response(item)})(),/불러오지/);
 await assert.rejects(makeClient({fetchImpl:async()=>response('offline',{status:503})})(),/불러오지/);
 await assert.rejects(makeClient({fetchImpl:async()=>response(accepted,{type:'text/plain'})})(),/불러오지/);
 let calls=0;
 const load=makeClient({timeoutMs:20,getIdToken:()=>new Promise(r=>setTimeout(()=>r('test.token'),80)),fetchImpl:async()=>{calls++;return response(accepted)}});
 await assert.rejects(load(),/불러오지/);await new Promise(r=>setTimeout(r,100));assert.equal(calls,0);
});
test('external reset aborts an outstanding token lookup before a request is sent',async()=>{
 let calls=0;const abort=new AbortController();
 const load=makeClient({getIdToken:()=>new Promise(r=>setTimeout(()=>r('test.token'),80)),fetchImpl:async()=>{calls++;return response(accepted)}});
 const pending=load({signal:abort.signal});setTimeout(()=>abort.abort(),10);
 await assert.rejects(pending,/불러오지/);await new Promise(r=>setTimeout(r,100));assert.equal(calls,0);
});
test('HTTP adapter restricts origin, payload and response without exposing secret fields',async()=>{
 let calls=0;
 const handler=createComparisonHttpHandler({allowedOrigins:['https://ok-clean.example'],lookupComparison:async({requestId})=>{
  calls++;if(requestId==='foreign')return {httpStatus:404,body:{status:'unavailable',secret:'PRIVATE'}};
  if(requestId==='broken')return {httpStatus:200,body:{...accepted,phone:'PRIVATE'}};
  if(requestId==='failure')throw Error('PRIVATE SECRET');return {httpStatus:200,body:accepted};
 }});
 const server=http.createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(()=>res.destroy());});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const auth={authorization:'Bearer test.token','content-type':'application/json',origin:'https://ok-clean.example'};
 const post=(id,headers=auth)=>fetch(base+'/api/offer-comparison',{method:'POST',headers,body:JSON.stringify({requestId:id})});
 try{
  let r=await post('r');assert.equal(r.status,200);assert.deepEqual(await r.json(),accepted);assert.match(r.headers.get('cache-control'),/no-store/);
  assert.equal(r.headers.get('access-control-allow-origin'),'https://ok-clean.example');
  r=await post('foreign');assert.equal(r.status,404);assert.deepEqual(await r.json(),{status:'unavailable'});
  for(const id of ['broken','failure']){r=await post(id);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/PRIVATE|SECRET/);}
  const before=calls;r=await post('r',{...auth,origin:'https://evil.example'});assert.equal(r.status,403);assert.equal(calls,before);
  r=await post('r',{'content-type':'application/json'});assert.equal(r.status,401);
  r=await fetch(base+'/api/offer-comparison',{method:'POST',headers:auth,body:JSON.stringify({requestId:'r',phone:'PRIVATE'})});assert.equal(r.status,400);
  r=await fetch(base+'/api/offer-comparison',{method:'POST',headers:auth,body:JSON.stringify({requestId:'x'.repeat(1500)})});assert.equal(r.status,413);
  r=await fetch(base+'/api/offer-comparison',{method:'OPTIONS',headers:{origin:'https://ok-clean.example','access-control-request-method':'POST','access-control-request-headers':'authorization,content-type'}});assert.equal(r.status,204);
 }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
