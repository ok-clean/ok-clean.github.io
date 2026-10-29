// Isolated client-unit tests. Firebase Auth and Firestore are fakes; no network or personal data.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
  return {promise,resolve,reject};
}
function makeClient({signInError,writeError}={}) {
  const ready=deferred(), auth={currentUser:null,authStateReady:()=>ready.promise};
  const calls={signIns:0,writes:[],timers:new Map()}, app={};
  let nextTimer=0;
  const source=readFileSync('member-sync.js','utf8');
  const imports=source.match(/^import [^\n]+;$/gm)||[];
  assert.equal(imports.length,3,'review changed client dependencies');
  const program=source.replace(/^import [^\n]+;\n/gm,'')
    .replace('export async function submitMember','async function submitMember');
  assert.notEqual(program,source,'client body must be loaded');
  const context={
    initializeApp:()=>app,getApps:()=>[],getApp:()=>app,getAuth:()=>auth,getFirestore:()=>({}),
    signInAnonymously:async()=>{calls.signIns++;if(signInError)throw signInError;auth.currentUser={uid:'fake-anonymous'};},
    doc:(_db,collection,id)=>({collection,id}),
    setDoc:async(ref,data)=>{calls.writes.push({ref,data});if(writeError)throw writeError;},
    serverTimestamp:()=>({testTimestamp:true}),crypto:{randomUUID:()=> 'fake-record'},
    setTimeout:(callback,delay)=>{const id=++nextTimer;calls.timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>calls.timers.delete(id),
  };
  vm.runInNewContext(program+'\nthis.submitMember = submitMember;',context,{filename:'member-sync.js'});
  return {auth,ready,calls,submit:()=>context.submitMember({projectId:'demo-fake'},
    {name:'가상고객',phone:'01000000000',area:'가상지역'})};
}
function timeout(rig) {
  assert.equal(rig.calls.timers.size,1);
  const timer=[...rig.calls.timers.values()][0];
  assert.equal(timer.delay,10000);
  timer.callback();
}

test('waits for a restored anonymous account before deciding whether to sign in',async()=>{
  const rig=makeClient(), pending=rig.submit();
  assert.equal(rig.calls.signIns,0);assert.equal(rig.calls.writes.length,0);
  rig.auth.currentUser={uid:'fake-restored-anon',isAnonymous:true};rig.ready.resolve();
  await pending;
  assert.equal(rig.calls.signIns,0);
  assert.equal(rig.calls.writes.length,1);
  assert.equal(rig.calls.writes[0].data.ownerUid,'fake-restored-anon');
  assert.equal(rig.calls.timers.size,0);
});

test('reuses a restored non-anonymous account and propagates a rules rejection',async()=>{
  const denied=Object.assign(new Error('fake permission denied'),{code:'permission-denied'});
  const rig=makeClient({writeError:denied}), pending=rig.submit();
  const restored={uid:'fake-restored-user',isAnonymous:false};
  rig.auth.currentUser=restored;rig.ready.resolve();
  await assert.rejects(pending,err=>err===denied);
  assert.equal(rig.calls.signIns,0);assert.equal(rig.auth.currentUser,restored);
  assert.equal(rig.calls.writes.length,1);
  assert.equal(rig.calls.writes[0].data.ownerUid,'fake-restored-user');
  assert.equal(rig.calls.timers.size,0);
});

test('signs in anonymously only after initial state resolves signed out',async()=>{
  const rig=makeClient(),pending=rig.submit();
  assert.equal(rig.calls.signIns,0);assert.equal(rig.calls.writes.length,0);
  rig.ready.resolve();await pending;
  assert.equal(rig.calls.signIns,1);assert.equal(rig.calls.writes.length,1);
  assert.equal(rig.calls.writes[0].data.ownerUid,'fake-anonymous');
  assert.equal(rig.calls.timers.size,0);
});

test('initialization failure causes no sign-in or write',async()=>{
  const rig=makeClient(),pending=rig.submit(),failure=new Error('fake init failure');
  rig.ready.reject(failure);await assert.rejects(pending,err=>err===failure);
  assert.equal(rig.calls.signIns,0);assert.equal(rig.calls.writes.length,0);
  assert.equal(rig.calls.timers.size,0);
});

test('initialization timeout stops the operation even when restoration later finishes',async()=>{
  const rig=makeClient(),pending=rig.submit();
  timeout(rig);
  await assert.rejects(pending,/회원 인증 준비 시간 초과/);
  rig.ready.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rig.calls.signIns,0);assert.equal(rig.calls.writes.length,0);
  assert.equal(rig.calls.timers.size,0);
});

test('anonymous sign-in failure causes no write',async()=>{
  const failure=new Error('fake sign-in failure'),rig=makeClient({signInError:failure});
  const pending=rig.submit();rig.ready.resolve();
  await assert.rejects(pending,err=>err===failure);
  assert.equal(rig.calls.signIns,1);assert.equal(rig.calls.writes.length,0);
  assert.equal(rig.calls.timers.size,0);
});
