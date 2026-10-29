'use strict';
// PROTOTYPE ONLY. Server-side dependency-injected handler, not an HTTP endpoint.
// verifyIdToken MUST verify Firebase token signature/audience/expiry using a trusted SDK.
// Do not import this module from a public browser or pass a privileged database client there.
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const response = (httpStatus, status) => ({httpStatus, body:{status}});
function createReceiptStatusHandler({verifyIdToken, loadRequest, enforceRateLimit}) {
  if (![verifyIdToken, loadRequest, enforceRateLimit].every(fn => typeof fn === 'function')) {
    throw new TypeError('Trusted verification, database and rate-limit callbacks are required');
  }
  return async function lookupReceipt({idToken, requestId} = {}) {
    if (typeof requestId !== 'string' || !SAFE_ID.test(requestId)) return response(400, 'unavailable');
    if (typeof idToken !== 'string' || !idToken) return response(401, 'unavailable');
    let auth;
    try { auth = await verifyIdToken(idToken); }
    catch { return response(401, 'unavailable'); }
    const provider = auth?.firebase?.sign_in_provider;
    const verified = (provider === 'password' && auth.email_verified === true) ||
      (provider === 'phone' && typeof auth.phone_number === 'string' && auth.phone_number.length > 0);
    if (typeof auth?.uid !== 'string' || !auth.uid || !verified) return response(403, 'unavailable');
    try {
      if (await enforceRateLimit(auth.uid) !== true) return response(429, 'unavailable');
      const record = await loadRequest(requestId);
      // Missing and someone else's record have the same response; return no contact details.
      if (!record || record.ownerUid !== auth.uid) return response(404, 'unavailable');
      return response(200, 'confirmed');
    } catch {
      // Never return exception messages or sensitive Firestore payloads to callers.
      return response(503, 'unavailable');
    }
  };
}
module.exports = {createReceiptStatusHandler};
