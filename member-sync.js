// A receipt exposes only submission metadata; customer data and admin notes stay private.
import {initializeApp, getApps, getApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth, signInAnonymously} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {getFirestore, doc, writeBatch, getDocFromServer, serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
const inflight = new Map();
let authPending = null;
function deadline(promise, ms=10000){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('인증 확인 지연'),{code:'auth/restore-timeout'})),ms);})]).finally(()=>clearTimeout(timer));
}
export async function submitMember(config, m){
  const app=getApps().some(a=>a.name==='[DEFAULT]')?getApp():initializeApp(config);
  if(app.options.projectId!==config.projectId) throw new Error('Firebase project mismatch');
  const auth=getAuth(app);
  if(!authPending){
    const operation=(async()=>{
      await deadline(auth.authStateReady());
      if(!auth.currentUser) await signInAnonymously(auth);
    })();
    authPending=operation;
    operation.then(()=>{if(authPending===operation)authPending=null},()=>{if(authPending===operation)authPending=null});
  }
  await authPending;
  const uid=auth.currentUser.uid;
  if(inflight.has(uid)) return inflight.get(uid);
  const work=(async()=>{
    const db=getFirestore(app), receiptRef=doc(db,'member_receipts',uid);
    const read=async()=>{
      const s=await getDocFromServer(receiptRef);
      if(!s.exists())return null;
      const d=s.data();
      if(d.ownerUid!==uid || d.requestId!==uid || !/^OK-[A-Z2-9]{6}$/.test(d.code))throw new Error('Invalid receipt');
      return {requestId:d.requestId,code:d.code,existing:true};
    };
    const previous=await read(); if(previous)return previous;
    if(auth.currentUser?.uid!==uid)throw Object.assign(new Error('인증 변경'),{code:'auth/user-changed'});
    const data={name:m.name,phone:m.phone,area:m.area,free:m.free,ad:m.ad,code:m.code,ref:m.ref,
      joined:serverTimestamp(),status:'신규',couponStatus:'미사용',freeStatus:'미제공',memo:'',points:0,grade:'새싹',ownerUid:uid};
    const batch=writeBatch(db);
    batch.set(doc(db,'member_requests',uid),data);
    batch.set(receiptRef,{ownerUid:uid,requestId:uid,code:m.code,joined:serverTimestamp()});
    try {await batch.commit();} catch(error){
      // A racing tab or a lost acknowledgement may already have committed.
      try{const committed=await read();if(committed)return committed;}catch{}
      throw error;
    }
    return {requestId:uid,code:m.code};
  })();
  inflight.set(uid,work);
  try{return await work;}finally{inflight.delete(uid);}
}
