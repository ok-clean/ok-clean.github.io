'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createVerifiedReservationHandler}=require('../prototype/security/verified-reservation-handler.cjs');
function fixture(){
  const docs=new Map(); let lock=Promise.resolve();
  const db={collection:()=>({doc:id=>id}),runTransaction(fn){const op=lock.then(async()=>fn({get:async id=>({exists:docs.has(id),data:()=>docs.get(id)}),create:(id,data)=>{if(docs.has(id))throw Error('exists');docs.set(id,data);}}));lock=op.catch(()=>{});return op;}};
  const auth={a:{uid:'a',email_verified:true,firebase:{sign_in_provider:'password'}},b:{uid:'b',email_verified:true,firebase:{sign_in_provider:'password'}},anon:{uid:'a',firebase:{sign_in_provider:'anonymous'}}};
  const handler=createVerifiedReservationHandler({db,verifyIdToken:async token=>{if(!auth[token])throw Error('bad token');return auth[token];},enforceRateLimit:async()=>true,now:()=>new Date('2030-01-01T00:00:00Z')});
  const form={service:'입주·이사 청소',area:'춘천',size:25,date:'2030-01-02',name:'가상고객',phone:'010-0000-0000',notes:'테스트',consent:true,estimateMin:100,estimateMax:200};
  return {docs,handler,form};
}
test('동시 재시도와 응답 손실 후 동일 요청은 문서 한 건',async()=>{const {docs,handler,form}=fixture();const call=()=>handler({idToken:'a',requestId:'receipt-1',form});const results=await Promise.all([call(),call(),call()]);assert.ok(results.every(r=>r.body.status==='confirmed'));assert.equal(docs.size,1);assert.equal((await call()).body.status,'confirmed');assert.equal(docs.size,1);});
test('다른 사용자, 변경된 내용 및 익명 인증 거부',async()=>{const {docs,handler,form}=fixture();await handler({idToken:'a',requestId:'receipt-1',form});for(const x of [{idToken:'b',form},{idToken:'a',form:{...form,notes:'변경'}},{idToken:'anon',form}])assert.notEqual((await handler({...x,requestId:'receipt-1'})).body.status,'confirmed');assert.equal(docs.size,1);});
test('동일 이름과 전화번호라도 새 요청은 별도 예약',async()=>{const {docs,handler,form}=fixture();for(const requestId of ['receipt-1','receipt-2'])assert.equal((await handler({idToken:'a',requestId,form})).body.status,'confirmed');assert.equal(docs.size,2);});
test('잘못된 날짜, 입력, 인증은 저장하지 않음',async()=>{const {docs,handler,form}=fixture();for(const f of [{...form,date:'2030-02-30'},{...form,consent:false},{...form,estimateMin:-1}])assert.equal((await handler({idToken:'a',requestId:'receipt-1',form:f})).httpStatus,400);assert.equal((await handler({idToken:'wrong',requestId:'receipt-1',form})).httpStatus,401);assert.equal(docs.size,0);});
