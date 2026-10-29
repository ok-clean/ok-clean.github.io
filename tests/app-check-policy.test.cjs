'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {restrictedAppCheck}=require('../server/app-check-policy.cjs');
const allowed='1:123456789:web:abcdef',other='1:123456789:web:012345';
test('only tokens verified for the configured web app are accepted',async()=>{
 const a=restrictedAppCheck({verifyToken:async t=>({appId:t==='ok'?allowed:other})},allowed);
 assert.equal((await a.verifyToken('ok')).appId,allowed);
 await assert.rejects(()=>a.verifyToken('another-app'));
});
test('missing, malformed, expired and verifier failure fail closed',async()=>{
 assert.throws(()=>restrictedAppCheck({verifyToken:async()=>({})},'missing'));
 const a=restrictedAppCheck({verifyToken:async()=>{throw Error('expired');}},allowed);
 await assert.rejects(()=>a.verifyToken(''));
 await assert.rejects(()=>a.verifyToken('expired'));
 const missing=restrictedAppCheck({verifyToken:async()=>({})},allowed);
 await assert.rejects(()=>missing.verifyToken('unverified'));
});
