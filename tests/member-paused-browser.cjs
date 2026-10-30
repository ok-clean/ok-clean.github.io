'use strict';
// Synthetic canaries only. No remote traffic or actual calls/messages.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.OKCLEAN_TEST_BASE || 'http://127.0.0.1:8765';
const secrets=['PRIVATECANARYNAME','01000001111','OK-CANARY','PRIVATECANARYAREA'];
const member=JSON.stringify({name:secrets[0],phone:secrets[1],area:secrets[3],code:secrets[2],free:'synthetic',sent:false});
const quote=JSON.stringify({svc:'move-in',v:0,t:0,qty:1,opts:[],area:secrets[3],date:'2099-01-01'});
const ref=JSON.stringify(secrets[2]);
const hasSecret=value=>secrets.some(s=>String(value??'').includes(s)||String(value??'').includes(encodeURIComponent(s)));

(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
   for(const legacy of [false,true]){
    const context=await browser.newContext({viewport,serviceWorkers:'block'});
    const leaks=[],remoteRequests=[],pageErrors=[];
    let firstDocumentObserved=false;
    try{
     await context.addInitScript(({legacy,member,quote,ref,mobile})=>{
      if(legacy&&!sessionStorage.getItem('__qa_seeded')){
       localStorage.setItem('member',member);localStorage.setItem('quote',quote);localStorage.setItem('ref',ref);sessionStorage.setItem('__qa_seeded','1');
      }
      if(mobile)Object.defineProperty(navigator,'userAgent',{configurable:true,value:'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'});
      window.__testCopies=[];window.__testShares=[];
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async v=>{window.__testCopies.push(String(v));}}});
      Object.defineProperty(navigator,'share',{configurable:true,value:async v=>{window.__testShares.push(v);}});
     },{legacy,member,quote,ref,mobile:viewport.width===390});
     await context.route('**/*',async route=>{
      const r=route.request(),url=r.url(),body=r.postData()||'',headers=r.headers();
      const u=new URL(url);
      // A pre-existing referral is intentionally present in the first HTTP
      // navigation; client-side code cannot erase that already-sent request.
      const firstDocument=!firstDocumentObserved&&r.isNavigationRequest()&&r.resourceType()==='document'&&u.origin===base;
      if(firstDocument){firstDocumentObserved=true;if(u.searchParams.get('ref')!==secrets[2])leaks.push('initial-navigation');}
      if((!firstDocument&&hasSecret(url))||hasSecret(body)||hasSecret(headers.referer))leaks.push('network');
      if(u.origin===base){
       if(u.pathname==='/site.js'){
        // Expose the unchanged private helper only in this isolated test, so
        // the actual install destination can be inspected without leaving the page.
        const site=fs.readFileSync('site.js','utf8');
        const marker='const installUrl = () =>';
        assert.ok(site.includes(marker),'install helper must exist');
        return route.fulfill({status:200,contentType:'application/javascript',body:site.replace(marker,'const installUrl = window.__testInstallUrl = () =>')});
       }
       return route.continue();
      }
      const target=u.hostname+u.pathname;
      remoteRequests.push(hasSecret(target)?'[redacted]':target);return route.abort();
     });
     const page=await context.newPage();
     page.on('console',m=>{if(hasSecret(m.text()))leaks.push('console');});
     page.on('pageerror',e=>{pageErrors.push(e.name);if(hasSecret(e.message))leaks.push('pageerror');});
     await page.goto(base+'/?ref='+encodeURIComponent(secrets[2]),{waitUntil:'domcontentloaded'});
     await page.locator('#qSvc').waitFor();
     assert.equal(firstDocumentObserved,true);
     assert.equal(new URL(page.url()).searchParams.has('ref'),false,'legacy referral must be removed from the address');
     const installUrl=await page.evaluate(()=>window.__testInstallUrl());
     assert.equal(hasSecret(installUrl),false,'installation destination must omit the old referral');
     assert.equal(new URL(installUrl).searchParams.get('install'),'1');
     const initial=await page.evaluate(()=>({member:localStorage.getItem('member'),quote:localStorage.getItem('quote'),ref:localStorage.getItem('ref')}));
     if(legacy)assert.deepEqual(initial,{member,quote,ref},'existing data must be preserved');
     else assert.equal(initial.member,null);

     const open=page.locator('[data-join]:visible').first();
     await open.click();
     await page.locator('#join').waitFor({state:'visible'});
     assert.match(await page.locator('#join').innerText(),/일시\s*중지/);
     assert.equal(await page.locator('#joinForm').isVisible(),false);
     // Direct DOM event/click and direct handler invocation cannot bypass the guard.
     await page.evaluate(()=>{
      const name=document.querySelector('#jName'),phone=document.querySelector('#jPhone'),button=document.querySelector('#jSubmit');
      if(name)name.value='PRIVATECANARYNAME';if(phone)phone.value='01000001111';
      const agree=document.querySelector('#jAgree');if(agree)agree.checked=true;
      if(button){button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));if(typeof button.onclick==='function')button.onclick.call(button,new MouseEvent('click',{bubbles:true,cancelable:true}));}
      const form=document.querySelector('#joinForm');if(form)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
     });
     await page.waitForTimeout(300);
     await page.keyboard.press('Escape');
     assert.equal(await page.locator('#join').isVisible(),false);
     // A stale member script calling the new shared helper must not copy data.
     await page.evaluate(async ()=>{
      await window.kakaoSend('카톡으로 가입 완료하기','PRIVATECANARYNAME 01000001111','',{memberData:true});
      await window.kakaoSend('다른 제목','PRIVATECANARYNAME 01000001111','',{memberData:true});
     });
     assert.equal(await page.locator('#sheet').isVisible(),false);
     assert.deepEqual(await page.evaluate(()=>window.__testCopies),[]);

     // The estimator continues to work and exports no legacy member canary.
     assert.equal(await page.locator('#qSvc option').count(),12);
     const serviceIds=await page.locator('#qSvc option').evaluateAll(options=>options.map(o=>o.value));
     for(const id of serviceIds){
      await page.locator('#qSvc').selectOption(id);
      assert.notEqual((await page.locator('#qV').innerText()).trim(),'','estimate result must render');
     }
     await page.locator('#qSvc').selectOption('move-in');
     await page.locator('#qTier [data-t="0"]').click();
     assert.notEqual((await page.locator('#qV').innerText()).trim(),'');
     await page.locator('#qCopy').click();
     await page.locator('#qKakao').click();
     await page.locator('#sheet').waitFor({state:'visible'});
     const kakao=await page.locator('#sheetB a').getAttribute('href');
     assert.match(kakao,/^https:\/\/open\.kakao\.com\//);
     assert.equal(hasSecret(kakao),false);
     await page.keyboard.press('Escape');
     await page.evaluate(()=>{window.goSms=u=>{window.__testSms=u;};});
     await page.locator('#qSms').click();
     const sms=await page.evaluate(()=>window.__testSms||'');
     if(viewport.width===390)assert.match(sms,/^sms:/,'mobile SMS intent must be prepared');
     assert.equal(hasSecret(sms),false);
     const share=page.locator('[data-share]:visible').first();
     if(await share.count())await share.click();
     await page.waitForTimeout(100);
     const data=await page.evaluate(()=>({
      url:location.href,member:localStorage.getItem('member'),quote:localStorage.getItem('quote'),ref:localStorage.getItem('ref'),
      selection:localStorage.getItem('quote_public_selection_v1'),copies:window.__testCopies,shares:window.__testShares,
      analytics:window.dataLayer||[],html:document.documentElement.outerHTML
     }));
     if(legacy){assert.equal(data.member,member);assert.equal(data.quote,quote);assert.equal(data.ref,ref);}
     else assert.equal(data.member,null,'new member data must not be saved');
     assert.equal(hasSecret(data.url),false);assert.equal(hasSecret(data.selection),false);
     assert.equal(hasSecret(JSON.stringify(data.copies)),false);assert.equal(hasSecret(JSON.stringify(data.shares)),false);
     assert.equal(hasSecret(JSON.stringify(data.analytics)),false);
     // Existing local member data must not be rendered or embedded in links.
     assert.equal(hasSecret(data.html),false);
     assert.deepEqual(leaks,[]);
     assert.deepEqual(pageErrors,[]);
     assert.equal(remoteRequests.some(x=>/firestore|firebase|firebasejs|script\.google\.com/i.test(x)),false,'no membership backend request');
     await page.reload({waitUntil:'domcontentloaded'});
     const afterReload=await page.evaluate(()=>({member:localStorage.getItem('member'),quote:localStorage.getItem('quote'),ref:localStorage.getItem('ref')}));
     if(legacy)assert.deepEqual(afterReload,{member,quote,ref},'existing data must persist after reload');
     else assert.equal(afterReload.member,null,'no new member after reload');
     assert.deepEqual(leaks,[]);
     assert.deepEqual(pageErrors,[]);
     console.log(`member pause PASS ${viewport.width} legacy=${legacy}`);
    }finally{await context.close();}
   }
  }
 }finally{await browser.close();}
})().catch(e=>{const where=typeof e?.stack==='string'?e.stack.match(/member-paused-browser\.cjs:\d+:\d+/)?.[0]:null;console.error('MEMBER_PAUSE_TEST_FAILED',e?.name||'error',where||'unknown');process.exitCode=1;});
