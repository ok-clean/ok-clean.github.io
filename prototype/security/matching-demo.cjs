// Local-only mock matching workflow. Never use with real customer data.
const STATES = ['신규','검토중','배정','견적도착','예약확정','작업완료'];
function createDemoMatching() {
 const requests = new Map();
 const partners = new Map();
 function registerPartner(id, company) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof company !== 'string' || !company.trim() || company.length > 60 || partners.has(id)) throw Error('업체 정보를 확인하세요.');
  partners.set(id, {company, approved:false});
 }
 function revokePartner(id) {
  const partner=partners.get(id);
  if (!partner) throw Error('등록된 업체가 아닙니다.');
  partner.approved=false;
  for (const request of requests.values()) {
   request.assigned.delete(id);
   request.offers.delete(id);
  }
 }
 function unassign(requestId, partnerId) {
  const request=requests.get(requestId);
  if (!request) throw Error('요청이 없습니다.');
  request.assigned.delete(partnerId);
  request.offers.delete(partnerId);
 }
 function approvePartner(id) {
  const partner = partners.get(id);
  if (!partner) throw Error('등록된 업체가 아닙니다.');
  partner.approved = true;
 }
 function createRequest(id, fields) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || requests.has(id) || !fields || typeof fields.service !== 'string' || !fields.service.trim() || typeof fields.area !== 'string' || !fields.area.trim()) throw Error('요청 정보 오류');
  requests.set(id,{service:fields.service,area:fields.area,status:'신규',assigned:new Set(),offers:new Map()});
 }
 function assign(requestId, partnerId) {
  const request=requests.get(requestId), partner=partners.get(partnerId);
  if (!request || !partner?.approved) throw Error('승인된 업체만 배정 가능합니다.');
  if (request.status === '예약확정' || request.status === '작업완료') throw Error('확정된 요청은 배정할 수 없습니다.');
  request.assigned.add(partnerId);request.status='배정';
 }
 function offer(requestId, partnerId, price) {
  const request=requests.get(requestId), partner=partners.get(partnerId);
  if (!request || !partner?.approved || !request.assigned.has(partnerId)) throw Error('견적 권한이 없습니다.');
  if (request.status === '예약확정' || request.status === '작업완료') throw Error('마감된 요청에는 견적을 제출할 수 없습니다.');
  if (!Number.isInteger(price) || price <= 0 || request.offers.has(partnerId)) throw Error('견적 정보 오류');
  request.offers.set(partnerId,price);request.status='견적도착';
 }
 function setStatus(requestId, status) {
  const request=requests.get(requestId);
  if (!request || !STATES.includes(status)) throw Error('상태 정보 오류');
  if (status === '예약확정' && request.offers.size === 0) throw Error('견적 없이 예약할 수 없습니다.');
  if (status === '작업완료' && request.status !== '예약확정') throw Error('예약 확정 후 완료할 수 있습니다.');
  request.status=status;
 }
 function compare(requestId) {
  const request=requests.get(requestId);
  if (!request) throw Error('요청이 없습니다.');
  return [...request.offers].filter(([id])=>partners.get(id)?.approved && request.assigned.has(id)).map(([id,price])=>({company:partners.get(id).company,price})).sort((a,b)=>a.price-b.price);
 }
 return {registerPartner,approvePartner,revokePartner,unassign,createRequest,assign,offer,setStatus,compare};
}
module.exports={createDemoMatching,STATES};
