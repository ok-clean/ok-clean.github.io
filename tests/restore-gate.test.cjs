'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRestoreGate,message}=require('../server/restore-gate.cjs');
const sourceProject='demo-clean-data',ledgerProject='demo-clean-ledger',restoreId='synthetic-restore-id-123';
const time=1800000000000,{privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
const unsigned=()=>({sourceProject,ledgerProject,restoreId,checkpoint:'a'.repeat(64),ledgerRevision:2,issuedAt:time-1000,expiresAt:time+1000,state:'cleared'});
function sign(v){return {...v,signature:crypto.sign(null,message(v),privateKey).toString('base64url')};}
function setup(row=sign(unsigned()),{pending=false,controlError=false,pendingError=false,revision=2}={}){
 const ledgerDb={projectId:ledgerProject,collection(name){if(name==='restore_control')return {doc(){return {kind:'control'};}};if(name==='deletion_ledger_meta')return {doc(){return {kind:'head'};}};return {where(){return {limit(){return {kind:'query'};}};}};},async runTransaction(fn,options){assert.deepEqual(options,{readOnly:true});return fn({async get(ref){if(ref.kind==='control'){if(controlError)throw Error();return {exists:!!row,data:()=>row};}if(ref.kind==='head')return {exists:true,data:()=>({revision})};if(pendingError)throw Error();return {empty:!pending};}});}};
 return createRestoreGate({ledgerDb,sourceProject,ledgerProject,restoreId,publicKey:publicKey.export({type:'spki',format:'pem'}),now:()=>time});
}
test('signed fresh project-specific proof permits access only with no pending intent',async()=>{assert.equal(await setup().verify(),true);assert.equal(await setup(sign(unsigned()),{pending:true}).verify(),false);});
test('missing, untrusted, changed, expired or wrong epoch proof never opens gate',async()=>{
 const base=sign(unsigned());assert.equal(await setup(null).verify(),false);
 for(const v of [{...base,state:'blocked'},{...base,sourceProject:'demo-evil-data'},{...base,restoreId:'another-restore-id'},{...base,checkpoint:'b'.repeat(64)},{...base,expiresAt:time},{...base,signature:'A'.repeat(86)},sign({...unsigned(),expiresAt:time+700000})])assert.equal(await setup(v).verify(),false);
});
test('unavailable ledger or insufficient read permission fails closed',async()=>{assert.equal(await setup(sign(unsigned()),{controlError:true}).verify(),false);assert.equal(await setup(sign(unsigned()),{pendingError:true}).verify(),false);});
test('gate rejects same project and malformed key before application starts',()=>{assert.throws(()=>createRestoreGate({sourceProject,ledgerProject:sourceProject,restoreId,ledgerDb:{projectId:sourceProject},publicKey}),/CONFIGURATION_REQUIRED/);assert.throws(()=>createRestoreGate({sourceProject,ledgerProject,restoreId,ledgerDb:{projectId:ledgerProject,collection(){},runTransaction(){}},publicKey:'not a key'}),/PUBLIC_KEY_INVALID/);});
test('denied middleware never invokes next or returns private data',async()=>{let next=false,body='';const res={setHeader(){},end(v){body=v;}};await setup(null).middleware({},res,()=>{next=true;});assert.equal(next,false);assert.equal(res.statusCode,503);assert.deepEqual(JSON.parse(body),{status:'unavailable'});});

test('stale proof is invalid immediately after ledger revision changes',async()=>{assert.equal(await setup(sign(unsigned()),{revision:3}).verify(),false);});
