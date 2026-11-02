'use strict';
// Prototype server component: wire only to trusted Firebase Admin SDK and a real rate limiter.
// Never expose service-account credentials or this privileged database client to browsers.
const crypto = require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const services = new Set(['입주·이사 청소','거주·정기 청소','사무실·상가 청소','에어컨 청소','후드·주방 청소','그 외 청소']);
const areas = new Set(['춘천','화천','양구','인제','철원','홍천','횡성','가평','그 외 지역']);
const reply = (code, status) => ({httpStatus:code, body:{status}});
function validate(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = ['service','area','size','date','name','phone','notes','estimateMin','estimateMax','consent','pricing'];
  if (Object.keys(input).some(k => !keys.includes(k))) return null;
  const {service,area,size,date,name,phone,notes='',estimateMin,estimateMax,consent,pricing} = input;
  if (!services.has(service) || !areas.has(area) || !Number.isInteger(size) || size < 1 || size > 999 ||
      typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof name !== 'string' || !name.trim() || name.length > 30 ||
      typeof phone !== 'string' || !/^01[016789]-?[0-9]{3,4}-?[0-9]{4}$/.test(phone) ||
      typeof notes !== 'string' || notes.length > 500 || consent !== true) return null;
  const dateObj = new Date(date+'T14:59:59.999Z');
  if (!Number.isFinite(dateObj.getTime()) || dateObj.toISOString().slice(0,10) !== date || dateObj < now || dateObj.getTime() > now.getTime()+366*86400000) return null;
  if (estimateMin !== undefined && (!Number.isInteger(estimateMin) || estimateMin < 0 || estimateMin > 1e9)) return null;
  if (estimateMax !== undefined && (!Number.isInteger(estimateMax) || estimateMin === undefined || estimateMax < estimateMin || estimateMax > 1e9)) return null;
  if (pricing !== undefined && (!pricing || typeof pricing !== 'object' || Array.isArray(pricing))) return null;
  return {service,area,size,date,name:name.trim(),phone,notes, ...(pricing !== undefined ? {pricing} : {}), ...(estimateMin !== undefined ? {estimateMin} : {}), ...(estimateMax !== undefined ? {estimateMax} : {}),consent:true};
}
// Existing documents must retain the submitted data, not only its digest.
// Administrative metadata may be added without changing this canonical subset.
const storedStatuses=new Set(['신규','검토중','상담중','예약확정','작업완료','종료','취소']);
function storedTime(value){
  try {
    const date=value instanceof Date ? value : value && typeof value.toDate==='function' ? value.toDate() : null;
    return date instanceof Date && Number.isSafeInteger(date.getTime()) ? date.getTime() : NaN;
  } catch {return NaN;}
}
function matchesStoredReservation(record,valid,{uid,fingerprint,now}){
  if(!record||typeof record!=='object'||Array.isArray(record))return false;
  if(record.ownerUid!==uid||record.requestFingerprint!==fingerprint||!storedStatuses.has(record.status)||
    record.retentionRedacted===true||record.dataMutationFrozen===true)return false;
  if(typeof record.consentVersion!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(record.consentVersion))return false;
  for(const key of ['createdAt','consentAt']){
    const at=storedTime(record[key]);if(!Number.isFinite(at)||at<0||at>now.getTime())return false;
  }
  if(storedTime(record.date)!==new Date(valid.date+'T14:59:59.999Z').getTime())return false;
  for(const key of ['service','area','size','name','phone','notes','estimateMin','estimateMax','pricing']){
    if(Object.hasOwn(record,key)!==Object.hasOwn(valid,key)||!isDeepStrictEqual(record[key],valid[key]))return false;
  }
  return true;
}
function createVerifiedReservationHandler({verifyIdToken, db, enforceRateLimit, now = () => new Date(), consentVersion = 'test-v1'}) {
  if (typeof consentVersion !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(consentVersion)) throw new TypeError('Consent version required');
  if (typeof verifyIdToken !== 'function' || typeof enforceRateLimit !== 'function' || typeof db?.runTransaction !== 'function' || typeof db?.collection !== 'function') throw new TypeError('Trusted authentication, database and rate limit are required');
  return async function submit({idToken,requestId,form} = {}) {
    if (typeof requestId !== 'string' || !ID.test(requestId)) return reply(400,'unavailable');
    let auth;
    try { auth = await verifyIdToken(idToken); } catch { return reply(401,'unavailable'); }
    const provider=auth?.firebase?.sign_in_provider;
    if (typeof auth?.uid !== 'string' || !auth.uid || !((provider === 'password' && auth.email_verified === true) || (provider === 'phone' && typeof auth.phone_number === 'string' && auth.phone_number))) return reply(403,'unavailable');
    const timestamp = now();
    const valid = validate(form,timestamp);
    if (!valid) return reply(400,'unavailable');
    try {
      if (await enforceRateLimit(auth.uid) !== true) return reply(429,'unavailable');
      const ref=db.collection('quote_requests').doc(requestId);
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify(valid)).digest('hex');
      const result=await db.runTransaction(async tx => {
        const lifecycle=await tx.get(db.collection('account_lifecycle').doc(auth.uid));
        if(lifecycle.exists)return 'unavailable';
        const snap=await tx.get(ref);
        if (snap.exists) {
          const record=snap.data();
          return matchesStoredReservation(record,valid,{uid:auth.uid,fingerprint,now:timestamp}) ? 'confirmed' : 'unavailable';
        }
        const {date,consent,...data}=valid;
        tx.create(ref,{...data,date:new Date(date+'T14:59:59.999Z'),ownerUid:auth.uid,status:'신규',consentVersion,consentAt:timestamp,createdAt:timestamp,requestFingerprint:fingerprint});
        return 'confirmed';
      });
      return result === 'confirmed' ? reply(200,'confirmed') : reply(409,'unavailable');
    } catch { return reply(503,'unavailable'); }
  };
}
module.exports={createVerifiedReservationHandler,matchesStoredReservation};
