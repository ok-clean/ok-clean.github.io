'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
// The fixture is extracted from config.json by the test runner; never trust client price data.
const {createPricePolicy,version}=require('../server/pricing.cjs');
const services=require('../config.json').services;const check=createPricePolicy(services),policyVersion=version(services);
function item(serviceId,extra={},amount={}){const labels={'move-in':'입주·이사 청소',regular:'거주·정기 청소',office:'사무실·상가 청소',clinic:'사무실·상가 청소',aircon:'에어컨 청소'};return {service:labels[serviceId]||'그 외 청소',pricing:{serviceId,variant:0,tier:null,quantity:null,options:[],policyVersion,...extra},...amount};}
test('입주 정액, 옵션 및 금액 범위',()=>{const form=item('move-in',{tier:0,options:[0]},{estimateMin:180000,estimateMax:200000});assert.ok(check(form));assert.equal(check({...form,estimateMin:1}),null);assert.equal(check({...form,estimateMax:180000}),null);});
test('구축 개방 가격, 현장견적 선택',()=>{assert.ok(check(item('move-in',{variant:1,tier:0},{estimateMin:150000})));assert.ok(check(item('move-in',{tier:5},{})));assert.equal(check(item('move-in',{tier:5},{estimateMin:0})),null);});
test('정기 청소 최소금액과 옵션 계산',()=>{assert.ok(check(item('regular',{quantity:10,options:[0]},{estimateMin:150000,estimateMax:170000})));assert.equal(check(item('regular',{quantity:10,options:[0]},{estimateMin:130000,estimateMax:170000})),null);});
test('사무실 개방 가격과 현장 옵션, 정기 현장견적',()=>{assert.ok(check(item('office',{quantity:30,options:[0]},{estimateMin:300000})));assert.ok(check(item('office',{variant:1,quantity:1},{})));});
test('수량 오류, 옵션 조작, 오래된 가격표, 서비스 속임수 거부',()=>{const f=item('move-in',{tier:0},{estimateMin:150000,estimateMax:150000});for(const patch of [{tier:99},{options:[0,0]},{policyVersion:'bad'},{quantity:1000},{serviceId:'missing'}])assert.equal(check({...f,pricing:{...f.pricing,...patch}}),null);assert.equal(check({...f,service:'에어컨 청소'}),null);});
test('옵션 정규화는 가격 변경 없이 순서 고정',()=>{const f=item('move-in',{tier:0,options:[1,0]},{estimateMin:210000,estimateMax:250000});assert.deepEqual(check(f).options,[0,1]);});
test('실제 홈페이지 계산기와 서비스·등급·종류별 계산 일치',()=>{
 const fs=require('node:fs');const src=fs.readFileSync(require.resolve('../app.js'),'utf8');
 const begin=src.indexOf('function estimate(){'),end=src.indexOf('\nfunction summary(){',begin);assert.ok(begin>0&&end>begin);
 const original=new Function('svc','cur','missingQty','isQuote',src.slice(begin,end)+';return estimate();');
 let count=0;
 for(const s of services){const tiers=s.tiers||[],variants=tiers.length?s.kinds||[]:s.variants||[];for(let v=0;v<Math.max(1,variants.length);v++)for(let t=0;t<Math.max(1,tiers.length);t++)for(const opts of [[],(s.options||[]).map((_,i)=>i)]){
  const cur={svc:s.id,v,t:tiers.length?t:null,qty:tiers.length||s.quote?null:7,opts};
  const r=original(()=>s,cur,()=>false,x=>x.quote||(!(x.tiers||[]).length&&!(x.variants||[]).length));
  const amounts={};if(r?.lo!=null)amounts.estimateMin=r.lo;if(r?.hi!=null)amounts.estimateMax=r.hi;
  assert.ok(check(item(s.id,{variant:v,tier:cur.t,quantity:cur.qty,options:opts},amounts)),`${s.id}/${v}/${t}/${opts}`);count++;
 }}assert.ok(count>=40);
});
