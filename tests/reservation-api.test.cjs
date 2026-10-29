'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(debug=false,checkToken="appcheck-token"){
 let calls=[];const auth={currentUser:{uid:'a',email:'synthetic@example.test',emailVerified:true,getIdToken:async()=> 'id-token'},authStateReady:async()=>{}};
 let code=fs.readFileSync(path.join(__dirname,'../reservation-api.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export async function/g,'async function');
 const context={URL,FIREBASE_APPCHECK_DEBUG_TOKEN:debug,initializeApp:()=>({}),getApps:()=>[],getAuth:()=>auth,setPersistence:async()=>{},browserSessionPersistence:{},initializeAppCheck:()=>({}),ReCaptchaV3Provider:class{},getToken:async()=>{if(checkToken===null)throw Error('test expiry');return {token:checkToken}},signInWithEmailAndPassword:async()=>{},EmailAuthProvider:{credential:(email,password)=>({email,password})},reauthenticateWithCredential:async(user,credential)=>{if(credential.password!=='synthetic-password')throw Error('bad auth')},onAuthStateChanged:(a,cb)=>{a.listener=cb;return ()=>{a.listener=null;}},fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({status:url.endsWith('/list')||url.endsWith('/account-status')?'ok':url.endsWith('/withdraw')?'pending':'confirmed',items:[]})}}};
 vm.runInNewContext(code+'\nthis.api={submit,recover,ready,listOwn,watchUser,accountStatus,requestWithdrawal};',context);
 return {api:context.api,calls,auth,context};
}
const config={apiKey:'fake',projectId:'fake',appId:'fake'},settings={enabled:true,appCheckSiteKey:'fake',apiUrl:'https://test-service.run.app/'};
test('includes ID token and App Check when using approved HTTPS endpoint',async()=>{const {api,calls}=fixture();await api.submit(config,'request-1',{consent:true},settings);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://test-service.run.app/reservation/submit');assert.equal(calls[0].opts.headers.Authorization,'Bearer id-token');assert.equal(calls[0].opts.headers['X-Firebase-AppCheck'],'appcheck-token');assert.equal(calls[0].opts.redirect,'error');});
test('missing configuration or unsafe endpoint never sends tokens',async()=>{for(const s of [{...settings,enabled:false},{...settings,appCheckSiteKey:''},{...settings,apiUrl:'https://bad.example'},{...settings,apiUrl:'https://user@service.run.app/'},{...settings,apiUrl:'http://service.run.app/'}]){const {api,calls}=fixture();await assert.rejects(()=>api.recover(config,'request-1',s));assert.equal(calls.length,0);}});
test('unverified user cannot send reservation',async()=>{const {api,calls,auth}=fixture();auth.currentUser.emailVerified=false;await assert.rejects(()=>api.submit(config,'request-1',{},settings));assert.equal(calls.length,0);});

test('owner list uses authenticated API and checks same account before rendering',async()=>{const {api,calls,auth,context}=fixture();assert.deepEqual((await api.listOwn(config,settings)).items,[]);assert.equal(calls[0].url,'https://test-service.run.app/reservation/list');context.fetch=async()=>{auth.currentUser={uid:'b',emailVerified:true};return {ok:true,json:async()=>({status:'ok',items:[{id:'old'}]})}};await assert.rejects(()=>api.listOwn(config,settings));});
test('identity change observer can clear stale customer data',async()=>{const {api,auth}=fixture();let cleared=0;const stop=await api.watchUser(config,settings,()=>cleared++);auth.listener(null);assert.equal(cleared,1);stop();assert.equal(auth.listener,null);});

test('production debug provider blocks token and network requests',async()=>{const {api,calls}=fixture(true);await assert.rejects(()=>api.submit(config,'request-1',{},settings));assert.equal(calls.length,0);});

test('empty App Check token never reaches the reservation server',async()=>{const {api,calls}=fixture(false,'');await assert.rejects(()=>api.submit(config,'request-1',{},settings));assert.equal(calls.length,0);});

test('App Check token acquisition failure never sends a request',async()=>{const {api,calls}=fixture(false,null);await assert.rejects(()=>api.submit(config,'request-1',{},settings));assert.equal(calls.length,0);});

test('withdrawal requires explicit reviewed policy and fresh password',async()=>{const {api,calls}=fixture();const enabled={...settings,withdrawalEnabled:true,withdrawalPolicyReviewed:true};await assert.rejects(()=>api.requestWithdrawal(config,'wrong',enabled));assert.equal(calls.length,0);await assert.rejects(()=>api.requestWithdrawal(config,'synthetic-password',settings));assert.equal(calls.length,0);assert.equal((await api.requestWithdrawal(config,'synthetic-password',enabled)).status,'pending');assert.equal(calls[0].url,'https://test-service.run.app/reservation/withdraw');});
