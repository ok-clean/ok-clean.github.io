// Offline routing regression; this does not simulate Android application installation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'sw.js'), 'utf8');

function worker({offline = true, seed = {}, networkStatus = 200, deferWrite = false} = {}) {
  const handlers = {}, entries = new Map(Object.entries(seed));
  const deleted = [], writes = [];
  let completeWrite;
  const writeGate = deferWrite ? new Promise(resolve => { completeWrite = resolve; }) : Promise.resolve();
  const key = request => typeof request === 'string' ? request : request.url;
  const cache = {
    match: async request => entries.has(key(request)) ? new Response(entries.get(key(request))) : undefined,
    put: async (request, response) => { await writeGate; const body = await response.text(); entries.set(key(request), body); writes.push(key(request)); }
  };
  vm.runInNewContext(source, {
    self: {addEventListener: (name, callback) => { handlers[name] = callback; }, skipWaiting: async () => {}, clients: {claim: async () => {}}},
    caches: {
      open: async () => cache,
      keys: async () => ['okclean-v1', 'okclean-public-v2', 'unrelated-app'],
      delete: async name => { deleted.push(name); }
    },
    location: {origin: 'https://ok-clean.github.io'}, URL, Response,
    fetch: async () => { if (offline) throw new Error('offline'); return new Response('network body', {status: networkStatus}); }
  });
  return {
    deleted, entries, writes, completeWrite,
    request(path, method = 'GET') {
      const waits = []; let response;
      handlers.fetch({request: {url: new URL(path, 'https://ok-clean.github.io').href, method},
        waitUntil: promise => waits.push(promise), respondWith: promise => { response = promise; }});
      return {response, done: Promise.all(waits)};
    },
    async activate() { let work; handlers.activate({waitUntil: promise => { work = promise; }}); await work; }
  };
}

test('missing administrator document cannot fall back to cached customer HTML', async () => {
  const w = worker({seed: {'https://ok-clean.github.io/index.html': '<h1>customer</h1>'}});
  for (const path of ['/admin/', '/admin/admin.js', '/admin/manifest.webmanifest']) {
    const result = w.request(path); const response = await result.response; await result.done;
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.doesNotMatch(await response.text(), /customer|<html|<h1>/);
  }
});

test('each cached app URL returns only its own document offline', async () => {
  const w = worker({seed: {'https://ok-clean.github.io/admin/': 'administrator', 'https://ok-clean.github.io/app/': 'customer'}});
  for (const [path, expected] of [['/admin/', 'administrator'], ['/app/', 'customer']]) {
    const result = w.request(path);
    assert.equal(await (await result.response).text(), expected); await result.done;
  }
});

test('network response is usable before cache persistence finishes; write stays in event lifetime', async () => {
  const w = worker({offline: false, deferWrite: true});
  const result = w.request('/admin/');
  assert.equal(await (await result.response).text(), 'network body');
  assert.equal(w.writes.length, 0);
  let finished = false; result.done.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  w.completeWrite(); await result.done;
  assert.equal(w.entries.get('https://ok-clean.github.io/admin/'), 'network body');
});

test('HTTP failures stay failures and are not cached as application documents', async () => {
  const w = worker({offline: false, networkStatus: 404});
  const result = w.request('/admin/missing.js');
  assert.equal((await result.response).status, 404); await result.done;
  assert.equal(w.writes.length, 0);
});

test('non-GET and external authentication/data traffic are not intercepted', async () => {
  const w = worker();
  assert.equal(w.request('/admin/', 'POST').response, undefined);
  assert.equal(w.request('https://firestore.googleapis.com/test').response, undefined);
  assert.equal(w.request('https://okclean-admin.firebaseapp.com/__/auth/handler').response, undefined);
});

test('upgrade only removes this site legacy cache and preserves other applications', async () => {
  const w = worker(); await w.activate();
  assert.deepEqual(w.deleted, ['okclean-v1']);
});
