'use strict';
// Read-only receipt client. No Firebase admin credentials, token persistence, or write/retry path.
(function(root) {
 function createReceiptClient({endpoint, getIdToken, fetchImpl = globalThis.fetch, timeoutMs = 10000, allowLocalTesting = false} = {}) {
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError('An exact receipt endpoint is required'); }
  const local = allowLocalTesting === true && url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/api/receipt-status' ||
      typeof getIdToken !== 'function' || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new TypeError('Invalid receipt client configuration');
  return async function checkReceipt(requestId) {
   if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new TypeError('Invalid receipt ID');
   const controller = new AbortController(); let timer;
   const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve('unavailable'); }, timeoutMs); });
   const task = (async() => {
    const token = await getIdToken();
    if (controller.signal.aborted || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(token)) return 'unavailable';
    const response = await fetchImpl(url.href, {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},
     body:JSON.stringify({requestId}), credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer', signal:controller.signal});
    if (controller.signal.aborted || response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) {
     await response.body?.cancel(); return 'unavailable';
    }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
     for (;;) {
      const part = await reader.read();
      if (controller.signal.aborted) return 'unavailable';
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256) return 'unavailable';
      chunks.push(part.value);
     }
     const bytes = new Uint8Array(size); let offset = 0;
     for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
     const data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
     return data && !Array.isArray(data) && Object.keys(data).length === 1 && data.status === 'confirmed' ? 'confirmed' : 'unavailable';
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
   })();
   try { return await Promise.race([task, deadline]); }
   catch { return 'unavailable'; }
   finally { clearTimeout(timer); controller.abort(); }
  };
 }
 const api = Object.freeze({createReceiptClient});
 if (typeof module === 'object' && module.exports) module.exports = api;
 else root.OKCleanReceipt = api;
})(globalThis);
