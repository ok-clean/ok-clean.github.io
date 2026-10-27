// Emulator prototype only: not connected to the public request form.
const { koreanDayEnd } = require('./kst-date.cjs');
const { doc, collection, setDoc, getDoc, getDocs, updateDoc, serverTimestamp } = require('firebase/firestore');
const SERVICES = ['입주·이사 청소','거주·정기 청소','사무실·상가 청소','에어컨 청소','후드·주방 청소','그 외 청소'];
const AREAS = ['춘천','화천','양구','인제','철원','홍천','횡성','가평','그 외 지역'];
const STATUSES = ['신규','검토중','상담중','예약확정','작업완료','종료'];
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
function validateRequest(form) {
 if (!form || !SERVICES.includes(form.service) || !AREAS.includes(form.area)) throw new Error('서비스 또는 지역을 확인해 주세요.');
 if (!Number.isInteger(form.size) || form.size < 1 || form.size > 999) throw new Error('면적을 확인해 주세요.');
 if (!(form.date instanceof Date) || !Number.isFinite(form.date.getTime()) || form.date.getTime() < Date.now() || form.date.getTime() > Date.now() + 366 * 86400000) throw new Error('희망 날짜를 확인해 주세요.');
 if (typeof form.name !== 'string' || !form.name.trim() || form.name.trim().length > 30) throw new Error('이름을 확인해 주세요.');
 if (typeof form.phone !== 'string' || !/^01[016789]-?[0-9]{3,4}-?[0-9]{4}$/.test(form.phone)) throw new Error('연락처를 확인해 주세요.');
 if (form.consent !== true) throw new Error('개인정보 수집에 동의해 주세요.');
}
async function createQuote(db, uid, id, form) {
 if (!uid || !safeId(id)) throw new Error('요청 식별자를 확인해 주세요.');
 const date = typeof form?.date === 'string' ? koreanDayEnd(form.date) : form?.date;
 validateRequest({...form, date});
 const payload = {service:form.service,area:form.area,size:form.size,date,name:form.name.trim(),phone:form.phone,
  consentVersion:'test-v1',consentAt:serverTimestamp(),createdAt:serverTimestamp(),ownerUid:uid,status:'신규'};
 // The returned promise settles only when the Firestore write is acknowledged.
 await setDoc(doc(db,'quote_requests',id),payload);
 return {id};
}
async function checkOwnQuote(db, id) {
 if (!safeId(id)) throw new Error('접수 식별자를 확인해 주세요.');
 const snapshot = await getDoc(doc(db, 'quote_requests', id));
 // Only use this with an authenticated owner-scoped Firestore client.
 return snapshot.exists() ? 'confirmed' : 'absent';
}
async function listQuotes(db) {
 const result = await getDocs(collection(db,'quote_requests'));
 return result.docs.map(d => ({id:d.id,...d.data()}));
}
async function setStatus(db,id,status) {
 if (!safeId(id) || !STATUSES.includes(status)) throw new Error('요청 상태를 확인해 주세요.');
 await updateDoc(doc(db,'quote_requests',id),{status});
}
module.exports = {createQuote, checkOwnQuote, listQuotes, setStatus};
