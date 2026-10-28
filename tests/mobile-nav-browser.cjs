const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:8765';

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for(const width of [320,390,720,721,768,900,1000,1001,1440]) {
      const context = await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await context.addInitScript(() => { if(location.hostname === '127.0.0.1') localStorage.setItem('joinLater', JSON.stringify(Date.now())); });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/index.html', {waitUntil:'load'});
      // Test the longest normal header: the install button is conditionally displayed.
      await page.locator('[data-install]').evaluate(el => { el.hidden = false; });
      const nav = page.locator('.top nav');
      const links = nav.locator('a');
      assert.equal(await links.count(), 5);
      assert.equal(await nav.isVisible(), true, `menu visible at ${width}px`);
      assert.equal(await page.locator('[data-share]').first().isVisible(), true);
      assert.equal(await page.locator('[data-install]').first().isVisible(), true);
      assert.equal(await page.locator('.top .call').isVisible(), width > 520);
      const measurements = await page.evaluate(() => ({
        document:document.documentElement.scrollWidth,
        viewport:innerWidth,
        navWidth:document.querySelector('.top nav').clientWidth,
        navScroll:document.querySelector('.top nav').scrollWidth,
        links:[...document.querySelectorAll('.top nav a')].map(a => ({width:a.getBoundingClientRect().width,height:a.getBoundingClientRect().height,href:a.getAttribute('href')})),
      }));
      assert.ok(measurements.document <= measurements.viewport + 1, `page overflows at ${width}px: ${measurements.document}`);
      assert.deepEqual(measurements.links.map(x => x.href), ['index.html#quote','index.html#services','index.html#cases','index.html#member','index.html#faq']);
      assert.ok(measurements.links.every(x => x.width >= 44 && x.height >= 44), `touch target at ${width}px`);
      if(width === 320) assert.ok(measurements.navScroll > measurements.navWidth, 'narrow menu scrolls within its own row');
      // The existing DOM order is brand, links, tools. Check real Tab focus and scrolling.
      await page.locator('.top .brand').focus();
      for(let index=0; index<5; index++) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.closest('.top nav') !== null), true);
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('.top nav a')].indexOf(document.activeElement)), index);
        const visible = await page.evaluate(() => {
          const nav = document.querySelector('.top nav').getBoundingClientRect(), link = document.activeElement.getBoundingClientRect();
          return link.left >= nav.left - 1 && link.right <= nav.right + 1;
        });
        assert.equal(visible, true, `focused menu item visible at ${width}px`);
      }
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-share')), true);
      if(width === 390 || width === 1440) {
        await nav.evaluate(el => { el.scrollLeft = 0; });
        await page.locator('.top .brand').focus();
        await page.evaluate(() => window.scrollTo(0,0));
        await page.screenshot({path:`/tmp/okclean-mobile-nav-${width}.png`});
      }
      await links.first().click();
      assert.equal(new URL(page.url()).hash, '#quote');
      assert.ok(await page.locator('#quote').evaluate(el => el.getBoundingClientRect().top >= 0));
      for(const path of ['/services/aircon.html','/area/' + encodeURIComponent('춘천') + '.html','/privacy.html']) {
        await page.goto(base + path, {waitUntil:'domcontentloaded'});
        assert.equal(await page.locator('.top nav').isVisible(), true);
        assert.equal(await page.locator('.top nav a').count(), 5);
        assert.equal(await page.locator('.top nav a').nth(3).getAttribute('href'), (path === '/privacy.html' ? '' : '../') + 'index.html#member');
        await page.locator('.top nav a').nth(3).click();
        assert.equal(new URL(page.url()).pathname, '/index.html');
        assert.equal(new URL(page.url()).hash, '#member');
      }
      assert.deepEqual(errors, []);
      await context.close();
      console.log('mobile navigation PASS ' + width);
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exit(1);});
