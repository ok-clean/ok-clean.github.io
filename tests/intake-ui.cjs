const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app.js','utf8');
function harness(submit, previous = null) {
 const elements = Object.fromEntries(['jSubmit','jErr','jName','jPhone','jAgree','jArea','jAd'].map(k=>[k,{disabled:false,textContent:'',value:'',checked:false}]));
 elements.jName.value='합성테스트';elements.jPhone.value='010-0000-0000';elements.jAgree.checked=true;elements.jArea.value='춘천';
 const saved = {member:previous}, timers = new Map();let nextTimer=0,done=0;
 const ctx = vm.createContext({
   $: id=>elements[id], store:{get:(k,d)=>saved[k]??d,set:(k,v)=>saved[k]=v},
   C:{firebase:{apiKey:'test',projectId:'demo-intake'}},M:{freeServices:['테스트서비스']},REF:'',
   document:{querySelector:()=>null},submit,
   joinDone:()=>done++,calc:()=>{},
   setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer},clearTimeout:id=>timers.delete(id)
 });
 vm.runInContext(source.slice(source.indexOf('let MEMBER ='),source.indexOf('// 친구 초대 링크')),ctx);
 const begin=source.indexOf('  $("jSubmit").onclick = async');
 const end=source.indexOf('  // 처음 방문한 사람',begin);
 vm.runInContext(source.slice(begin,end).replace("import('./member-sync.js')",'Promise.resolve({submitMember:submit})'),ctx);
 return {elements,saved,timers,click:()=>elements.jSubmit.onclick(),done:()=>done,state:()=>vm.runInContext('({MEMBER, memberDraft})',ctx)};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('no completion or member entitlement before server acknowledgement; double click single request',async()=>{
 let finish,calls=0;const h=harness(()=>{calls++;return new Promise(r=>finish=r)});
 const p=h.click();await tick();await h.click();assert.equal(calls,1);assert.equal(h.done(),0);assert.equal(h.state().MEMBER,null);
 finish({code:'OK-AAAAAA',requestId:'uid'});await p;
 assert.equal(h.done(),1);assert.equal(h.saved.member.serverConfirmed,true);assert.equal(h.saved.memberDraft,null);
});
test('permission denied never completes; retry retains code',async()=>{
 let calls=0,first;const h=harness((_,m)=>{calls++;if(calls===1){first=m.code;throw {code:'permission-denied'}}assert.equal(m.code,first);return {code:m.code,requestId:'uid'}});
 await h.click();assert.equal(h.done(),0);assert.match(h.elements.jErr.textContent,/권한 오류/);assert.equal(h.saved.member, null);
 await h.click();assert.equal(h.done(),1);
});
test('timeout remains unknown and retry shares pending operation',async()=>{
 let finish,calls=0;const h=harness(()=>{calls++;return new Promise(r=>finish=r)});
 const p=h.click();await tick();[...h.timers.values()][0]();await p;
 assert.equal(h.done(),0);assert.match(h.elements.jErr.textContent,/접수 확인 중/);
 const retry=h.click();await tick();assert.equal(calls,1);finish({code:'OK-BBBBBB',requestId:'uid'});await retry;assert.equal(h.done(),1);
});
test('legacy local member is a draft, not confirmed membership',()=>{
 const h=harness(()=>{}, {name:'old',code:'OK-CCCCCC'});
 assert.equal(h.state().MEMBER,null);assert.equal(h.saved.member,null);assert.equal(h.saved.memberDraft.code,'OK-CCCCCC');
});
test('missing receipt never completes',async()=>{
 const h=harness(()=>undefined);await h.click();assert.equal(h.done(),0);assert.match(h.elements.jErr.textContent,/접수 확인 중/);
});
test('auth failure keeps draft and enables retry',async()=>{
 const h=harness(()=>{throw {code:'auth/operation-not-allowed'}});await h.click();assert.equal(h.done(),0);assert.equal(h.elements.jSubmit.disabled,false);assert.match(h.elements.jErr.textContent,/인증/);
});
test('existing receipt does not present new draft personal information as stored',async()=>{
 const h=harness(()=>({code:'OK-DDDDDD',requestId:'uid',existing:true}));await h.click();
 assert.equal(h.saved.member.existingReceipt,true);assert.equal(h.saved.member.name,undefined);assert.equal(h.saved.member.free,undefined);assert.equal(h.done(),1);
});
