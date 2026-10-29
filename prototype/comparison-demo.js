'use strict';
// Fixed local demonstration. No endpoint, identity, storage or actual quote request.
(function(){
 const root=document.getElementById('comparison-root'), scenario=document.getElementById('demo-case');
 if(!root || !scenario || !globalThis.OKCleanComparisonView) return;
 const sample=[{company:'가상 청소업체 A',price:250000},{company:'가상 청소업체 B',price:290000}];
 const view=OKCleanComparisonView.mount({root,timeoutMs:1200,loadOffers:async()=>{
  const chosen=scenario.value;
  if(chosen==='error') throw Error('Simulated error');
  if(chosen==='timeout') return new Promise(()=>{});
  await new Promise(resolve=>setTimeout(resolve,chosen==='delayed'?700:100));
  return chosen==='empty'?[]:sample;
 }});
 scenario.addEventListener('change',()=>view.reset({focus:false}));
})();
