'use strict';
// Synthetic canaries; the direct export must fail before reading data or contacting a backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
(async () => {
  let network = 0, reads = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => { network++; throw Error('unexpected network'); };
  try {
    const source = fs.readFileSync('member-sync.js', 'utf8');
    const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const denied = new Proxy({}, {get() { reads++; throw Error('unexpected data access'); }});
    await assert.rejects(mod.submitMember(denied, denied), /MEMBER_SIGNUP_PAUSED/);
    assert.equal(reads, 0);
    assert.equal(network, 0);
    console.log('member direct submit paused PASS');
  } finally { global.fetch = originalFetch; }
})().catch(e => { console.error(e.name); process.exitCode = 1; });
