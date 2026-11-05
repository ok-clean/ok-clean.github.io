// Tests the shipped submitMember with real Firestore emulator operations; Auth readiness is controlled.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {initializeTestEnvironment}=require('@firebase/rules-unit-testing');
const sdk=require('firebase/firestore');
const source=fs.readFileSync('member-sync.js','utf8').replace(/^import .*;\n/gm,'').replace('export async function submitMember','async function submitMember')+'\nthis.submitMember=submitMember;';
const projectId='demo-okclean-intake';
const member={name:'합성동기화',phone:'010-0000-0000',area:'시험',free:'시험서비스',ad:false,code:'OK-ABC234',ref:''};
const pause=()=>new Promise(r=>setImmediate(r));
(async()=>{
 const env=await initializeTestEnvironment({projectId,firestore:{host:'127.0.0.1',port:8088,rules:fs.readFileSync('firestore.rules','utf8')}});
 const db=uid=>env.authenticatedContext(uid,{firebase:{sign_in_provider:'anonymous'}}).firestore();
 const admin=env.authenticatedContext('H1MfdqGkFRZzU8qkqwXTsiKv3CO2',{firebase:{sign_in_provider:'google.com'}}).firestore();
 let checks=0;
 function client(uid,opts={}){
  const app={name:'[DEFAULT]',options:{projectId}},auth={currentUser:opts.noUser?null:{uid},authStateReady:opts.ready||(()=>Promise.resolve())};
  let anon=0;const timers=[];
  const ctx=vm.createContext({...sdk,getApps:()=>[app],getApp:()=>app,initializeApp:()=>app,getAuth:()=>auth,getFirestore:()=>db(uid),
   signInAnonymously:async()=>{anon++;await pause();auth.currentUser={uid};},
   writeBatch:database=>{const b=(opts.writeBatch||sdk.writeBatch)(database);return {set:(ref,data)=>b.set(ref,{...data}),commit:()=>b.commit()};},
   setTimeout:opts.manualTimers?fn=>{timers.push(fn);return timers.length}:setTimeout,
   clearTimeout:opts.manualTimers?()=>{}:clearTimeout,
  });vm.runInContext(source,ctx);
  return {submit:m=>ctx.submitMember({projectId},m||member),auth,anon:()=>anon,timers};
 }
 try{
  await env.clearFirestore();
  let restore;const c=client('restore',{noUser:true,ready:()=>new Promise(r=>restore=r)});
  const pending=c.submit();await pause();assert.equal(c.anon(),0);c.auth.currentUser={uid:'restore'};restore();const receipt=await pending;
  assert.equal(c.anon(),0);assert.equal(receipt.requestId,'restore');checks++;
  const bad=client('bad',{noUser:true,ready:()=>Promise.reject(new Error('restore failed'))});await assert.rejects(bad.submit());assert.equal(bad.anon(),0);checks++;
  const slow=client('slow',{noUser:true,ready:()=>new Promise(()=>{}),manualTimers:true});const slowP=slow.submit();await pause();slow.timers[0]();await assert.rejects(slowP,e=>e.code==='auth/restore-timeout');assert.equal(slow.anon(),0);checks++;
  const concurrent=client('concurrent');const results=await Promise.all([concurrent.submit(),concurrent.submit()]);assert.equal(results[0].requestId,results[1].requestId);checks++;
  // Two page instances race: only one pair is created, other request recovers its receipt.
  const pageA=client('tabs'),pageB=client('tabs');const tabs=await Promise.all([pageA.submit(),pageB.submit()]);assert.equal(tabs[0].code,tabs[1].code);checks++;
  const lost=client('lost',{writeBatch:database=>{const b=sdk.writeBatch(database);return {set:(...args)=>b.set(...args),commit:async()=>{await b.commit();throw Object.assign(new Error('lost ack'),{code:'unavailable'});}};}});
  const recovered=await lost.submit();assert.equal(recovered.requestId,'lost');assert.equal(recovered.existing,true);checks++;
  await sdk.updateDoc(sdk.doc(admin,'member_requests','lost'),{memo:'관리자 보존',status:'상담중',points:7});
  const retried=await client('lost').submit({...member,name:'변경시도',code:'OK-ZZZZZZ'});assert.equal(retried.code,member.code);assert.equal(retried.existing,true);
  const after=(await sdk.getDoc(sdk.doc(admin,'member_requests','lost'))).data();assert.equal(after.name,member.name);assert.equal(after.memo,'관리자 보존');assert.equal(after.points,7);checks++;
  const fresh=client('new-auth',{noUser:true});await Promise.all([fresh.submit(),fresh.submit()]);assert.equal(fresh.anon(),1,'anonymous creation must be shared during simultaneous submission');checks++;
  const docs=await sdk.getDocs(sdk.collection(admin,'member_requests'));assert.equal(docs.size,5);checks++;
  console.log(`intake sync ${checks} checks passed (real Firestore emulator, controlled Auth restoration)`);
 }finally{await env.cleanup();}
})().catch(e=>{console.error(e);process.exitCode=1;});
