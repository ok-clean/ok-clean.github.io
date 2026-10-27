'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {createReceiptHttpHandler} = require('./receipt-http-adapter.cjs');
(async () => {
  let calls = 0;
  const handler = createReceiptHttpHandler({
    allowedOrigins:['https://ok-clean.github.io'],
    lookupReceipt:async ({idToken,requestId}) => {
      calls++;
      assert.equal(idToken,'demo.jwt.token');
      if (requestId === 'failure') throw Error('database secret and PII');
      if (requestId === 'badshape') return {httpStatus:200,body:{status:'some-secret'}};
      return {httpStatus:requestId === 'mine' ? 200 : 404,body:{status:requestId === 'mine'?'confirmed':'unavailable',secret:'NEVER RETURN'}};
    }
  });
  const server = http.createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(()=>{res.destroy();});});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  try {
    const auth={authorization:'Bearer demo.jwt.token','content-type':'application/json',origin:'https://ok-clean.github.io'};
    const post=(id,headers=auth)=>fetch(base+'/api/receipt-status',{method:'POST',headers,body:JSON.stringify({requestId:id})});
    let r=await post('mine');
    assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'confirmed'});
    assert.equal(r.headers.get('access-control-allow-origin'),'https://ok-clean.github.io');
    assert.match(r.headers.get('cache-control'),/no-store/);
    assert.equal(r.headers.get('x-content-type-options'),'nosniff');
    r=await post('foreign');assert.equal(r.status,404);assert.deepEqual(await r.json(),{status:'unavailable'});
    r=await post('failure');assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret|PII/);
    r=await post('badshape');assert.equal(r.status,503);
    const before=calls;
    r=await post('mine',{...auth,origin:'https://evil.example'});assert.equal(r.status,403);assert.equal(calls,before);
    r=await post('mine',{'content-type':'application/json',origin:'https://ok-clean.github.io'});assert.equal(r.status,401);assert.equal(calls,before);
    r=await post('mine',{...auth,'content-type':'text/plain'});assert.equal(r.status,415);
    r=await fetch(base+'/api/receipt-status',{method:'GET'});assert.equal(r.status,405);
    r=await fetch(base+'/wrong',{method:'POST',headers:auth,body:'{}'});assert.equal(r.status,404);
    r=await fetch(base+'/api/receipt-status',{method:'OPTIONS',headers:{origin:'https://ok-clean.github.io','access-control-request-headers':'authorization,content-type'}});
    assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-methods'),'POST, OPTIONS');
    r=await fetch(base+'/api/receipt-status',{method:'POST',headers:auth,body:JSON.stringify({requestId:'mine',phone:'01012345678'})});assert.equal(r.status,400);
    r=await fetch(base+'/api/receipt-status',{method:'POST',headers:auth,body:'not-json'});assert.equal(r.status,400);
    r=await fetch(base+'/api/receipt-status',{method:'POST',headers:auth,body:JSON.stringify({requestId:'x'.repeat(1500)})});assert.equal(r.status,413);
    console.log('PASS HTTP bearer authentication, strict CORS, no-store, payload limits, sanitized responses and privacy');
  } finally { await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve())); }
})().catch(err=>{console.error(err);process.exitCode=1});
