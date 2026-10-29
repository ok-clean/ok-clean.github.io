// Service worker lifecycle test: no real network or customer data.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}
function worker({network, put, cached} = {}) {
  const handlers = {}, calls = {puts: 0};
  const cache = {
    put: (...args) => { calls.puts++; return put(...args); },
    match: async () => cached
  };
  const self = {
    registration: {scope:'https://example.test/'},
    clients: {claim:async()=>{}}, skipWaiting:()=>{},
    addEventListener: (name, listener) => { handlers[name] = listener; }
  };
  const caches = {open:async name => { assert.equal(name,'okclean-v1'); return cache; }};
  vm.runInNewContext(fs.readFileSync('sw.js','utf8'), {
    self, caches, URL, Response, location:{origin:'https://example.test'},
    fetch:network
  }, {filename:'sw.js'});
  return {
    calls,
    request(path, mode='cors') {
      let response, lifetime;
      handlers.fetch({
        request:{url:'https://example.test'+path, method:'GET', mode},
        respondWith: p => {response=p;},
        waitUntil: p => {lifetime=p;}
      });
      return {response, lifetime};
    }
  };
}

test('network response is prompt while the cache write keeps the worker alive', async () => {
  const pending = deferred();
  const rig = worker({network:async()=>new Response('fresh'), put:()=>pending.promise});
  const event = rig.request('/app.js');
  assert.ok(event.lifetime, 'waitUntil must be registered during the fetch event');
  assert.equal(await (await event.response).text(), 'fresh');
  let complete = false;
  event.lifetime.then(()=>{ complete=true; });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rig.calls.puts, 1);
  assert.equal(complete, false, 'lifetime must include pending cache write');
  pending.resolve();
  await event.lifetime;
  assert.equal(complete, true);
});

test('cache storage rejection does not replace a successful network response', async () => {
  const rig = worker({network:async()=>new Response('fresh'), put:async()=>{throw new Error('fake quota');}});
  const event = rig.request('/app.js');
  assert.equal(await (await event.response).text(), 'fresh');
  await event.lifetime;
  assert.equal(rig.calls.puts, 1);
});

test('failed HTTP responses and timestamped case requests are never cached', async () => {
  for (const [path, status] of [['/missing',404], ['/cases.json?t=123',200]]) {
    const rig = worker({network:async()=>new Response('result',{status}), put:async()=>{}});
    const event = rig.request(path);
    assert.equal((await event.response).status, status);
    await event.lifetime;
    assert.equal(rig.calls.puts, 0);
  }
});

test('network failure falls back to the current site cache', async () => {
  const rig = worker({network:async()=>{throw new Error('offline');}, put:async()=>{}, cached:new Response('saved')});
  const event = rig.request('/app.js');
  assert.equal(await (await event.response).text(), 'saved');
  await event.lifetime;
  assert.equal(rig.calls.puts, 0);
});
