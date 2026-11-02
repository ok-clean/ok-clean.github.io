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

test('저장 본체 누락·변조는 같은 지문으로도 확정하지 않고 기존 문서를 보존',async()=>{
  const mutations=[
    r=>delete r.service,r=>r.service='그 외 청소',r=>delete r.area,r=>r.area='가평',
    r=>delete r.size,r=>r.size=26,r=>delete r.name,r=>r.name='변조',r=>delete r.phone,r=>r.phone='01011112222',
    r=>delete r.notes,r=>r.notes='변조',r=>delete r.estimateMin,r=>r.estimateMin=101,
    r=>delete r.estimateMax,r=>r.estimateMax=201,r=>r.estimateMin='100',
    r=>r.ownerUid='b',r=>delete r.ownerUid,r=>r.requestFingerprint='0'.repeat(64),
    r=>delete r.date,r=>r.date='2030-01-02',r=>r.date=new Date('2030-01-03T14:59:59.999Z'),
    r=>r.date=new Date('invalid'),r=>delete r.createdAt,r=>r.createdAt='2030-01-01',
    r=>r.createdAt=new Date('2031-01-01'),r=>delete r.consentAt,r=>r.consentAt=0,
    r=>r.consentAt={toDate(){throw Error('broken timestamp');}},r=>delete r.consentVersion,
    r=>r.consentVersion='',r=>r.consentVersion=3,r=>r.status='unknown',r=>delete r.status,
    r=>r.retentionRedacted=true,r=>r.dataMutationFrozen=true,r=>r.status='보유기간만료'
  ];
  for(const mutate of mutations){
    const {docs,handler,form}=fixture();const request={idToken:'a',requestId:'receipt-1',form};
    assert.equal((await handler(request)).httpStatus,200);const record=docs.get('receipt-1');mutate(record);
    const keys=Reflect.ownKeys(record);const values=keys.map(k=>record[k]);
    assert.equal((await handler(request)).httpStatus,409);
    assert.equal(docs.get('receipt-1'),record);assert.deepEqual(Reflect.ownKeys(record),keys);
    for(let i=0;i<keys.length;i++)assert.equal(record[keys[i]],values[i]);
    assert.equal(docs.size,1);
  }
});
test('정상 관리자 상태·추가 필드와 Timestamp 저장값은 재시도 후에도 보존',async()=>{
  for(const status of ['신규','검토중','상담중','예약확정','작업완료','종료','취소']){
    const {docs,handler,form}=fixture();const req={idToken:'a',requestId:'receipt-1',form};await handler(req);
    const record=docs.get('receipt-1');record.status=status;record.adminNote='가상 관리기록';record.legalHold=true;
    for(const key of ['date','createdAt','consentAt']){const value=record[key];record[key]={toDate:()=>new Date(value.getTime())};}
    assert.equal((await handler(req)).httpStatus,200);assert.equal(record.status,status);assert.equal(record.adminNote,'가상 관리기록');assert.equal(record.legalHold,true);assert.equal(docs.size,1);
  }
});
test('선택적 가격·pricing 누락과 변조는 거부하고 입력 정규형과 일치하는 저장값만 확인',async()=>{
  for(const mutate of [r=>delete r.pricing,r=>r.pricing.quantity=2,r=>r.pricing.options=[1],r=>r.estimateMax=999]){
    const {docs,handler,form}=fixture();form.name=' 가상고객 ';form.pricing={serviceId:'move-in',quantity:1,options:[]};
    const req={idToken:'a',requestId:'receipt-1',form};assert.equal((await handler(req)).httpStatus,200);
    const record=docs.get('receipt-1');assert.equal(record.name,'가상고객');assert.equal((await handler(req)).httpStatus,200);
    // A database read is independent from the caller's mutable input object.
    record.pricing=structuredClone(record.pricing);mutate(record);const snapshot=structuredClone(record);
    assert.equal((await handler(req)).httpStatus,409);assert.deepEqual(record,snapshot);
  }
  const {docs,handler,form}=fixture();delete form.estimateMin;delete form.estimateMax;
  const req={idToken:'a',requestId:'receipt-1',form};assert.equal((await handler(req)).httpStatus,200);assert.equal((await handler(req)).httpStatus,200);
  docs.get('receipt-1').estimateMin=0;assert.equal((await handler(req)).httpStatus,409);
});
test('탈퇴 생명주기와 삭제된 저장본은 동일 지문으로 재활성화되지 않음',async()=>{
  const {docs,handler,form}=fixture();const req={idToken:'a',requestId:'receipt-1',form};await handler(req);
  const record=docs.get('receipt-1');docs.set('a',{status:'withdrawal_requested'});
  assert.equal((await handler(req)).httpStatus,409);assert.equal(docs.get('receipt-1'),record);
});
