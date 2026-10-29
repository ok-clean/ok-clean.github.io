'use strict';
const {createHash}=require('node:crypto');
// Prices originate from the site's config.json at build time, never the request.
const serviceLabels={'move-in':'입주·이사 청소',regular:'거주·정기 청소',office:'사무실·상가 청소',clinic:'사무실·상가 청소',aircon:'에어컨 청소'};
const version=services=>createHash('sha256').update(JSON.stringify(services)).digest('hex');
function createPricePolicy(services){
 if(!Array.isArray(services)||!services.length)throw Error('Server price policy unavailable');
 const ver=version(services);
 return function validatePrice(form){
  if(!form||typeof form!=='object'||!form.pricing||typeof form.pricing!=='object'||Array.isArray(form.pricing))return null;
  const p=form.pricing;
  if(Object.keys(p).sort().join(',')!=='options,policyVersion,quantity,serviceId,tier,variant')return null;
  if(p.policyVersion!==ver || typeof p.serviceId!=='string'||!Number.isInteger(p.variant)||p.variant<0 || !Array.isArray(p.options))return null;
  const s=services.find(x=>x.id===p.serviceId);if(!s||form.service!==(serviceLabels[s.id]||'그 외 청소'))return null;
  const tiers=s.tiers||[], vars=tiers.length?(s.kinds||[]):(s.variants||[]),opts=s.options||[];
  if((vars.length&&p.variant>=vars.length)||(!vars.length&&p.variant!==0))return null;
  if(tiers.length?(!Number.isInteger(p.tier)||p.tier<0||p.tier>=tiers.length):p.tier!==null)return null;
  if(p.quantity!==null && (!Number.isInteger(p.quantity)||p.quantity<1||p.quantity>999))return null;
  if(p.options.some(i=>!Number.isInteger(i)||i<0||i>=opts.length)||new Set(p.options).size!==p.options.length)return null;
  const quote=!!s.quote||(!tiers.length&&!vars.length);let lo=null,hi=null;
  if(!quote){
   const v=vars[p.variant]||{};let q=1;
   if(tiers.length){const t=tiers[p.tier];if(!t.quote){lo=t.price;hi=v.open?null:t.price;}}
   else if(!v.quote){if(p.quantity===null)return null;q=p.quantity;lo=v.lo*q;hi=v.hi==null?null:v.hi*q;}
   if(lo!==null){for(const i of p.options){const o=opts[i];if(o.quote)continue;const m=o.perUnit?q:1;lo+=o.lo*m;hi=(hi===null||o.hi==null)?null:hi+o.hi*m;}if(s.min){lo=Math.max(lo,s.min);if(hi!==null)hi=Math.max(hi,s.min);}}
  }
  if(lo!==null&&(!Number.isSafeInteger(lo)||lo<0||lo>1e9))return null;
  if(hi!==null&&(!Number.isSafeInteger(hi)||hi<lo||hi>1e9))return null;
  if((lo===null ? Object.hasOwn(form,'estimateMin') : form.estimateMin!==lo) || (hi===null ? Object.hasOwn(form,'estimateMax') : form.estimateMax!==hi))return null;
  return {serviceId:p.serviceId,variant:p.variant,tier:p.tier,quantity:p.quantity,options:[...p.options].sort((a,b)=>a-b),policyVersion:ver};
 };
}
module.exports={createPricePolicy,version};
