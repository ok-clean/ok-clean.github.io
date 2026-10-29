// Reservation API client. Enable only with an approved HTTPS endpoint and App Check site key.
import {initializeApp,getApps} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth,setPersistence,browserSessionPersistence,signInWithEmailAndPassword} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {initializeAppCheck,ReCaptchaV3Provider,getToken} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js';
let instance;
function endpoint(settings){
  const url=new URL(settings?.apiUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.run.app'))throw Error('예약 서버 설정을 확인해 주세요.');
  return url.origin;
}
async function setup(config,settings){
  const base=endpoint(settings);
  if(settings?.enabled!==true||typeof settings.appCheckSiteKey!=='string'||!settings.appCheckSiteKey.trim()||!config?.apiKey||!config?.projectId||!config?.appId)throw Error('예약 서비스가 준비되지 않았습니다.');
  if(instance){if(instance.base!==base)throw Error('예약 서버 설정을 확인해 주세요.');return instance;}
  const app=getApps().find(a=>a.name==='production-reservation')||initializeApp(config,'production-reservation');
  const auth=getAuth(app);await setPersistence(auth,browserSessionPersistence);await auth.authStateReady();
  const check=initializeAppCheck(app,{provider:new ReCaptchaV3Provider(settings.appCheckSiteKey),isTokenAutoRefreshEnabled:true});
  return instance={auth,check,base};
}
export async function ready(config,settings){const {auth}=await setup(config,settings);if(!auth.currentUser?.emailVerified)throw Error('인증이 필요합니다.');}
export async function login(config,email,password,settings){const {auth}=await setup(config,settings);await signInWithEmailAndPassword(auth,email,password);return !!auth.currentUser?.emailVerified;}
async function call(config,path,body,settings){
  const {auth,check,base}=await setup(config,settings);if(!auth.currentUser?.emailVerified)throw Error('인증이 필요합니다.');
  const [idToken,attestation]=await Promise.all([auth.currentUser.getIdToken(),getToken(check)]);
  const res=await fetch(base+'/reservation/'+path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken,'X-Firebase-AppCheck':attestation.token},body:JSON.stringify(body),cache:'no-store',credentials:'omit',redirect:'error'});
  let data;try{data=await res.json();}catch{throw Error('접수 여부를 확인하지 못했습니다.');}
  if(!res.ok||data?.status!=='confirmed')throw Error('접수 여부를 확인하지 못했습니다.');return data;
}
export async function submit(config,requestId,form,settings){return call(config,'submit',{requestId,form},settings);}
export async function recover(config,requestId,settings){return call(config,'status',{requestId},settings);}
