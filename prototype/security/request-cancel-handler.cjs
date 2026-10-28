'use strict';
// SERVER PROTOTYPE ONLY: real identity verification, rate limiting and hosting are not wired.
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const unavailable = code => ({httpStatus:code, body:{status:'unavailable'}});
function createCancelHandler({verifyIdToken, enforceRateLimit, cancelOwned} = {}) {
  if (![verifyIdToken,enforceRateLimit,cancelOwned].every(fn => typeof fn === 'function')) throw new TypeError('Trusted dependencies are required');
  return async function cancel(input) {
    let idToken,requestId;
    try {
      if (!input || Array.isArray(input) || typeof input !== 'object' ||
          Object.keys(input).sort().join(',') !== 'idToken,requestId') return unavailable(400);
      ({idToken,requestId}=input);
    } catch { return unavailable(400); }
    if (typeof requestId !== 'string' || !SAFE_ID.test(requestId)) return unavailable(400);
    if (typeof idToken !== 'string' || !idToken || idToken.length > 4096) return unavailable(401);
    let auth;
    try { auth = await verifyIdToken(idToken); } catch { return unavailable(401); }
    const provider = auth?.firebase?.sign_in_provider;
    const verified = (provider === 'password' && auth.email_verified === true) ||
      (provider === 'phone' && typeof auth.phone_number === 'string' && auth.phone_number.length > 0);
    if (typeof auth?.uid !== 'string' || !auth.uid || auth.uid.length > 128 || !verified) return unavailable(403);
    try {
      if (await enforceRateLimit(auth.uid) !== true) return unavailable(429);
      const result = await cancelOwned(requestId,auth.uid);
      if (result === 'cancelled') return {httpStatus:200,body:{status:'cancelled'}};
      if (result === 'not_found') return unavailable(404);
      if (result === 'closed') return unavailable(409);
      return unavailable(503);
    } catch { return unavailable(503); }
  };
}
module.exports = {createCancelHandler};
