const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch();
  try {
    for(const width of [320,390,1440]){
      const context=await browser.newContext({viewport:{width,height:900}});
      await context.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
      const page=await context.newPage();
      await page.goto('http://127.0.0.1:8768/prototype/affiliate/');
      assert.match(await page.locator('[role=status]').innerText(),/登録|등록되지 않았습니다/);
      assert.equal(await page.locator('a[rel*=sponsored]').count(),0);
      assert.equal(await page.locator('input,form').count(),0);
      assert.equal(await page.locator('a[href="../../index.html#quote"]').count(),1);
      assert.equal(await page.locator('a[href="../navigation-preview/index.html"]').count(),1);
      await page.locator('a[href="../navigation-preview/index.html"]').click();
      assert.match(await page.locator('h1').innerText(),/이동 검증/);
      await page.getByRole('link',{name:'청소용품 추천관 살펴보기'}).click();
      assert.match(await page.locator('h1').innerText(),/청소용품 추천관/);
      await page.locator('a[href="../../index.html#quote"]').click();
      assert.ok(page.url().includes('/index.html#quote'));
      await page.goBack();
      assert.match(await page.locator('h1').innerText(),/청소용품 추천관/);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await context.close();console.log('추천관 미승인 링크 차단·가로 넘침 검사 PASS',width);
    }
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
