'use strict';
// EMULATOR ONLY. Trusted server context, not a public browser or Firebase Admin SDK adapter.
const {doc, runTransaction} = require('firebase/firestore');
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const OPEN = new Set(['신규','검토중','상담중']);
function createCancellationStore(db) {
  if (!db) throw new TypeError('Database is required');
  return async function cancelOwned(requestId, uid) {
    if (typeof requestId !== 'string' || !SAFE_ID.test(requestId) ||
        typeof uid !== 'string' || !uid || uid.length > 128) throw new TypeError('Invalid identifier');
    const ref = doc(db,'quote_requests',requestId);
    return runTransaction(db,async tx => {
      const snapshot = await tx.get(ref);
      const record = snapshot.data();
      // Missing and someone else's request have the same outcome.
      if (!snapshot.exists() || record.ownerUid !== uid) return 'not_found';
      if (record.status === '취소') return 'cancelled';
      if (!OPEN.has(record.status)) return 'closed';
      tx.update(ref,{status:'취소'});
      return 'cancelled';
    });
  };
}
module.exports = {createCancellationStore};
