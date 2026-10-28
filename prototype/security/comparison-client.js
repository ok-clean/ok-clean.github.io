'use strict';
// Read-only comparison client; no token persistence, credentials, write or automatic retry.
(function(root){
 function createComparisonClient({endpoint,getIdToken,getRequestId,fetchImpl=globalThis.fetch,timeoutMs=10000}={}){
  let url;try{url=new URL(endpoint);}catch{throw TypeError('Invalid comparison endpoint');}
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/api/offer-comparison' ||
     typeof getIdToken!=='function' || typeof getRequestId!=='function' || typeof fetchImpl!=='function' ||
     !Number.isSafeInteger(timeoutMs) || timeoutMs<10 || timeoutMs>30000)throw TypeError('Invalid comparison client configuration');
  return async function loadOffers(){
   const controller=new AbortController();let timer;
   const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},timeoutMs);});
   const task=(async()=>{
    const requestId=await getRequestId();
    if(controller.signal.aborted || typeof requestId!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId))return null;
    const token=await getIdToken();
    if(controller.signal.aborted || typeof token!=='string' || !/^[A-Za-z0-9._~-]{1,4096}$/.test(token))return null;
    const response=await fetchImpl(url.href,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
     body:JSON.stringify({requestId}),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
    if(controller.signal.aborted || response.status!==200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'') || !response.body){
     await response.body?.cancel();return null;
    }
    const stream=response.body.getReader();const chunks=[];let size=0;
    try{
     for(;;){const part=await stream.read();if(controller.signal.aborted)return null;if(part.done)break;size+=part.value.byteLength;if(size>2048)return null;chunks.push(part.value);}
     const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
     const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
     if(!data || Array.isArray(data) || typeof data!=='object' || Object.keys(data).sort().join(',')!=='offers,status' || data.status!=='ok' ||
        !Array.isArray(data.offers) || data.offers.length>3)return null;
     for(const offer of data.offers){
      if(!offer || Array.isArray(offer) || typeof offer!=='object' || Object.keys(offer).sort().join(',')!=='company,price' ||
         typeof offer.company!=='string' || !offer.company.trim() || offer.company.length>60 ||
         !Number.isSafeInteger(offer.price) || offer.price<1 || offer.price>100000000)return null;
     }
     return data.offers.map(o=>({company:o.company.trim(),price:o.price}));
    }finally{await stream.cancel().catch(()=>{});stream.releaseLock();}
   })();
   try{const result=await Promise.race([task,deadline]);if(!result)throw Error('unavailable');return result;}
   catch{throw Error('비교 결과를 불러오지 못했습니다.');}
   finally{clearTimeout(timer);controller.abort();}
  };
 }
 const api=Object.freeze({createComparisonClient});
 if(typeof module==='object' && module.exports)module.exports=api;else root.OKCleanComparisonClient=api;
})(globalThis);
