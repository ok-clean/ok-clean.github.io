'use strict';
// Fixed local demonstration. No endpoint, identity, storage, actual lookup or cancellation.
(function(){
 const root=document.getElementById('cancellation-root'),scenario=document.getElementById('demo-case');
 if (!root || !scenario || !globalThis.OKCleanCancellationView) return;
 const view=OKCleanCancellationView.mount({root,timeoutMs:1200,loadState:async({signal})=>{
  const selected=scenario.value;
  if (selected==='error') throw Error('Simulated error');
  if (selected==='timeout') return new Promise(()=>{});
  await new Promise(resolve=>{
   const timer=setTimeout(finish,selected==='delayed'?700:100);
   function finish(){clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();}
   if(signal.aborted)finish();else signal.addEventListener('abort',finish,{once:true});
  });
  return selected==='delayed'?'cancelled':selected;
 }});
 scenario.addEventListener('change',()=>view.reset({focus:false}));
})();
