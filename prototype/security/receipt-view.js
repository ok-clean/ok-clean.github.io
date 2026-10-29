'use strict';
// Read-only DOM binding. No token handling, storage, automatic request, or submission/write API.
(function(global) {
 const mounts = new WeakMap();
 const messages = Object.freeze({
  idle:'접수번호를 확인한 뒤 조회 버튼을 눌러 주세요.',
  checking:'접수 여부를 확인하고 있습니다. 새 접수를 만들지 않습니다.',
  confirmed:'접수 사실이 확인되었습니다. 예약 확정이나 작업 완료를 뜻하지 않으며, 취소 여부도 별도로 확인해야 합니다.',
  unavailable:'접수 여부를 확인하지 못했습니다. 새로 접수하지 말고 잠시 후 다시 확인하거나 기존 상담 채널로 문의해 주세요.',
  invalid:'접수번호는 영문·숫자·밑줄·하이픈으로 된 1~80자여야 합니다. 이름이나 전화번호를 입력하지 마세요.'
 });
 function mountReceiptView({root, checkReceipt, timeoutMs = 12000} = {}) {
  if (!root?.querySelector || typeof checkReceipt !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new TypeError('Invalid receipt view configuration');
  if (mounts.has(root)) throw new Error('Receipt view already mounted');
  const form=root.querySelector('[data-receipt-form]'), input=root.querySelector('[data-receipt-id]');
  const submit=root.querySelector('[data-receipt-submit]'), clear=root.querySelector('[data-receipt-clear]'), status=root.querySelector('[data-receipt-status]');
  if (!form || !input || !submit || !clear || !status || !form.contains(input) || !form.contains(submit)) throw new TypeError('Incomplete receipt view');
  const win=root.ownerDocument.defaultView;
  let revision=0, active=null, disposed=false, state='idle';
  function render(next, focus=false) {
   state=next; root.dataset.state=next;
   const busy=next==='checking';
   form.setAttribute('aria-busy',String(busy));
   input.readOnly=busy; input.setAttribute('aria-invalid',String(next==='invalid'));
   submit.disabled=busy || disposed; clear.disabled=disposed;
   status.textContent=messages[next];
   if (focus) status.focus();
  }
  function reset({clearInput=true, focus=true} = {}) {
   if (disposed) return;
   revision++;
   if (active) { clearTimeout(active.timer); active.cancel('unavailable'); active=null; }
   if (clearInput) input.value='';
   render('idle');
   if (focus) input.focus();
  }
  async function onSubmit(event) {
   event.preventDefault();
   if (disposed || active) return;
   const id=input.value.trim();
   if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) { render('invalid'); input.focus(); return; }
   input.value=id;
   const ticket=++revision, operation={timer:null,cancel:null};
   const deadline=new Promise(resolve=>{operation.cancel=resolve; operation.timer=setTimeout(()=>resolve('unavailable'),timeoutMs);});
   active=operation; render('checking');
   let result='unavailable';
   try { result=await Promise.race([Promise.resolve().then(()=>disposed||revision!==ticket?'unavailable':checkReceipt(id)), deadline]); } catch {}
   finally { clearTimeout(operation.timer); }
   if (disposed || revision!==ticket) return;
   active=null;
   render(result==='confirmed'?'confirmed':'unavailable',true);
  }
  const onClear=()=>reset();
  const onInput=()=>reset({clearInput:false,focus:false});
  const onHide=()=>reset({focus:false});
  const onShow=event=>{if(event.persisted) reset({focus:false});};
  form.addEventListener('submit',onSubmit); clear.addEventListener('click',onClear);
  input.addEventListener('input',onInput); win.addEventListener('pagehide',onHide); win.addEventListener('pageshow',onShow);
  function destroy() {
   if (disposed) return;
   reset({focus:false}); disposed=true; render('idle');
   form.removeEventListener('submit',onSubmit); clear.removeEventListener('click',onClear);
   input.removeEventListener('input',onInput); win.removeEventListener('pagehide',onHide); win.removeEventListener('pageshow',onShow);
   mounts.delete(root);
  }
  const api=Object.freeze({reset,destroy,getState:()=>state});
  mounts.set(root,api); render('idle');
  return api;
 }
 const api=Object.freeze({mountReceiptView});
 if (typeof module==='object' && module.exports) module.exports=api;
 else global.OKCleanReceiptView=api;
})(globalThis);
