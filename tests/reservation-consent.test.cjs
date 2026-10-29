'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const start=src.indexOf('function reservationConsentPolicy(settings){'),end=src.indexOf('\nconst reservationConsent=',start);assert.ok(start>=0&&end>start);
const ctx={URL};vm.runInNewContext(src.slice(start,end)+';this.check=reservationConsentPolicy;',ctx);const check=ctx.check;
const valid={consentVersion:'v1-2026',privacy:{operator:'가상 운영자',officer:'가상 책임자',retention:'가상 보관 기간',policyUrl:'https://example.test/privacy',reviewed:true}};
test('confirmed draft includes fields, purposes, retention, refusal and link',()=>{const out=check(valid);assert.ok(out);for(const term of ['이름','휴대폰','이메일','요청사항','보유','거부','가상 보관 기간'])assert.match(out.text,new RegExp(term));assert.equal(out.policyUrl,'https://example.test/privacy');});
test('missing or placeholder operating facts cannot enable customer reservation',()=>{for(const patch of [{privacy:undefined},{consentVersion:''},{privacy:{...valid.privacy,operator:''}},{privacy:{...valid.privacy,officer:'미정'}},{privacy:{...valid.privacy,retention:'확인 필요'}},{privacy:{...valid.privacy,reviewed:false}}])assert.equal(check({...valid,...patch}),null);});
test('privacy link requires HTTPS and no credentials',()=>{for(const policyUrl of ['javascript:alert(1)','http://example.test/privacy','https://user:pw@example.test/privacy','/privacy'])assert.equal(check({...valid,privacy:{...valid.privacy,policyUrl}}),null);});
