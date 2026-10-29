'use strict';
// TEST ONLY comparison transport: no listener, credentials or production database are created here.
const PATH = '/api/offer-comparison';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const STATUS_CODES = new Set([200,400,401,403,404,429,503]);
const validTimeout = n => Number.isSafeInteger(n) && n >= 10 && n <= 30000;
function exactHttpsOrigin(value) {
 try { const u = new URL(value); return typeof value === 'string' && u.protocol === 'https:' && u.origin === value && !u.username && !u.password; }
 catch { return false; }
}
function readBody(req, limit, timeoutMs) {
 return new Promise((resolve, reject) => {
  const chunks = []; let bytes = 0, settled = false;
  const timer = setTimeout(() => finish(408), timeoutMs);
  function finish(code) {
   if (settled) return;
   settled = true; clearTimeout(timer);
   req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort);
   if (code) { req.pause(); reject(Object.assign(new Error('Invalid request body'), {httpStatus:code})); }
   else resolve(Buffer.concat(chunks, bytes));
  }
  function onData(chunk) {
   if (!Buffer.isBuffer(chunk)) { finish(400); return; }
   bytes += chunk.length;
   if (bytes > limit) { finish(413); return; }
   chunks.push(chunk);
  }
  function onEnd() { finish(); }
  function onAbort() { finish(400); }
  // Keep the request's error listener until its lifetime ends, including a client disconnect.
  req.on('error', onAbort);
  req.on('aborted', onAbort); req.on('data', onData); req.on('end', onEnd);
  if (req.aborted || req.destroyed) finish(400);
 });
}
function createComparisonHttpHandler({lookupComparison, allowedOrigins, maxBodyBytes = 1024, bodyTimeoutMs = 5000, lookupTimeoutMs = 5000} = {}) {
 if (typeof lookupComparison !== 'function' || !Array.isArray(allowedOrigins) || !allowedOrigins.length ||
     !allowedOrigins.every(exactHttpsOrigin) || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 64 || maxBodyBytes > 16384 ||
     !validTimeout(bodyTimeoutMs) || !validTimeout(lookupTimeoutMs)) throw new TypeError('Invalid comparison transport configuration');
 const origins = new Set(allowedOrigins);
 return async function comparisonHttpHandler(req, res) {
  let cors = {};
  function answer(code, body = {status:'unavailable'}, extra = {}) {
   if (res.headersSent || res.destroyed || res.writableEnded) return;
   res.writeHead(code, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store, private',
    Pragma:'no-cache', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', Vary:'Origin',
    ...cors, ...extra, ...(!req.complete ? {Connection:'close'} : {})});
   res.end(code === 204 ? undefined : JSON.stringify(body));
  }
  if (req.url !== PATH) { answer(404); return; }
  // Reject duplicate security-sensitive headers rather than relying on Node's first/last value policy.
  const seen = new Set();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
   const name = req.rawHeaders[i].toLowerCase();
   if (['authorization','origin','content-type','content-encoding'].includes(name)) {
    if (seen.has(name)) { answer(400); return; }
    seen.add(name);
   }
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !origins.has(origin)) { answer(403); return; }
  if (origin) cors = {'Access-Control-Allow-Origin':origin};
  if (req.method === 'OPTIONS') {
   const method = req.headers['access-control-request-method'];
   const headers = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
   if (!origin || method !== 'POST' || headers.some(x => !['authorization','content-type'].includes(x))) { answer(403); return; }
   answer(204, {status:'unavailable'}, {'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'Authorization, Content-Type'}); return;
  }
  if (req.method !== 'POST') { answer(405, {status:'unavailable'}, {Allow:'POST, OPTIONS'}); return; }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') ||
      (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) { answer(415); return; }
  const match = /^Bearer ([A-Za-z0-9._~-]{1,4096})$/.exec(req.headers.authorization || '');
  if (!match) { answer(401); return; }
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { answer(400); return; }
  if (Number(length) > maxBodyBytes) { answer(413); return; }
  let body;
  try { body = await readBody(req, maxBodyBytes, bodyTimeoutMs); }
  catch (error) { answer(error.httpStatus || 400); return; }
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(body)); }
  catch { answer(400); return; }
  if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).length !== 1 ||
      typeof data.requestId !== 'string' || !SAFE_ID.test(data.requestId)) { answer(400); return; }
  const controller = new AbortController(); let timer;
  const onClose = () => controller.abort();
  res.once('close', onClose);
  try {
   const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Lookup timeout')); }, lookupTimeoutMs); });
   const result = await Promise.race([Promise.resolve().then(() => lookupComparison({idToken:match[1],requestId:data.requestId}, {signal:controller.signal})), timeout]);
   if (!STATUS_CODES.has(result?.httpStatus)) { answer(503); return; }
   if (result.httpStatus !== 200) { answer(result.httpStatus); return; }
   const body = result.body;
   if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'offers,status' || body.status !== 'ok' ||
       !Array.isArray(body.offers) || body.offers.length > 3 || body.offers.some(o =>
         !o || Array.isArray(o) || typeof o !== 'object' || Object.keys(o).sort().join(',') !== 'company,price' ||
         typeof o.company !== 'string' || !o.company.trim() || o.company.length > 60 ||
         !Number.isSafeInteger(o.price) || o.price < 1 || o.price > 100000000)) { answer(503); return; }
   answer(200, {status:'ok',offers:body.offers.map(o => ({company:o.company.trim(),price:o.price}))});
  } catch { answer(503); }
  finally { clearTimeout(timer); res.off('close', onClose); }
 };
}
module.exports = {createComparisonHttpHandler};
