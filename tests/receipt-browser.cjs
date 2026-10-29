'use strict';
// Real Chromium + loopback HTTPS only. Fake identity verifier; NEVER uses production Firebase.
const assert=require('node:assert/strict');
const https=require('node:https');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {once}=require('node:events');
const {chromium}=require('playwright');
const {createReceiptHttpHandler}=require('../prototype/security/receipt-http-adapter.cjs');
const {createReceiptStatusHandler}=require('../prototype/security/receipt-status-handler.cjs');
const root=path.resolve(__dirname,'..');
const files=new Map([
 ['/prototype/receipt-status.html',['prototype/receipt-status.html','text/html']],
 ['/prototype/receipt-status.css',['prototype/receipt-status.css','text/css']],
 ['/prototype/receipt-demo.js',['prototype/receipt-demo.js','application/javascript']],
 ['/prototype/security/receipt-client.js',['prototype/security/receipt-client.js','application/javascript']],
 ['/prototype/security/receipt-view.js',['prototype/security/receipt-view.js','application/javascript']]
]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let passed=0;
async function scenario(name,fn){await fn();passed++;console.log('PASS '+name);}
async function state(page,expected){await page.waitForFunction(s=>document.getElementById('receipt-root').dataset.state===s,expected);}
async function submit(page){await page.locator('[data-receipt-submit]').click();}
async function cleanState(page){
 assert.deepEqual(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length,cookie:document.cookie})),{local:0,session:0,cookie:''});
}
(async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'okclean-receipt-'));
 // Ephemeral test certificate; never committed or reused for a public endpoint.
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(tmp,'key.pem'),'-out',path.join(tmp,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
 let handler, rateAllowed=true;
 const apiRequests=[],responses=[];
 const server=https.createServer({key:fs.readFileSync(path.join(tmp,'key.pem')),cert:fs.readFileSync(path.join(tmp,'cert.pem'))},(req,res)=>{
  if(req.url==='/api/receipt-status'){
   const entry={url:req.url,authorization:req.headers.authorization,cookie:req.headers.cookie,body:''};
   apiRequests.push(entry);req.on('data',b=>{entry.body+=b.toString()});
   res.on('finish',()=>responses.push(res.statusCode));
   Promise.resolve(handler(req,res)).catch(()=>res.destroy());return;
  }
  const file=files.get(new URL(req.url,'https://localhost').pathname);
  if(req.method!=='GET'||!file){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':file[1]+'; charset=utf-8','Cache-Control':'no-store'});
  res.end(fs.readFileSync(path.join(root,file[0])));
 });
 let browser;
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='https://127.0.0.1:'+server.address().port;
  const core=createReceiptStatusHandler({
   verifyIdToken:async token=>{
    if(token==='test-invalid')throw Error('secret-should-never-render');
    return {uid:token==='test-other'?'other':'owner',email_verified:token!=='test-unverified',firebase:{sign_in_provider:token==='test-anonymous'?'anonymous':'password'}};
   },
   loadRequest:async id=>{if(id==='slow')await sleep(500);return ['demo-receipt','slow'].includes(id)?{ownerUid:'owner',name:'PRIVATE-NAME',phone:'PRIVATE-PHONE'}:null;},
   enforceRateLimit:async()=>rateAllowed
  });
  handler=createReceiptHttpHandler({lookupReceipt:core,allowedOrigins:[base]});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
  console.log('Chromium '+browser.version());
  async function context(viewport,mode='demo',javaScriptEnabled=true){
   const ctx=await browser.newContext({viewport,ignoreHTTPSErrors:true,serviceWorkers:'block',javaScriptEnabled});
   const seen=[],errors=[];
   await ctx.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());seen.push({url:req.url(),method:req.method()});
    if(url.origin!==base){await route.abort();return;}
    if(mode!=='demo'&&url.pathname==='/prototype/receipt-demo.js'){
     const body=mode==='http'?`window.testIdentity='test-owner';window.testView=OKCleanReceiptView.mountReceiptView({root:document.getElementById('receipt-root'),timeoutMs:1500,checkReceipt:OKCleanReceipt.createReceiptClient({endpoint:location.origin+'/api/receipt-status',getIdToken:async()=>window.testIdentity,timeoutMs:1000})});document.getElementById('receipt-id').value='demo-receipt';`:'';
     await route.fulfill({status:200,contentType:'application/javascript',body});return;
    }
    await route.continue();
   });
   const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/prototype/receipt-status.html');
   return {ctx,page,seen,errors};
  }
  for(const width of [320,390,1440]){
   const viewport={width,height:width>1000?900:844};
   const {ctx,page,seen,errors}=await context(viewport);
   try{
    await scenario(width+'px: readable, no initial lookup, labeled controls',async()=>{
     await state(page,'idle');assert.equal(await page.getByLabel('시험용 접수번호',{exact:true}).inputValue(),'demo-receipt');
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
     assert.equal(seen.every(x=>x.method==='GET'),true);await cleanState(page);
    });
    await scenario(width+'px: invalid ID does not submit; input receives focus',async()=>{
     await page.locator('#receipt-id').fill('../invalid');await submit(page);await state(page,'invalid');
     assert.equal(await page.locator('#receipt-id').getAttribute('aria-invalid'),'true');
     assert.equal(await page.evaluate(()=>document.activeElement.id),'receipt-id');
    });
    await scenario(width+'px: keyboard confirmation is not reservation; live result focus',async()=>{
     await page.locator('#demo-case').selectOption('confirmed');await page.locator('#receipt-id').fill('demo-receipt');
     await page.locator('#receipt-id').press('Enter');await state(page,'confirmed');
     assert.match(await page.locator('#receipt-status').innerText(),/예약 확정이나 작업 완료를 뜻하지/);
     assert.match(await page.locator('#receipt-status').innerText(),/취소 여부도 별도로 확인/);
     assert.equal(await page.evaluate(()=>document.activeElement.id),'receipt-status');
     assert.equal(await page.locator('#receipt-status').getAttribute('role'),'status');
     if(process.env.EVIDENCE_DIR&&width>=390){fs.mkdirSync(process.env.EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.EVIDENCE_DIR,'receipt-'+width+'.png'),fullPage:true});}
    });
    await scenario(width+'px: unavailable and network error are not misreported as no receipt',async()=>{
     for(const mode of ['unavailable','error']){
      await page.locator('#demo-case').selectOption(mode);await submit(page);await state(page,'unavailable');
      assert.match(await page.locator('#receipt-status').innerText(),/새로 접수하지 말고/);
     }
    });
    await scenario(width+'px: missing response times out and unlocks controls',async()=>{
     await page.locator('#demo-case').selectOption('timeout');await submit(page);await state(page,'checking');
     assert.equal(await page.locator('[data-receipt-submit]').isDisabled(),true);
     await state(page,'unavailable');assert.equal(await page.locator('[data-receipt-submit]').isEnabled(),true);
    });
    await scenario(width+'px: clearing invalidates delayed success',async()=>{
     await page.locator('#demo-case').selectOption('delayed');await submit(page);await state(page,'checking');
     await page.locator('[data-receipt-clear]').click();await state(page,'idle');await sleep(800);
     assert.equal(await page.locator('#receipt-id').inputValue(),'');await state(page,'idle');
    });
    await scenario(width+'px: query endpoint injection ignored and refresh stores no identifier',async()=>{
     await page.locator('#receipt-id').fill('private-test-id');await page.reload();
     assert.equal(await page.locator('#receipt-id').inputValue(),'demo-receipt');
     await page.goto(base+'/prototype/receipt-status.html?endpoint=https://evil.invalid&token=ignored');
     await state(page,'idle');assert.equal(seen.every(x=>new URL(x.url).origin===base&&x.method==='GET'),true);
     await cleanState(page);assert.deepEqual(errors,[]);
    });
   }finally{await ctx.close();}
   const h=await context(viewport,'http');
   try{
    await scenario(width+'px: browser → client → HTTPS → ownership handler → success',async()=>{
     const before=apiRequests.length;await submit(h.page);await state(h.page,'confirmed');
     assert.equal(apiRequests.length,before+1);
     const req=apiRequests.at(-1);assert.equal(req.url,'/api/receipt-status');assert.deepEqual(JSON.parse(req.body),{requestId:'demo-receipt'});
     assert.equal(req.authorization,'Bearer test-owner');assert.equal(req.cookie,undefined);
     assert.doesNotMatch(await h.page.locator('body').innerText(),/PRIVATE-NAME|PRIVATE-PHONE|test-owner/);await cleanState(h.page);
    });
    await scenario(width+'px: anonymous/unverified/invalid/other identity fail closed',async()=>{
     for(const identity of ['test-anonymous','test-unverified','test-invalid','test-other']){
      await h.page.evaluate(token=>{window.testView.reset({clearInput:false});window.testIdentity=token;},identity);
      await submit(h.page);await state(h.page,'unavailable');
     }
    });
    await scenario(width+'px: throttled and missing records use safe unavailable result',async()=>{
     await h.page.evaluate(()=>window.testIdentity='test-owner');rateAllowed=false;
     await submit(h.page);await state(h.page,'unavailable');assert.equal(responses.at(-1),429);rateAllowed=true;
     await h.page.locator('#receipt-id').fill('missing');await submit(h.page);await state(h.page,'unavailable');
     assert.equal(responses.at(-1),404);
    });
    await scenario(width+'px: connection offline does not trigger re-submission',async()=>{
     await h.page.locator('#receipt-id').fill('demo-receipt');const before=apiRequests.length;
     await h.ctx.setOffline(true);await submit(h.page);await state(h.page,'unavailable');await h.ctx.setOffline(false);
     assert.equal(apiRequests.length,before);await sleep(100);assert.equal(apiRequests.length,before);
     assert.deepEqual(h.errors,[]);
    });
   }finally{rateAllowed=true;await h.ctx.close();}
  }
  const m=await context({width:390,height:844},'manual');
  try{
   await m.page.evaluate(()=>{
    window.calls=0;window.nextResult='confirmed';window.pendingResolve=null;
    window.testView=OKCleanReceiptView.mountReceiptView({root:document.getElementById('receipt-root'),timeoutMs:600,checkReceipt:async()=>{
     window.calls++;if(window.nextResult==='pending')return new Promise(r=>window.pendingResolve=r);
     if(window.nextResult==='error')throw Error('DO NOT DISPLAY');return window.nextResult;
    }});
   });
   await scenario('DOM: duplicate submit events share one lookup',async()=>{
    await m.page.locator('#receipt-id').fill('demo-receipt');
    await m.page.evaluate(()=>{window.nextResult='pending';const f=document.querySelector('form');for(let i=0;i<5;i++)f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    await m.page.waitForFunction(()=>window.calls===1);await m.page.evaluate(()=>window.pendingResolve('confirmed'));await state(m.page,'confirmed');
   });
   await scenario('DOM: non-confirmed values and HTML-like response stay unavailable',async()=>{
    for(const value of ['absent','<img src=x onerror=alert(1)>',null,{},'error']){
     await m.page.evaluate(v=>{window.testView.reset({clearInput:false});window.nextResult=v;},value);
     await submit(m.page);await state(m.page,'unavailable');
     assert.equal(await m.page.locator('#receipt-status img').count(),0);
    }
   });
   await scenario('DOM: pagehide and bfcache restoration clear transient state',async()=>{
    await m.page.locator('#receipt-id').fill('demo-receipt');await m.page.evaluate(()=>window.nextResult='pending');await submit(m.page);
    await m.page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await state(m.page,'idle');
    assert.equal(await m.page.locator('#receipt-id').inputValue(),'');
    await m.page.evaluate(()=>{window.pendingResolve('confirmed');window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});await state(m.page,'idle');
   });
   await scenario('DOM: reset before dispatch does not start stale lookup',async()=>{
    const before=await m.page.evaluate(()=>window.calls);await m.page.locator('#receipt-id').fill('demo-receipt');
    await m.page.evaluate(()=>{document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));window.testView.reset();});
    await sleep(100);assert.equal(await m.page.evaluate(()=>window.calls),before);await state(m.page,'idle');
   });
   await scenario('DOM: duplicate mounting rejected; destroy removes handlers and disables lookup',async()=>{
    assert.equal(await m.page.evaluate(()=>{try{OKCleanReceiptView.mountReceiptView({root:document.getElementById('receipt-root'),checkReceipt:async()=> 'confirmed'});return false;}catch{return true;}}),true);
    const before=await m.page.evaluate(()=>window.calls);await m.page.evaluate(()=>{window.testView.destroy();document.querySelector('form').dispatchEvent(new Event('submit',{cancelable:true}));});
    assert.equal(await m.page.locator('[data-receipt-submit]').isDisabled(),true);
    assert.equal(await m.page.evaluate(()=>window.calls),before);assert.deepEqual(m.errors,[]);
   });
  }finally{await m.ctx.close();}
  const nojs=await context({width:320,height:844},'demo',false);
  try{await scenario('No JavaScript: form cannot send data and status is explicit',async()=>{
   assert.equal(await nojs.page.locator('[data-receipt-submit]').isDisabled(),true);
   assert.match(await nojs.page.locator('noscript').innerText(),/입력값은 전송되지/);
   assert.equal(nojs.seen.every(x=>x.method==='GET'),true);
  });}finally{await nojs.ctx.close();}
  console.log(`PASS ${passed} browser scenario groups; fake data only; no external network`);
 }finally{
  if(browser)await browser.close();
  server.closeAllConnections();await new Promise(r=>server.close(r));
  fs.rmSync(tmp,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
