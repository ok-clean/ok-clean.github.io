'use strict';
// Server-only helper. `caller` must come exclusively from Admin SDK verifyIdToken.
// Never include contact details, request notes, auth tokens, or errors in the response.
const SAFE_ID=/^[A-Za-z0-9_-]{1,80}$/;
const LIMIT=50;
function verifiedCaller(caller){
 const provider=caller?.firebase?.sign_in_provider;
 return typeof caller?.uid==='string' && caller.uid.length>0 &&
   ((provider==='password' && caller.email_verified===true) ||
    (provider==='phone' && typeof caller.phone_number==='string' && caller.phone_number.length>0));
}
const result=(httpStatus,status,extra={})=>({httpStatus,body:{status,...extra}});
function createCustomerReservationsHandler({db,rateLimit}){
 if(typeof db?.collection!=='function'||typeof db?.runTransaction!=='function'||typeof rateLimit!=='function')throw TypeError('Database and rate limit required');
 return async function list(caller){
  if(!verifiedCaller(caller))return result(403,'unavailable');
  try{
   if(await rateLimit(caller.uid,'status')!==true)return result(429,'unavailable');
   const snapshot=await db.runTransaction(async tx=>{const gate=await tx.get(db.collection('account_lifecycle').doc(caller.uid));if(gate.exists)return null;return tx.get(db.collection('quote_requests').where('ownerUid','==',caller.uid).limit(LIMIT+1));});
   if(!snapshot)return result(403,'unavailable');
   const rows=[];
   for(const doc of snapshot.docs){
    if(rows.length===LIMIT)break;
    const d=doc.data();
    // Check again even though the indexed query was owner-scoped.
    if(!SAFE_ID.test(doc.id)||!d||d.ownerUid!==caller.uid)continue;
    let date=null;
    try { const x=d.date && typeof d.date.toDate==='function'?d.date.toDate():d.date;if(x instanceof Date && Number.isFinite(x.getTime()))date=x.toISOString(); } catch{}
    rows.push({id:doc.id,service:typeof d.service==='string'?d.service.slice(0,100):'',status:typeof d.status==='string'?d.status.slice(0,30):'',date});
   }
   return result(200,'ok',{items:rows,truncated:snapshot.docs.length>LIMIT});
  }catch{return result(503,'unavailable');}
 };
}
module.exports={createCustomerReservationsHandler,verifiedCaller};
