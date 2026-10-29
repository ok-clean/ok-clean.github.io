'use strict';
// SERVER PROTOTYPE ONLY: injected token verification/limiting/storage are not production wiring.
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const unavailable = code => ({httpStatus:code, body:{status:'unavailable'}});
function createComparisonHandler({verifyIdToken, enforceRateLimit, loadOwnedComparison} = {}) {
  if (![verifyIdToken,enforceRateLimit,loadOwnedComparison].every(fn => typeof fn === 'function')) throw new TypeError('Trusted dependencies are required');
  return async function comparison({idToken,requestId} = {}) {
    if (typeof requestId !== 'string' || !SAFE_ID.test(requestId)) return unavailable(400);
    if (typeof idToken !== 'string' || !idToken) return unavailable(401);
    let auth;
    try { auth = await verifyIdToken(idToken); } catch { return unavailable(401); }
    const provider = auth?.firebase?.sign_in_provider;
    const verified = (provider === 'password' && auth.email_verified === true) ||
      (provider === 'phone' && typeof auth.phone_number === 'string' && auth.phone_number.length > 0);
    if (typeof auth?.uid !== 'string' || !auth.uid || auth.uid.length > 128 || !verified) return unavailable(403);
    try {
      if (await enforceRateLimit(auth.uid) !== true) return unavailable(429);
      const entries = await loadOwnedComparison(requestId,auth.uid);
      if (entries === null) return unavailable(404);
      if (!Array.isArray(entries) || entries.length > 3) throw Error('Invalid entries');
      const offers = entries.map(entry => {
        if (typeof entry?.company !== 'string' || !entry.company.trim() || entry.company.length > 60 ||
            !Number.isSafeInteger(entry.price) || entry.price < 1 || entry.price > 100000000) throw Error('Invalid offer');
        return {company:entry.company.trim(),price:entry.price};
      });
      return {httpStatus:200,body:{status:'ok',offers}};
    } catch { return unavailable(503); }
  };
}
module.exports = {createComparisonHandler};
