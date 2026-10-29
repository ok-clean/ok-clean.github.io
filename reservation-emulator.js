// Local integration only. This module refuses real Firebase projects and hosts.
import {initializeApp, getApps} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth, setPersistence, inMemoryPersistence, connectAuthEmulator, signInAnonymously} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {getFirestore, connectFirestoreEmulator, doc, setDoc, serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

let client;
function localOnly(config){
  if(!['localhost','127.0.0.1'].includes(location.hostname) || !/^demo-[a-z0-9-]+$/.test(config?.projectId || ''))
    throw new Error('시험 환경이 아닙니다.');
}
async function setup(config){
  localOnly(config);
  if(client) return client;
  const app=getApps().find(a=>a.name==='reservation-emulator') || initializeApp(config,'reservation-emulator');
  const auth=getAuth(app);
  connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
  await setPersistence(auth,inMemoryPersistence);
  await auth.authStateReady();
  if(!auth.currentUser) await signInAnonymously(auth);
  if(!auth.currentUser?.isAnonymous) throw new Error('시험 인증 상태를 확인해 주세요.');
  const db=getFirestore(app);
  connectFirestoreEmulator(db,'127.0.0.1',8085);
  client={auth,db};
  return client;
}
export async function submitReservation(config,id,form){
  localOnly(config);
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('접수번호 오류');
  const {auth,db}=await setup(config);
  const date=new Date(form.date+'T14:59:59.999Z');
  if(!Number.isFinite(date.getTime())) throw new Error('날짜 오류');
  const data={service:form.service,area:form.area,size:form.size,date,name:form.name,phone:form.phone,
    notes:form.notes,consentVersion:'test-v1',consentAt:serverTimestamp(),createdAt:serverTimestamp(),
    ownerUid:auth.currentUser.uid,status:'신규'};
  if(form.estimateMin != null) data.estimateMin=form.estimateMin;
  if(form.estimateMax != null) data.estimateMax=form.estimateMax;
  await setDoc(doc(db,'quote_requests',id),data);
  return id;
}
