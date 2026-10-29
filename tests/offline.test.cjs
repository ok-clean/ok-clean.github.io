const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const events = {}, cached = {};
const context = {
  self: {addEventListener: (name, cb) => events[name] = cb},
  location: {origin: 'https://example.test'}, URL, Response,
  fetch: () => Promise.reject(new Error('offline')),
  caches: {match: async req => cached[typeof req === 'string' ? req : req.url]}
};
vm.runInNewContext(fs.readFileSync('sw.js', 'utf8'), context);
function request(url, mode) {
  let response;
  events.fetch({request: {method: 'GET', url, mode}, respondWith: p => response = p});
  return response;
}
(async () => {
  cached['./index.html'] = new Response('home');
  assert.equal(await (await request('https://example.test/services/x', 'navigate')).text(), 'home');
  assert.equal((await request('https://example.test/app.js', 'no-cors')).type, 'error');
  cached['https://example.test/app.js'] = new Response('cached script');
  assert.equal(await (await request('https://example.test/app.js', 'no-cors')).text(), 'cached script');
  console.log('Offline navigation, missing asset and cached asset checks passed');
})().catch(err => {console.error(err); process.exit(1);});
