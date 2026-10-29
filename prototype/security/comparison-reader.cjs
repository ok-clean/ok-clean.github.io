'use strict';
// EMULATOR ONLY. Trusted server context; never bundle into a public browser.
// This Firebase Web SDK adapter is exercised with an emulator admin test identity.
const {doc, runTransaction} = require('firebase/firestore');
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const OPEN = new Set(['신규','검토중','상담중']);
const SLOTS = ['0','1','2'];
const validUid = x => typeof x === 'string' && x.length > 0 && x.length <= 128;
const safeId = x => typeof x === 'string' && SAFE_ID.test(x);
function createComparisonReader(db, {now = Date.now} = {}) {
  if (!db || typeof now !== 'function') throw new TypeError('Invalid comparison configuration');
  return async function loadOwnedComparison(requestId, uid) {
    if (!safeId(requestId) || !validUid(uid)) throw new TypeError('Invalid identifier');
    const requestRef = doc(db, 'quote_requests', requestId);
    return runTransaction(db, async tx => {
      const request = await tx.get(requestRef);
      const record = request.data();
      // Do not read slot, offer or partner records before ownership is confirmed.
      if (!request.exists() || record.ownerUid !== uid) return null;
      const deadline = typeof record.date?.toMillis === 'function' ? record.date.toMillis() : NaN;
      const current = now();
      if (!Number.isFinite(current) || !Number.isFinite(deadline)) throw Error('Invalid request date');
      if (!OPEN.has(record.status) || deadline < current) return null;
      const slots = await Promise.all(SLOTS.map(id => tx.get(doc(requestRef, 'slots', id))));
      const offers = [], seenPartners = new Set(), seenGrants = new Set();
      for (let i = 0; i < SLOTS.length; i++) {
        if (!slots[i].exists()) continue;
        const {partnerUid, grantId} = slots[i].data();
        if (!safeId(partnerUid) || !safeId(grantId) || seenPartners.has(partnerUid) || seenGrants.has(grantId)) throw Error('Invalid slot');
        seenPartners.add(partnerUid); seenGrants.add(grantId);
        const [pointer, grant, profile, offer] = await Promise.all([
          tx.get(doc(requestRef, 'assignments', partnerUid)),
          tx.get(doc(requestRef, 'grants', grantId)),
          tx.get(doc(db, 'partner_profiles', partnerUid)),
          tx.get(doc(requestRef, 'offers', grantId))
        ]);
        if (!pointer.exists() || !grant.exists() || !profile.exists()) throw Error('Incomplete assignment');
        const p = pointer.data(), g = grant.data(), provider = profile.data();
        if (p.slotId !== SLOTS[i] || p.grantId !== grantId || g.slotId !== SLOTS[i] || g.partnerUid !== partnerUid ||
            !Number.isSafeInteger(g.approvalVersion) || !Number.isSafeInteger(provider.approvalVersion)) throw Error('Mismatched assignment');
        // Revoked approval or outdated grant is intentionally hidden.
        if (provider.status !== '승인' || provider.approvalVersion !== g.approvalVersion) continue;
        if (g.service !== record.service || g.area !== record.area || g.size !== record.size ||
            typeof g.date?.toMillis !== 'function' || g.date.toMillis() !== deadline) throw Error('Mismatched request');
        if (!offer.exists()) continue;
        const {price} = offer.data(), company = provider.company;
        if (typeof company !== 'string' || !company.trim() || company.length > 60 ||
            !Number.isSafeInteger(price) || price < 1 || price > 100000000) throw Error('Invalid offer');
        offers.push({company:company.trim(), price});
      }
      return offers;
    });
  };
}
module.exports = {createComparisonReader};
