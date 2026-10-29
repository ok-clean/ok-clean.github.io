'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRestoreIssuer,validationMessage,recordBytes}=require('../server/restore-issuer.cjs');
const {message,createRestoreGate,startRestoreHealthMonitor}=require('../server/restore-gate.cjs');
const src='demo-source',lp='demo-ledger',rid='restore_epoch_123456',aud='https://issuer.example.test',email='issuer@demo-ledger.iam.gserviceaccount.com';
function setup(){
 const authority=crypto.generateKeyPairSync('ed25519'),gate=crypto.generateKeyPairSync('ed25519');const pem=k=>k.export({format:'pem',type:'spki'});
 const rec={sourceProject:src,id:'synthetic-id',action:'redacted',state:'committed',expectedVersion:'1:0',expectedHistoryVersion:'a'.repeat(64)};
 let tick=1000000,pending=false,revision=5,gateDoc=null,beforeCommit=null;
 const proof={sourceProject:src,ledgerProject:lp,restoreId:rid,checkpoint:crypto.createHash('sha256').update(recordBytes(rec)).digest('hex'),ledgerRevision:revision,recordCount:1,issuedAt:tick-1000,expiresAt:tick+60000,isolated:true,replayed:true,state:'verified'};
 function resign(){proof.signature=crypto.sign(null,validationMessage(proof),authority.privateKey).toString('base64url');}resign();
 const refs={restore_validation:{id:'validation',get:async()=>({exists:true,data:()=>({...proof})})},deletion_ledger_meta:{id:'head',get:async()=>({exists:true,data:()=>({revision})})},restore_control:{id:'gate',get:async()=>({exists:!!gateDoc,data:()=>gateDoc})},deletion_ledger:{where:()=>({limit:()=>({id:'pending'})}),orderBy:()=>({limit:()=>({get:async()=>({docs:[{id:crypto.createHash('sha256').update(src).update('\0').update(rec.action).update('\0').update(rec.id).digest('hex'),data:()=>rec}]})})})}};
 const db={projectId:lp,collection:n=>n==='deletion_ledger'?refs[n]:{doc:()=>refs[n]},runTransaction:async f=>{if(beforeCommit)await beforeCommit();const staged=[];const tx={get:async ref=>ref.id==='pending'?{empty:!pending}:ref.get(),set:(ref,v)=>staged.push(v)};const result=await f(tx);for(const v of staged)gateDoc=v;return result;}};
 const ledger={safety:{sourceProjectId:src,ledgerProjectId:lp},assertNoPending:async()=>{if(pending)throw Error('pending');},page:async()=>({records:[rec],next:null})};
 const config={ledgerDb:db,ledger,sourceProject:src,ledgerProject:lp,restoreId:rid,authorityPublicKey:pem(authority.publicKey),gatePublicKey:pem(gate.publicKey),callerEmail:email,audience:aud,verifyOidc:async()=>({aud,iss:'https://accounts.google.com',email,email_verified:true}),sign:async msg=>crypto.sign(null,msg,gate.privateKey),now:()=>tick};
 return {proof,resign,rec,config,getGate:()=>gateDoc,setPending:x=>pending=x,setRevision:x=>revision=x,setTime:x=>tick=x,before:f=>beforeCommit=f,gate};
}
async function request(s,token='valid'){
 const h=createRestoreIssuer(s.config),res={headers:{},setHeader(k,v){this.headers[k]=v},end(v){this.body=JSON.parse(v);return this}};await h({method:'POST',headers:token?{authorization:'Bearer '+token}:{}},res);return res;
}
test('issues only with signed independent validation, matching ledger and fresh revision',async()=>{const s=setup();const r=await request(s);assert.equal(r.statusCode,200);assert.equal(r.body.status,'issued');const c=s.getGate();assert.equal(c.ledgerRevision,5);assert.equal(c.checkpoint,s.proof.checkpoint);assert.ok(crypto.verify(null,message(c),s.gate.publicKey,Buffer.from(c.signature,'base64url')));});
test('rejects missing or wrong caller identity before issuing',async()=>{const s=setup();assert.equal((await request(s,null)).statusCode,401);s.config.verifyOidc=async()=>({aud,iss:'https://accounts.google.com',email:'other@demo-ledger.iam.gserviceaccount.com',email_verified:true});assert.equal((await request(s)).statusCode,401);assert.equal(s.getGate(),null);});
test('invalid proof, forged signature, expiry and inaccurate checkpoint fail closed',async()=>{for(const attack of ['isolation','signature','expiry','checkpoint','count']){const s=setup();if(attack==='isolation'){s.proof.isolated=false;s.resign();}if(attack==='signature')s.proof.signature='A'.repeat(86);if(attack==='expiry')s.setTime(s.proof.expiresAt);if(attack==='checkpoint'){s.proof.checkpoint='0'.repeat(64);s.resign();}if(attack==='count'){s.proof.recordCount=0;s.resign();}assert.equal((await request(s)).statusCode,503,attack);assert.equal(s.getGate(),null);}});
test('pending, ledger mismatch and mid-signature revision changes never issue',async()=>{for(const attack of ['pending','revision','raced']){const s=setup();if(attack==='pending')s.setPending(true);if(attack==='revision')s.setRevision(6);if(attack==='raced')s.before(()=>s.setRevision(6));assert.equal((await request(s)).statusCode,503,attack);assert.equal(s.getGate(),null);}});
test('invalid gate signature and non-independent verification key are rejected',async()=>{const s=setup();s.config.sign=async()=>Buffer.alloc(64);assert.equal((await request(s)).statusCode,503);s.config.authorityPublicKey=s.config.gatePublicKey;assert.throws(()=>createRestoreIssuer(s.config),/INDEPENDENT_AUTHORITY_REQUIRED/);});

test('production issuer entrypoint stays hard blocked even when enabled',()=>{const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,[require('node:path').join(__dirname,'../server/restore-issuer-index.cjs')],{encoding:'utf8',env:{...process.env,OKCLEAN_RESTORE_ISSUER_ENABLED:'true'}});assert.notEqual(r.status,0);assert.match(r.stderr,/INDEPENDENT_RESTORE_VERIFIER_REQUIRED/);});

test('a delayed older issuance cannot overwrite a newer valid certificate',async()=>{
 const s=setup();s.proof.expiresAt=1599000;s.resign();
 let resume,started;const blocked=new Promise(r=>resume=r),firstStarted=new Promise(r=>started=r);let calls=0;
 s.config.sign=async msg=>{if(++calls===1){started();await blocked;}return crypto.sign(null,msg,s.gate.privateKey);};
 const old=request(s);await firstStarted;s.setTime(1001000);assert.equal((await request(s)).statusCode,200);
 const newer=s.getGate();resume();assert.equal((await old).statusCode,200);
 assert.deepEqual(s.getGate(),newer);
});

test('automatic recovery requires a fresh independent signed proof and a real gate recheck',async()=>{
 const s=setup();s.proof.expiresAt=1599000;s.resign();
 const gate=createRestoreGate({ledgerDb:s.config.ledgerDb,sourceProject:src,ledgerProject:lp,restoreId:rid,publicKey:s.config.gatePublicKey,now:s.config.now});
 assert.equal(await gate.verify(),false);let renewals=0;
 const monitor=startRestoreHealthMonitor(gate,{renew:async()=>{renewals++;const r=await request(s);if(r.statusCode!==200)throw Error('ISSUER_REFUSED');return 'issued';},clock:s.config.now,report:()=>{},setIntervalFn:()=>({unref(){}}),clearIntervalFn:()=>{}});
 await new Promise(r=>setImmediate(r));assert.equal(renewals,1);assert.equal(await gate.verify(),true);
 // A restart/expired certificate needs a new signed issue, and the gate still
 // rejects a pending ledger entry regardless of any prior successful renewal.
 s.setTime(s.getGate().expiresAt);assert.equal(await gate.verify(),false);await monitor.check();assert.equal(await gate.verify(),true);
 s.setPending(true);assert.equal(await gate.verify(),false);await monitor.check();assert.equal(await gate.verify(),false);
 monitor.stop();
});

test('read-only restore audit checks ledger order and redacted document shape without granting a proof',async()=>{
 const {auditRestoredDeletionState}=require('../server/restore-issuer.cjs'),s=setup();
 let parent={retentionRedacted:true,status:'보유기간만료',terminalAt:new Date(0),redactedAt:new Date(0),legalHold:false,dataMutationFrozen:true,retentionFreeze:'retention-v1'},cols=[],history=[],changed=false,reads=0;
 const ref={get:async()=>({exists:true,data:()=>parent,updateTime:{isEqual:()=>!changed||++reads<2}}),listCollections:async()=>cols,collection:()=>({limit:()=>({get:async()=>({size:history.length,docs:history})})})};
 const args={ledgerDb:s.config.ledgerDb,restoredDb:{projectId:src,collection:()=>({doc:()=>ref})},sourceProject:src,ledgerProject:lp,checkpoint:s.proof.checkpoint,ledgerRevision:5,recordCount:1};
 assert.deepEqual(await auditRestoredDeletionState(args),{checkpoint:s.proof.checkpoint,ledgerRevision:5,recordCount:1});
 parent={...parent,phone:'synthetic'};await assert.rejects(auditRestoredDeletionState(args),/RESTORE_REAPPLICATION_REQUIRED/);delete parent.phone;
 cols=[{id:'unknown'}];await assert.rejects(auditRestoredDeletionState(args),/RESTORE_UNKNOWN_DEPENDENCIES/);cols=[];
 await assert.rejects(auditRestoredDeletionState({...args,checkpoint:'0'.repeat(64)}),/RESTORE_CHECKPOINT_MISMATCH/);
 history=[{ref:{listCollections:async()=>[]}}];await assert.rejects(auditRestoredDeletionState(args),/RESTORE_HISTORY_BASELINE_REQUIRED/);history=[];
 s.rec.action='history_purged';args.checkpoint=crypto.createHash('sha256').update(recordBytes(s.rec)).digest('hex');history=[{ref:{listCollections:async()=>[]}}];
 await assert.rejects(auditRestoredDeletionState(args),/RESTORE_HISTORY_BASELINE_REQUIRED/);history=[];
 assert.equal((await auditRestoredDeletionState(args)).recordCount,1);
 s.setPending(true);await assert.rejects(auditRestoredDeletionState(args),/RESTORE_LEDGER_UNSTABLE/);s.setPending(false);
 changed=true;reads=1;await assert.rejects(auditRestoredDeletionState(args),/RESTORE_DATA_CHANGED/);
 assert.equal(s.getGate(),null); // This audit cannot issue or release a restore.
});
