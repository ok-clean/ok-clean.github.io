'use strict';
// EMULATOR PROTOTYPE. Web SDK clients with verified auth; NOT Firebase Admin SDK.
// Rules remain the authority even when callers bypass this module. No UI/production wiring.
const {doc, collection, getDocFromServer, runTransaction, serverTimestamp, setDoc} = require('firebase/firestore');
const idOK = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
function ids(...values) { if (!values.every(idOK)) throw new TypeError('Invalid identifier'); }
function requestOpen(data) {
  return data && ['신규','검토중','상담중'].includes(data.status) && typeof data.date?.toMillis === 'function' && data.date.toMillis() >= Date.now();
}
async function reviewPartnerAsAdmin(db, uid, status) {
  ids(uid);
  if (!['검토중','승인','반려'].includes(status)) throw new TypeError('Invalid review status');
  const ref = doc(db,'partner_profiles',uid);
  return runTransaction(db,async tx => {
    const snapshot = await tx.get(ref), p = snapshot.data();
    if (!snapshot.exists() || !Number.isSafeInteger(p.approvalVersion) || p.approvalVersion >= 1000000 || p.status === status) throw new Error('Review conflict');
    const approvalVersion = p.approvalVersion + 1;
    tx.update(ref,{status,approvalVersion});
    return {approvalVersion};
  });
}
async function assignPartnerAsAdmin(db, requestId, partnerUid) {
  ids(requestId,partnerUid);
  const requestRef = doc(db,'quote_requests',requestId), profileRef = doc(db,'partner_profiles',partnerUid);
  const pointerRef = doc(requestRef,'assignments',partnerUid);
  // Generate once outside the retryable transaction; never reuse a previous grant ID.
  const grantRef = doc(collection(requestRef,'grants'));
  await runTransaction(db,async tx => {
    const request = await tx.get(requestRef), profile = await tx.get(profileRef), pointer = await tx.get(pointerRef);
    const slots = ['0','1','2'].map(slotId => doc(requestRef,'slots',slotId));
    const slotSnapshots = await Promise.all(slots.map(ref => tx.get(ref)));
    const r = request.data(), p = profile.data();
    const index = slotSnapshots.findIndex(s => !s.exists());
    if (!requestOpen(r) || p?.status !== '승인' || !Number.isSafeInteger(p.approvalVersion) || pointer.exists() || index < 0) throw new Error('Assignment unavailable');
    const slotId = String(index);
    const projection = {partnerUid,approvalVersion:p.approvalVersion,slotId,service:r.service,area:r.area,size:r.size,date:r.date,createdAt:serverTimestamp()};
    tx.set(grantRef,projection);
    tx.set(pointerRef,{grantId:grantRef.id,slotId});
    tx.set(slots[index],{partnerUid,grantId:grantRef.id});
  });
  return {grantId:grantRef.id};
}
async function revokeAssignmentAsAdmin(db, requestId, partnerUid) {
  ids(requestId,partnerUid);
  // Removing the pointer and its slot together revokes access and frees capacity.
  const requestRef = doc(db,'quote_requests',requestId);
  const pointerRef = doc(requestRef,'assignments',partnerUid);
  await runTransaction(db,async tx => {
    const pointer = await tx.get(pointerRef);
    if (!pointer.exists()) throw new Error('Assignment unavailable');
    const {slotId,grantId} = pointer.data();
    if (!['0','1','2'].includes(slotId) || !idOK(grantId)) throw new Error('Invalid assignment');
    const slotRef = doc(requestRef,'slots',slotId), slot = await tx.get(slotRef);
    if (!slot.exists() || slot.data().partnerUid !== partnerUid || slot.data().grantId !== grantId) throw new Error('Assignment inconsistent');
    tx.delete(pointerRef); tx.delete(slotRef);
  });
}
async function readAssignedQuote(db, requestId, partnerUid) {
  ids(requestId,partnerUid);
  const pointer = await getDocFromServer(doc(db,'quote_requests',requestId,'assignments',partnerUid));
  const grantId = pointer.data()?.grantId;
  ids(grantId);
  const snapshot = await getDocFromServer(doc(db,'quote_requests',requestId,'grants',grantId));
  const grant = snapshot.data();
  if (!snapshot.exists() || grant.partnerUid !== partnerUid) throw new Error('Assignment unavailable');
  return {grantId,service:grant.service,area:grant.area,size:grant.size,date:grant.date};
}
async function submitAssignedOffer(db, requestId, grantId, {price,note=''} = {}) {
  ids(requestId,grantId);
  if (!Number.isSafeInteger(price) || price < 1 || price > 100000000 || typeof note !== 'string' || note.length > 500) throw new TypeError('Invalid offer');
  // Create-only rule prevents races/overwrites; authorization rechecked at write time.
  await setDoc(doc(db,'quote_requests',requestId,'offers',grantId),{price,note,createdAt:serverTimestamp()});
  return {grantId};
}
module.exports = {reviewPartnerAsAdmin,assignPartnerAsAdmin,revokeAssignmentAsAdmin,readAssignedQuote,submitAssignedOffer};
