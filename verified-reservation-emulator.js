// Local emulator integration only; never connect to a production backend.
import {initializeApp,getApps} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth,connectAuthEmulator,setPersistence,browserSessionPersistence,signInWithEmailAndPassword} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
let client;
async function setup(config){
  if(!['localhost','127.0.0.1'].includes(location.hostname)||!/^demo-[a-z0-9-]+$/.test(config?.projectId||''))throw Error('시험 환경이 아닙니다.');
  if(client)return client;
  const app=getApps().find(a=>a.name==='verified-reservation-emulator')||initializeApp(config,'verified-reservation-emulator');
  const auth=getAuth(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
  await setPersistence(auth,browserSessionPersistence);await auth.authStateReady();
  return client=auth;
}
export async function login(config,email,password){const auth=await setup(config);await signInWithEmailAndPassword(auth,email,password);return !!auth.currentUser?.emailVerified;}
async function call(config,path,body){
  const auth=await setup(config);if(!auth.currentUser || !auth.currentUser.emailVerified)throw Error('인증이 필요합니다.');
  const token=await auth.currentUser.getIdToken();
  const response=await fetch('/emulator/reservation/'+path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(body),cache:'no-store'});
  const data=await response.json();if(!response.ok || data.status!=='confirmed')throw Error('확인할 수 없습니다.');return data;
}
export async function submit(config,requestId,form){return call(config,'submit',{requestId,form});}
export async function recover(config,requestId){return call(config,'status',{requestId});}
