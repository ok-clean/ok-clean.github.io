'use strict';
// Read-only DOM rendering. No token handling, storage, payment, or booking API.
(function(global){
 const mounts=new WeakMap();
 const messages=Object.freeze({
  idle:'가상 견적 보기 버튼을 눌러 주세요.',
  loading:'가상 견적을 확인하고 있습니다.',
  ready:'가상 견적이 도착했습니다. 표시된 금액과 조건은 연습용입니다.',
  empty:'아직 도착한 가상 견적이 없습니다.',
  unavailable:'견적을 확인하지 못했습니다. 이 연습 화면에서는 실제 요청 상태를 알 수 없습니다.'
 });
 function mount({root,loadOffers,timeoutMs=12000}={}){
  if(!root?.querySelector || typeof loadOffers!=='function' || !Number.isSafeInteger(timeoutMs) || timeoutMs<10 || timeoutMs>30000) throw TypeError('Invalid comparison configuration');
  if(mounts.has(root)) throw Error('Comparison already mounted');
  const load=root.querySelector('[data-comparison-load]'), clear=root.querySelector('[data-comparison-clear]');
  const status=root.querySelector('[data-comparison-status]'), list=root.querySelector('[data-comparison-list]');
  if(!load || !clear || !status || !list) throw TypeError('Incomplete comparison view');
  const doc=root.ownerDocument, win=doc.defaultView;
  let revision=0, active=null, disposed=false, state='idle';
  function render(next,entries=[],focus=false){
   state=next;root.dataset.state=next;root.setAttribute('aria-busy',String(next==='loading'));
   load.disabled=disposed || next==='loading';clear.disabled=disposed;
   status.textContent=messages[next];list.replaceChildren();list.hidden=next!=='ready';
   if(next==='ready') for(const entry of entries){
    const item=doc.createElement('li'), name=doc.createElement('h3'), label=doc.createElement('p'), price=doc.createElement('strong');
    item.className='offer';name.textContent=entry.company;label.textContent='가상 견적 금액';price.textContent=entry.price.toLocaleString('ko-KR')+'원';
    item.append(name,label,price);list.append(item);
   }
   if(focus)status.focus();
  }
  function reset({focus=true}={}){
   if(disposed)return;revision++;
   if(active){clearTimeout(active.timer);active.cancel(null);active=null;}
   render('idle');if(focus)load.focus();
  }
  async function onLoad(){
   if(disposed || active)return;
   const ticket=++revision,operation={timer:null,cancel:null};
   const deadline=new Promise(resolve=>{operation.cancel=resolve;operation.timer=setTimeout(()=>resolve(null),timeoutMs);});
   active=operation;render('loading');let entries=null;
   try{entries=await Promise.race([Promise.resolve().then(()=>disposed||revision!==ticket?null:loadOffers()),deadline]);}catch{}
   finally{clearTimeout(operation.timer);}
   if(disposed || revision!==ticket)return;
   active=null;
   if(!Array.isArray(entries) || entries.length>3 || entries.some(e=>typeof e?.company!=='string' || !e.company.trim() || e.company.length>60 || !Number.isSafeInteger(e.price) || e.price<1 || e.price>100000000))return render('unavailable',[],true);
   render(entries.length?'ready':'empty',entries.map(e=>({company:e.company.trim(),price:e.price})),true);
  }
  const onClear=()=>reset(),onHide=()=>reset({focus:false}),onShow=e=>{if(e.persisted)reset({focus:false});};
  load.addEventListener('click',onLoad);clear.addEventListener('click',onClear);
  win.addEventListener('pagehide',onHide);win.addEventListener('pageshow',onShow);
  function destroy(){
   if(disposed)return;reset({focus:false});disposed=true;render('idle');
   load.removeEventListener('click',onLoad);clear.removeEventListener('click',onClear);
   win.removeEventListener('pagehide',onHide);win.removeEventListener('pageshow',onShow);mounts.delete(root);
  }
  const api=Object.freeze({reset,destroy,getState:()=>state});mounts.set(root,api);render('idle');return api;
 }
 const api=Object.freeze({mount});
 if(typeof module==='object' && module.exports)module.exports=api;else global.OKCleanComparisonView=api;
})(globalThis);
