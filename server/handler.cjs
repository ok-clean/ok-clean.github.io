'use strict';
// HTTP adapter with explicit dependencies; never logs bodies, tokens, or customer data.
const {createVerifiedReservationHandler}=require('../prototype/security/verified-reservation-handler.cjs');
const {createReceiptStatusHandler}=require('../prototype/security/receipt-status-handler.cjs');
const {createPricePolicy}=require('./pricing.cjs');
const {createCustomerReservationsHandler,verifiedCaller}=require('./customer-reservations.cjs');
const {createWithdrawalHandler}=require('./account-withdrawal.cjs');
const allowedStatuses=new Set(['신규','검토중','상담중','예약확정','작업완료','종료','취소']);
const safeId=/^[A-Za-z0-9_-]{1,80}$/;
const closed=new Set(['예약확정','작업완료','종료','취소']);
function canManageReservations(claims){return claims?.reservation_admin === true || claims?.super_admin === true || claims?.admin === true;}
function validTransition(from,to){return allowedStatuses.has(to) && !(closed.has(from)&&!closed.has(to)) && !(from==='취소'&&to!=='취소') && !(to==='취소'&&!['신규','검토중','상담중','취소'].includes(from));}
function createHttpHandler({auth,appCheck,db,rateLimit,allowedOrigin,services,consentVersion,protectedMemberAdminUid,withdrawalPolicyReviewed}){
  if(!auth?.verifyIdToken || !appCheck?.verifyToken || !db?.runTransaction || !rateLimit || allowedOrigin!=='https://ok-clean.github.io')throw Error('Incomplete secure server configuration');
  if(typeof consentVersion!=='string' || !/^[A-Za-z0-9._-]{1,80}$/.test(consentVersion))throw Error('Consent configuration required');
  const validatePrice=createPricePolicy(services);
  const customerList=createCustomerReservationsHandler({db,rateLimit});
  const withdrawal=typeof auth.getUser==='function'?createWithdrawalHandler({db,auth,rateLimit,protectedMemberAdminUid,withdrawalPolicyReviewed}):null;
  const verifyIdToken=t=>auth.verifyIdToken(t,true);
  const submit=createVerifiedReservationHandler({verifyIdToken,db,consentVersion,enforceRateLimit:uid=>rateLimit(uid,'submit')});
  const status=createReceiptStatusHandler({verifyIdToken,enforceRateLimit:uid=>rateLimit(uid,'status'),loadRequest:async(id,uid)=>db.runTransaction(async tx=>{const gate=await tx.get(db.collection('account_lifecycle').doc(uid));if(gate.exists)return null;const s=await tx.get(db.collection('quote_requests').doc(id));return s.exists?s.data():null;})});
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Origin');
    const origin=req.headers.origin;
    if(origin!==allowedOrigin){res.statusCode=403;return res.end();}
    res.setHeader('Access-Control-Allow-Origin',allowedOrigin);res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Firebase-AppCheck');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    if(req.method==='OPTIONS'){res.statusCode=204;return res.end();}
    const send=(code,body)=>{res.statusCode=code;res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(body));};
    if(req.method!=='POST')return send(405,{status:'unavailable'});
    if(!['/reservation/submit','/reservation/status','/reservation/list','/reservation/account-status','/reservation/withdraw','/admin/list','/admin/status','/admin/history'].includes(req.path))return send(404,{status:'unavailable'});
    try{
      if(typeof req.headers['x-firebase-appcheck']!=='string')return send(401,{status:'unavailable'});
      await appCheck.verifyToken(req.headers['x-firebase-appcheck']);
      const token=(req.headers.authorization||'').match(/^Bearer ([^ ]+)$/)?.[1];if(!token)return send(401,{status:'unavailable'});
      const caller=await verifyIdToken(token);
      if(!caller?.uid)return send(401,{status:'unavailable'});
      const data=req.body;if(!data||typeof data!=='object'||Array.isArray(data))return send(400,{status:'unavailable'});
      if(req.path==='/reservation/account-status'){if(!verifiedCaller(caller))return send(403,{status:'unavailable'});if(!await rateLimit(caller.uid,'status'))return send(429,{status:'unavailable'});const life=await db.collection('account_lifecycle').doc(caller.uid).get();return send(200,{status:'ok',withdrawalPending:life.exists});}
      if(req.path==='/reservation/withdraw'){if(!withdrawal)return send(503,{status:'unavailable'});const result=await withdrawal(caller);return send(result.httpStatus,result.body);}
      if(req.path==='/reservation/list'){const result=await customerList(caller);return send(result.httpStatus,result.body);}
      if(req.path==='/reservation/submit'||req.path==='/reservation/status'){
        let result;
        if(req.path.endsWith('/submit')){
          if(!data.form || data.form.consentVersion!==consentVersion)return send(400,{status:'unavailable'});
          const pricing=validatePrice(data.form);if(!pricing)return send(400,{status:'unavailable'});
          const {consentVersion:requestedVersion,...form}=data.form;form.pricing=pricing;
          result=await submit({idToken:token,requestId:data.requestId,form});
        }else result=await status({idToken:token,requestId:data.requestId});
        return send(result.httpStatus,result.body);
      }
      if(!canManageReservations(caller))return send(403,{status:'unavailable'});
      if(!await rateLimit(caller.uid,'admin'))return send(429,{status:'unavailable'});
      if(req.path==='/admin/list'){
        const docs=await db.collection('quote_requests').orderBy('createdAt','desc').limit(50).get();
        return send(200,{status:'ok',items:docs.docs.map(d=>{const v=d.data();return {id:d.id,service:v.service,area:v.area,size:v.size,date:v.date,name:v.name,phone:v.phone,notes:v.notes,status:v.status,createdAt:v.createdAt};})});
      }
      if(typeof data.requestId!=='string'||!safeId.test(data.requestId))return send(400,{status:'unavailable'});
      const ref=db.collection('quote_requests').doc(data.requestId);
      if(req.path==='/admin/history'){
        const entries=await ref.collection('status_history').orderBy('at','desc').limit(30).get();
        return send(200,{status:'ok',items:entries.docs.map(doc=>{const {from,to,at}=doc.data();return {from,to,at};})});
      }
      if(!allowedStatuses.has(data.status))return send(400,{status:'unavailable'});
      const history=ref.collection('status_history').doc();
      const outcome=await db.runTransaction(async tx=>{
        const snap=await tx.get(ref);if(!snap.exists)return 'missing';if(snap.data().retentionRedacted===true)return 'invalid';const oldStatus=snap.data().status;
        if(!validTransition(oldStatus,data.status))return 'invalid';
        if(oldStatus!==data.status){tx.update(ref,{status:data.status});tx.create(history,{from:oldStatus,to:data.status,actorUid:caller.uid,at:new Date()});}
        return 'ok';
      });
      return send(outcome==='ok'?200:outcome==='missing'?404:409,{status:outcome==='ok'?'ok':'unavailable'});
    }catch{return send(503,{status:'unavailable'});}
  };
}
module.exports={createHttpHandler,validTransition,canManageReservations};
