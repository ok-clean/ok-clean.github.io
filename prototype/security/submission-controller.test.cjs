const assert = require('node:assert/strict');
const {createSubmissionController} = require('./submission-controller.cjs');
function deferred(){let resolve,reject;let promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
(async()=>{
 let d=deferred(), count=0;
 let ctrl=createSubmissionController(()=>{count++;return d.promise},{timeoutMs:20});
 const first=ctrl.submit('one',{});assert.equal(ctrl.getState(),'pending');
 assert.throws(()=>ctrl.submit('two',{}));
 await new Promise(r=>setTimeout(r,50));assert.equal(ctrl.getState(),'unknown');assert.throws(()=>ctrl.submit('three',{}));
 d.resolve({id:'one'});assert.equal((await first).id,'one');assert.equal(ctrl.getState(),'success');assert.equal(count,1);
 let err=createSubmissionController(async()=>{throw new Error('network unavailable')},{timeoutMs:20});
 await assert.rejects(err.submit('x',{}));assert.equal(err.getState(),'unknown');assert.throws(()=>err.submit('x',{}));
 let ok=createSubmissionController(async()=>({id:'ok'}),{timeoutMs:100});await ok.submit('ok',{});assert.equal(ok.getState(),'success');
 console.log('PASS pending, repeated-click prevention, uncertain timeout, late acknowledgement, and error');
})().catch(e=>{console.error(e);process.exit(1)});
