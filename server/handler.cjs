'use strict';
// HTTP adapter with explicit dependencies; never logs bodies, tokens, or customer data.
const {createVerifiedReservationHandler}=require('../prototype/security/verified-reservation-handler.cjs');
const {createReceiptStatusHandler}=require('../prototype/security/receipt-status-handler.cjs');
const allowedStatuses=new Set(['신규','검토중','상담중','예약확정','작업완료','종료','취소']);
const safeId=/^[A-Za-z0-9_-]{1,80}$/;
const closed=new Set(['예약확정','작업완료','종료','취소']);
function validTransition(from,to){return allowedStatuses.has(to) && !(closed.has(from)&&!closed.has(to)) && !(from==='취소'&&to!=='취소') && !(to==='취소'&&!['신규','검토중','상담중','취소'].includes(from));}
function createHttpHandler({auth,appCheck,db,rateLimit,allowedOrigin}){
  if(!auth?.verifyIdToken || !appCheck?.verifyToken || !db?.runTransaction || !rateLimit || allowedOrigin!=='https://ok-clean.github.io')throw Error('Incomplete secure server configuration');
  const verifyIdToken=t=>auth.verifyIdToken(t,true);
  const submit=createVerifiedReservationHandler({verifyIdToken,db,enforceRateLimit:uid=>rateLimit(uid,'submit')});
  const status=createReceiptStatusHandler({verifyIdToken,enforceRateLimit:uid=>rateLimit(uid,'status'),loadRequest:async id=>{const s=await db.collection('quote_requests').doc(id).get();return s.exists?s.data():null;}});
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Origin');
    const origin=req.headers.origin;
    if(origin!==allowedOrigin){res.statusCode=403;return res.end();}
    res.setHeader('Access-Control-Allow-Origin',allowedOrigin);res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Firebase-AppCheck');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    if(req.method==='OPTIONS'){res.statusCode=204;return res.end();}
    const send=(code,body)=>{res.statusCode=code;res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(body));};
    if(req.method!=='POST')return send(405,{status:'unavailable'});
    if(!['/reservation/submit','/reservation/status','/admin/list','/admin/status'].includes(req.path))return send(404,{status:'unavailable'});
    try{
      if(typeof req.headers['x-firebase-appcheck']!=='string')return send(401,{status:'unavailable'});
      await appCheck.verifyToken(req.headers['x-firebase-appcheck']);
      const token=(req.headers.authorization||'').match(/^Bearer ([^ ]+)$/)?.[1];if(!token)return send(401,{status:'unavailable'});
      const caller=await verifyIdToken(token);
      if(!caller?.uid)return send(401,{status:'unavailable'});
      const data=req.body;if(!data||typeof data!=='object'||Array.isArray(data))return send(400,{status:'unavailable'});
      if(req.path==='/reservation/submit'||req.path==='/reservation/status'){
        const result=req.path.endsWith('/submit')?await submit({idToken:token,requestId:data.requestId,form:data.form}):await status({idToken:token,requestId:data.requestId});
        return send(result.httpStatus,result.body);
      }
      if(caller.admin!==true)return send(403,{status:'unavailable'});
      if(!await rateLimit(caller.uid,'admin'))return send(429,{status:'unavailable'});
      if(req.path==='/admin/list'){
        const docs=await db.collection('quote_requests').orderBy('createdAt','desc').limit(50).get();
        return send(200,{status:'ok',items:docs.docs.map(d=>{const v=d.data();return {id:d.id,service:v.service,area:v.area,size:v.size,date:v.date,name:v.name,phone:v.phone,notes:v.notes,status:v.status,createdAt:v.createdAt};})});
      }
      if(typeof data.requestId!=='string'||!safeId.test(data.requestId)||!allowedStatuses.has(data.status))return send(400,{status:'unavailable'});
      const ref=db.collection('quote_requests').doc(data.requestId);
      const outcome=await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)return 'missing';if(!validTransition(snap.data().status,data.status))return 'invalid';tx.update(ref,{status:data.status});return 'ok';});
      return send(outcome==='ok'?200:outcome==='missing'?404:409,{status:outcome==='ok'?'ok':'unavailable'});
    }catch{return send(503,{status:'unavailable'});}
  };
}
module.exports={createHttpHandler,validTransition};
