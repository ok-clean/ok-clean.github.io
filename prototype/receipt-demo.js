'use strict';
// Fixed local demonstration only. Never reads endpoint/token/UID from URL or storage.
(function() {
 const root=document.getElementById('receipt-root');
 const scenario=document.getElementById('demo-case');
 if (!root || !scenario || !globalThis.OKCleanReceiptView) return;
 root.querySelector('[data-receipt-id]').value='demo-receipt';
 const view=OKCleanReceiptView.mountReceiptView({root, timeoutMs:1200, checkReceipt:async()=>{
  const selected=scenario.value;
  if (selected==='error') throw new Error('Simulated failure');
  if (selected==='timeout') return new Promise(()=>{});
  await new Promise(resolve=>setTimeout(resolve,selected==='delayed'?700:150));
  return selected==='confirmed'||selected==='delayed'?'confirmed':'unavailable';
 }});
 scenario.addEventListener('change',()=>view.reset({clearInput:false,focus:false}));
})();
