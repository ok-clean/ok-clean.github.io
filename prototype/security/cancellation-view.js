'use strict';
// Read-only presentation. The injected lookup is a local fake in the committed demo.
(function(global) {
 const mounts=new WeakMap();
 const messages=Object.freeze({
  idle:'상황을 선택한 뒤 가상 상태 확인 버튼을 눌러 주세요.',
  checking:'가상 상태를 확인하고 있습니다. 실제 요청에는 영향을 주지 않습니다.',
  processing:'가상 요청은 조회 시점에 처리 중입니다. 지연된 취소가 나중에 완료될 수 있어 취소 성공이나 실패를 뜻하지 않습니다. 실제 요청 상태는 알 수 없습니다.',
  cancelled:'가상 요청이 취소된 상태입니다. 실제 요청의 취소 여부는 이 화면으로 알 수 없습니다.',
  booked:'가상 요청은 예약 확정 상태입니다. 예약 후 취소는 이 연습 화면에서 처리하지 않습니다. 실제 요청 상태는 알 수 없습니다.',
  completed:'가상 작업이 완료된 상태입니다. 실제 작업 완료 여부는 이 화면으로 알 수 없습니다.',
  closed:'가상 요청은 종료된 상태입니다. 종료가 취소와 같다는 뜻은 아닙니다. 실제 요청 상태는 알 수 없습니다.',
  unavailable:'가상 상태를 확인하지 못했습니다. 실제 취소 여부를 알 수 없으니 기존 상담 채널에서 확인해 주세요.'
 });
 const results=new Set(['processing','cancelled','booked','completed','closed']);
 function mount({root,loadState,timeoutMs=12000}={}) {
  if (!root?.querySelector || typeof loadState!=='function' || !Number.isSafeInteger(timeoutMs) || timeoutMs<10 || timeoutMs>30000) throw TypeError('Invalid status view configuration');
  if (mounts.has(root)) throw Error('Status view already mounted');
  const check=root.querySelector('[data-status-check]'),clear=root.querySelector('[data-status-clear]'),status=root.querySelector('[data-status-message]');
  if (!check || !clear || !status) throw TypeError('Incomplete status view');
  const win=root.ownerDocument.defaultView;
  let revision=0,active=null,disposed=false,state='idle';
  function render(next,focus=false) {
   state=next;root.dataset.state=next;root.setAttribute('aria-busy',String(next==='checking'));
   check.disabled=disposed || next==='checking';clear.disabled=disposed;
   status.textContent=messages[next];
   if (focus) status.focus();
  }
  function reset({focus=true}={}) {
   if (disposed) return;
   revision++;
   if (active) { clearTimeout(active.timer);active.controller.abort();active.cancel('unavailable');active=null; }
   render('idle');if (focus) check.focus();
  }
  async function onCheck() {
   if (disposed || active) return;
   const ticket=++revision,operation={timer:null,cancel:null,controller:new AbortController()};
   const deadline=new Promise(resolve=>{operation.cancel=resolve;operation.timer=setTimeout(()=>{operation.controller.abort();resolve('unavailable');},timeoutMs);});
   active=operation;render('checking');let result='unavailable';
   try {result=await Promise.race([Promise.resolve().then(()=>disposed || revision!==ticket?'unavailable':loadState({signal:operation.controller.signal})),deadline]);} catch {}
   finally {clearTimeout(operation.timer);operation.controller.abort();}
   if (disposed || revision!==ticket) return;
   active=null;render(results.has(result)?result:'unavailable',true);
  }
  const onClear=()=>reset(),onHide=()=>reset({focus:false}),onShow=e=>{if(e.persisted)reset({focus:false});};
  check.addEventListener('click',onCheck);clear.addEventListener('click',onClear);
  win.addEventListener('pagehide',onHide);win.addEventListener('pageshow',onShow);
  function destroy() {
   if (disposed) return;
   reset({focus:false});disposed=true;render('idle');
   check.removeEventListener('click',onCheck);clear.removeEventListener('click',onClear);
   win.removeEventListener('pagehide',onHide);win.removeEventListener('pageshow',onShow);mounts.delete(root);
  }
  const api=Object.freeze({reset,destroy,getState:()=>state});mounts.set(root,api);render('idle');return api;
 }
 const api=Object.freeze({mount});
 if (typeof module==='object' && module.exports) module.exports=api;else global.OKCleanCancellationView=api;
})(globalThis);
