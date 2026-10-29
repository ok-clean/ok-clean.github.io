const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

(async () => {
  const handlers = {};
  const written = [];
  const sandbox = {
    URL, location: {origin: 'https://example.test'},
    self: {registration: {scope: 'https://example.test/sub/'}, addEventListener: (type, handler) => { handlers[type] = handler; }},
    fetch: async req => ({ok: true, clone: () => ({url:req.url})}),
    caches: {open: async () => ({put: async (req) => {written.push(req.url);}}), match: async () => undefined},
    Response: {error: () => ({error:true})}
  };
  vm.runInNewContext(fs.readFileSync('sw.js', 'utf8'), sandbox);
  async function request(url, mode='cors', method='GET') {
    let result, lifetime;
    const req = {url, mode, method};
    handlers.fetch({request:req, respondWith:p => {result = p;}, waitUntil:p => {lifetime = p;}});
    if(result) await result;
    if(lifetime) await lifetime;
    return !!result;
  }
  assert.equal(await request('https://example.test/sub/cases.json?t=123'), true);
  assert.deepEqual(written, []);
  const ordinary = [
    ['https://example.test/sub/cases.json?t=1&t=2'],
    ['https://example.test/sub/cases.json?t=1&x=2'],
    ['https://example.test/sub/cases.json?t=one'],
    ['https://example.test/sub/cases.json'],
    ['https://example.test/other/cases.json?t=1'],
    ['https://example.test/sub/app.js?t=1'],
    ['https://example.test/sub/cases.json?t=99', 'navigate'],
  ];
  for(const args of ordinary) assert.equal(await request(...args), true);
  assert.deepEqual(written, ordinary.map(x => x[0]));
  assert.equal(await request('https://elsewhere.test/sub/cases.json?t=123'), false);
  assert.equal(await request('https://example.test/sub/cases.json?t=123', 'cors', 'POST'), false);
  assert.equal(written.length, ordinary.length);
  console.log('case cache scope and request policy PASS');
})().catch(error => {console.error(error); process.exitCode = 1;});
