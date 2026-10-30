const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:8765';
const source = fs.readFileSync('index.html','utf8');
function makeHome(changeConfig){
  return source.replace(/(<script id="cfg" type="application\/json">)([\s\S]*?)(<\/script>)/, (_,start,raw,end)=>{
    const cfg=JSON.parse(raw);
    cfg.firebase=null;cfg.memberBackendUrl='';cfg.kakao='https://example.test/chat';cfg.blog=[];
    if(changeConfig) changeConfig(cfg);
    return start+JSON.stringify(cfg).replace(/<\//g,'<\\/')+end;
  });
}

(async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    for(const viewport of [{width:390,height:844},{width:1440,height:900}]){
      async function open(seed,changeConfig){
        const context=await browser.newContext({viewport,serviceWorkers:'block'});
        const home=makeHome(changeConfig);
        await context.route('**/*',route=>{
          const url=new URL(route.request().url());
          if(url.hostname!=='127.0.0.1')return route.abort();
          if(url.pathname==='/'||url.pathname==='/index.html')return route.fulfill({status:200,contentType:'text/html',body:home});
          if(url.pathname==='/cases.json')return route.fulfill({status:200,contentType:'application/json',body:'{"cases":[]}'});
          return route.continue();
        });
        await context.addInitScript(value=>{
          if(location.hostname!=='127.0.0.1')return;
          localStorage.setItem('joinLater',JSON.stringify(Date.now()));
          if(!sessionStorage.getItem('seeded')){
            if(value!==null)localStorage.setItem('quote',JSON.stringify(value));
            sessionStorage.setItem('seeded','1');
          }
          Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.fakeCopy=text;}}});
        },seed);
        const page=await context.newPage(),errors=[];
        page.on('pageerror',err=>errors.push(err.message));
        await page.goto(base+'/',{waitUntil:'load'});
        return {context,page,errors};
      }
      // 공개 견적 선택만 저장하며 지역·날짜는 재방문 시 자동 복원하지 않습니다.
      const normal=await open(null);
      await normal.page.locator('#qSvc').selectOption('aircon');
      await normal.page.locator('#qVar [data-v="2"]').click();
      await normal.page.locator('#qQty').fill('3');
      await normal.page.locator('#qOpt input').first().check();
      const area=await normal.page.locator('#qArea option').evaluateAll(options=>options.find(o=>o.value)?.value);
      assert.ok(area,'an available region is required');
      await normal.page.locator('#qArea').selectOption(area);
      await normal.page.locator('#qDate').fill('2099-01-01');
      const expectedPrice=await normal.page.locator('#qV').innerText();
      await normal.page.locator('#qCopy').click();
      const expectedCopy=await normal.page.evaluate(()=>window.fakeCopy);
      const saved=await normal.page.evaluate(()=>JSON.parse(localStorage.getItem('quote_public_selection_v1')));
      assert.deepEqual(Object.keys(saved).sort(),['opts','qty','svc','t','v']);
      await normal.context.close();
      const restored=await open(saved);
      assert.equal(await restored.page.locator('#qSvc').inputValue(),'aircon');
      assert.equal(await restored.page.locator('#qQty').inputValue(),'3');
      assert.equal(await restored.page.locator('#qArea').inputValue(),'');
      assert.equal(await restored.page.locator('#qDate').inputValue(),'');
      assert.equal(await restored.page.locator('#qVar [data-v="2"]').getAttribute('aria-pressed'),'true');
      assert.equal(await restored.page.locator('#qOpt input').first().isChecked(),true);
      assert.equal(await restored.page.locator('#qV').innerText(),expectedPrice);
      await restored.page.locator('#qCopy').click();
      assert.equal(await restored.page.evaluate(()=>window.fakeCopy),expectedCopy.split('\n').filter(line=>!line.startsWith('지역: ')&&!line.startsWith('희망 날짜: ')).join('\n'));
      await restored.page.reload({waitUntil:'load'});
      assert.equal(await restored.page.locator('#qV').innerText(),expectedPrice);
      assert.equal(await restored.page.locator('#qArea').inputValue(),'');
      assert.equal(await restored.page.locator('#qDate').inputValue(),'');
      assert.deepEqual(restored.errors,[]);await restored.context.close();
      // 옵션 저장값이 배열이 아니어도 나머지 정상 선택과 견적을 사용할 수 있습니다.
      for(const opts of [{bad:1},42,'0']){
        const rig=await open({svc:'aircon',v:2,qty:3,t:null,opts});
        assert.equal(await rig.page.locator('#qVar [data-v="2"]').getAttribute('aria-pressed'),'true');
        assert.equal(await rig.page.locator('#qQty').inputValue(),'3');
        assert.equal(await rig.page.locator('#qOpt input').first().isChecked(),false);
        await rig.page.locator('#qCopy').click();
        assert.match(await rig.page.evaluate(()=>window.fakeCopy),/예상 금액/);
        assert.deepEqual(rig.errors,[]);await rig.context.close();
      }
      // 음수·중복·오래된 옵션 인덱스는 제거하고 유효한 선택은 보존합니다.
      const invalid=await open({svc:'move-in',v:-1,t:-1,qty:null,opts:[0,999,0,-1,'1',null]});
      assert.equal(await invalid.page.locator('#qVar [data-v="0"]').getAttribute('aria-pressed'),'true');
      const tier=await invalid.page.locator('#qTier [aria-pressed="true"]').count();assert.equal(tier,1);
      assert.equal(await invalid.page.locator('#qOpt input').first().isChecked(),true);
      assert.deepEqual((await invalid.page.evaluate(()=>JSON.parse(localStorage.getItem('quote_public_selection_v1')))).opts,[0]);
      await invalid.page.locator('#qCopy').click();assert.match(await invalid.page.evaluate(()=>window.fakeCopy),/예상 금액/);
      assert.deepEqual(invalid.errors,[]);await invalid.context.close();
      // 설정에서 종류와 옵션이 줄어든 경우에만 범위를 벗어난 값을 버립니다.
      const changed=await open({svc:'aircon',v:5,qty:3,opts:[0]},cfg=>{
        const s=cfg.services.find(x=>x.id==='aircon');s.variants=s.variants.slice(0,1);s.options=[];
      });
      assert.equal(await changed.page.locator('#qQty').inputValue(),'3');
      const recovered=await changed.page.evaluate(()=>JSON.parse(localStorage.getItem('quote_public_selection_v1')));
      assert.equal(recovered.v,0);assert.deepEqual(recovered.opts,[]);
      await changed.page.locator('#qCopy').click();assert.match(await changed.page.evaluate(()=>window.fakeCopy),/예상 금액/);
      assert.deepEqual(changed.errors,[]);await changed.context.close();
      // 객체가 들어온 수량·지역·날짜는 문자열 변환 오류 없이 기본값으로 복구합니다.
      const malformed={valueOf:null,toString:null};
      const fields=await open({svc:'aircon',v:0,qty:malformed,area:malformed,date:malformed,opts:[]});
      assert.equal(await fields.page.locator('#qQty').inputValue(),'1');
      assert.equal(await fields.page.locator('#qArea').inputValue(),'');
      assert.equal(await fields.page.locator('#qDate').inputValue(),'');
      await fields.page.locator('#qCopy').click();assert.match(await fields.page.evaluate(()=>window.fakeCopy),/예상 금액/);
      assert.deepEqual(fields.errors,[]);await fields.context.close();
      for(const seed of [[],42,'broken']){
        const rig=await open(seed);await rig.page.locator('#qCopy').click();
        assert.ok(await rig.page.evaluate(()=>window.fakeCopy));
        assert.deepEqual(rig.errors,[]);await rig.context.close();
      }
      console.log(`quote storage recovery PASS ${viewport.width}`);
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
