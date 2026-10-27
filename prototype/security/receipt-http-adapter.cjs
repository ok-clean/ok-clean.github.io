'use strict';
// TEST ONLY: transport for a trusted server. Does not start a listener or provide Firebase credentials.
// GitHub Pages cannot execute this module. Supply a trusted, server-side lookupReceipt callback.
const MAX_BYTES = 1024;
const PATH = '/api/receipt-status';
function createReceiptHttpHandler({lookupReceipt, allowedOrigins, maxBodyBytes = MAX_BYTES}) {
  if (typeof lookupReceipt !== 'function' || !Array.isArray(allowedOrigins) || !allowedOrigins.length ||
      !allowedOrigins.every(origin => typeof origin === 'string' && /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(origin)) ||
      !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 64 || maxBodyBytes > 16384) {
    throw new TypeError('Trusted lookup, exact HTTPS origins and safe payload limit required');
  }
  const origins = new Set(allowedOrigins);
  function answer(res, statusCode, status = 'unavailable', otherHeaders = {}) {
    res.writeHead(statusCode, {
      'Content-Type':'application/json; charset=utf-8',
      'Cache-Control':'no-store, private',
      'Pragma':'no-cache',
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer',
      'Vary':'Origin',
      ...otherHeaders
    });
    res.end(JSON.stringify({status}));
  }
  return async function receiptHttpHandler(req, res) {
    if (req.url !== PATH) { answer(res,404); return; }
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) { answer(res,403); return; }
    const cors = origin ? {'Access-Control-Allow-Origin':origin} : {};
    if (req.method === 'OPTIONS') {
      answer(res,204,'unavailable',{
        ...cors,
        'Access-Control-Allow-Methods':'POST, OPTIONS',
        'Access-Control-Allow-Headers':'Authorization, Content-Type',
        'Access-Control-Max-Age':'600'
      });
      return;
    }
    if (req.method !== 'POST') { answer(res,405,'unavailable',{...cors,Allow:'POST, OPTIONS'}); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
      answer(res,415,'unavailable',cors); return;
    }
    // Never authenticate using cookies, query parameters or a caller-supplied UID.
    const match = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/.exec(req.headers.authorization || '');
    if (!match) { answer(res,401,'unavailable',cors); return; }
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) { answer(res,413,'unavailable',cors); req.resume(); return; }
    let raw = '';
    try {
      for await (const part of req) {
        raw += part.toString('utf8');
        if (Buffer.byteLength(raw,'utf8') > maxBodyBytes) { answer(res,413,'unavailable',cors); return; }
      }
      let data;
      try { data = JSON.parse(raw); }
      catch { answer(res,400,'unavailable',cors); return; }
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
          Object.keys(data).length !== 1 || typeof data.requestId !== 'string') {
        answer(res,400,'unavailable',cors); return;
      }
      const result = await lookupReceipt({idToken:match[1],requestId:data.requestId});
      const statusCode = result?.httpStatus;
      const allowedStatuses = new Set([200,400,401,403,404,429,503]);
      if (!allowedStatuses.has(statusCode) || (statusCode === 200 && result.body?.status !== 'confirmed')) {
        answer(res,503,'unavailable',cors); return;
      }
      answer(res,statusCode,statusCode === 200 ? 'confirmed' : 'unavailable',cors);
    } catch {
      if (!res.headersSent) answer(res,503,'unavailable',cors);
    }
  };
}
module.exports = {createReceiptHttpHandler};
