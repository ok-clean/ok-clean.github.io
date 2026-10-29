'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function fixture(){
 let calls=[];const auth={currentUser:{emailVerified:true,getIdToken:async()=> 'id-token'},authStateReady:async()=>{}};
 let code=fs.readFileSync(path.join(__dirname,'../reservation-api.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export async function/g,'async function');
 const context={URL,initializeApp:()=>({}),getApps:()=>[],getAuth:()=>auth,setPersistence:async()=>{},browserSessionPersistence:{},initializeAppCheck:()=>({}),ReCaptchaV3Provider:class{},getToken:async()=>({token:'appcheck-token'}),signInWithEmailAndPassword:async()=>{},fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({status:'confirmed'})}}};
 vm.runInNewContext(code+'\nthis.api={submit,recover,ready};',context);
 return {api:context.api,calls,auth};
}
const config={apiKey:'fake',projectId:'fake',appId:'fake'},settings={enabled:true,appCheckSiteKey:'fake',apiUrl:'https://test-service.run.app/'};
test('includes ID token and App Check when using approved HTTPS endpoint',async()=>{const {api,calls}=fixture();await api.submit(config,'request-1',{consent:true},settings);assert.equal(calls.length,1);assert.equal(calls[0].url,'https://test-service.run.app/reservation/submit');assert.equal(calls[0].opts.headers.Authorization,'Bearer id-token');assert.equal(calls[0].opts.headers['X-Firebase-AppCheck'],'appcheck-token');assert.equal(calls[0].opts.redirect,'error');});
test('missing configuration or unsafe endpoint never sends tokens',async()=>{for(const s of [{...settings,enabled:false},{...settings,appCheckSiteKey:''},{...settings,apiUrl:'https://bad.example'},{...settings,apiUrl:'https://user@service.run.app/'},{...settings,apiUrl:'http://service.run.app/'}]){const {api,calls}=fixture();await assert.rejects(()=>api.recover(config,'request-1',s));assert.equal(calls.length,0);}});
test('unverified user cannot send reservation',async()=>{const {api,calls,auth}=fixture();auth.currentUser.emailVerified=false;await assert.rejects(()=>api.submit(config,'request-1',{},settings));assert.equal(calls.length,0);});
