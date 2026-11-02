// Archived active homepage fixture + current preserved (inactive) member implementation.
// This is a reactivation candidate test, not the public paused homepage; SDKs are fakes.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const home=fs.readFileSync('tests/fixtures/auth-homepage/index.html','utf8').replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/,(_,start,raw,end)=>{
  const cfg=JSON.parse(raw);
  cfg.firebase={apiKey:'fake-test-identifier',projectId:'demo-auth-review'};
  cfg.memberBackendUrl='';cfg.blog=[];cfg.analytics={};
  return start+JSON.stringify(cfg).replace(/<\//g,'<\\/')+end;
});
const sdk={
  'firebase-app.js':`export const initializeApp=()=>({}),getApps=()=>[],getApp=()=>({});`,
  'firebase-auth.js':`export const getAuth=()=>window.rig.auth;
    export async function signInAnonymously(auth){window.rig.signIns++;if(window.rig.signInError)throw Error('fake sign-in failure');auth.currentUser={uid:'fake-new-anon'};}`,
  'firebase-firestore.js':`export const getFirestore=()=>({}),doc=(_db,collection,id)=>({collection,id}),serverTimestamp=()=>({fake:true});
    export async function setDoc(ref,data){window.rig.writes.push({ref,data});if(window.rig.writeError)throw Error('fake write rejection');}`
};
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [390,1440])for(const scenario of ['signed-in','restored-user','restored-anon','signed-out','ready-error','timeout','sign-in-error','write-error']){
   const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
   try{
    const external=[],errors=[];
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin==='https://www.gstatic.com'&&url.pathname.startsWith('/firebasejs/10.14.1/')){
        const body=sdk[url.pathname.split('/').pop()];
        if(body)return route.fulfill({status:200,contentType:'application/javascript',headers:{'Access-Control-Allow-Origin':'*'},body});
      }
      if(url.origin!=='http://127.0.0.1:8765'){external.push(url.origin);return route.abort();}
      if(url.pathname==='/'||url.pathname==='/index.html')return route.fulfill({status:200,contentType:'text/html',body:home});
      if(url.pathname==='/member-sync.js')return route.fulfill({status:200,contentType:'application/javascript',body:require('./member-auth-preserved.cjs').reviewedClient()});
      return route.continue();
    });
    await context.addInitScript(()=>{
      localStorage.setItem('joinLater',JSON.stringify(Date.now()));
      let resolve,reject;
      const ready=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
      const original=window.setTimeout.bind(window);
      window.rig={auth:{currentUser:null,authStateReady:()=>{window.rig.readyCalls++;return ready;}},resolve,reject,readyCalls:0,signIns:0,writes:[]};
      window.setTimeout=(callback,delay,...args)=>{
        if(delay===10000){window.rig.expire=callback;return original(()=>{},60000);}
        return original(callback,delay,...args);
      };
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://127.0.0.1:8765/',{waitUntil:'domcontentloaded'});
    if(scenario==='signed-in')await page.evaluate(()=>{rig.auth.currentUser={uid:'fake-existing'};rig.resolve();});
    if(scenario==='sign-in-error')await page.evaluate(()=>{rig.signInError=true;});
    if(scenario==='write-error')await page.evaluate(()=>{rig.writeError=true;});
    await page.locator('[data-join]').first().click();
    await page.locator('#jName').fill('가상고객');await page.locator('#jPhone').fill('01000000000');
    await page.locator('#jAgree').check();await page.locator('#jSubmit').click();
    await page.waitForFunction(()=>rig.readyCalls===1);
    if(scenario!=='signed-in'){
      assert.deepEqual(await page.evaluate(()=>[rig.signIns,rig.writes.length]),[0,0],scenario+' must wait');
      await page.evaluate(s=>{
        if(s==='ready-error')return rig.reject(Error('fake readiness error'));
        if(s==='timeout')return rig.expire();
        if(s==='restored-user')rig.auth.currentUser={uid:'fake-restored-user'};
        if(s==='restored-anon')rig.auth.currentUser={uid:'fake-restored-anon',isAnonymous:true};
        rig.resolve();
      },scenario);
    }
    const failed=['ready-error','timeout','sign-in-error','write-error'].includes(scenario);
    await page.waitForFunction(f=>document.querySelector('.toast')?.textContent.includes(f?'자동 접수가 되지 않았어요':'회원정보 접수 요청이 완료됐어요'),failed);
    if(scenario==='timeout'){
      await page.evaluate(async()=>{rig.auth.currentUser={uid:'fake-late-user'};rig.resolve();await new Promise(ok=>setTimeout(ok,0));});
    }
    const actual=await page.evaluate(()=>({signIns:rig.signIns,writes:rig.writes}));
    const needsAnon=['signed-out','sign-in-error','write-error'].includes(scenario);
    assert.equal(actual.signIns,needsAnon?1:0,scenario);
    assert.equal(actual.writes.length,['ready-error','timeout','sign-in-error'].includes(scenario)?0:1,scenario);
    if(actual.writes.length){
      const uid={'signed-in':'fake-existing','restored-user':'fake-restored-user','restored-anon':'fake-restored-anon'}[scenario]||'fake-new-anon';
      assert.equal(actual.writes[0].data.ownerUid,uid,scenario);
      assert.equal(actual.writes[0].ref.collection,'member_requests');
    }
    // Fonts and case images may be requested by the homepage, but every
    // non-loopback request outside the three fake SDK routes is aborted above.
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px ${scenario}`);
   }finally{await context.close();}
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
