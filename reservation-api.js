// Reservation API client. Enable only with an approved HTTPS endpoint and App Check site key.
import {initializeApp,getApps} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth,setPersistence,browserSessionPersistence,signInWithEmailAndPassword,signOut,onAuthStateChanged,reauthenticateWithCredential,EmailAuthProvider} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {initializeAppCheck,ReCaptchaV3Provider,getToken} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js';
let instance;
function endpoint(settings){
  const url=new URL(settings?.apiUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.run.app'))throw Error('예약 서버 설정을 확인해 주세요.');
  return url.origin;
}
async function setup(config,settings){
  const base=endpoint(settings);
  if(globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN)throw Error('예약 서비스가 준비되지 않았습니다.');
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
  const current=auth.currentUser, uid=current.uid;
  if(typeof uid!=='string'||!uid)throw Error('인증이 필요합니다.');
  const [idToken,attestation]=await Promise.all([current.getIdToken(),getToken(check)]);
  if(auth.currentUser!==current || auth.currentUser?.uid!==uid)throw Error('인증이 변경되었습니다.');
  if(typeof idToken!=='string'||!idToken||typeof attestation?.token!=='string'||!attestation.token)throw Error('접수 여부를 확인하지 못했습니다.');
  const res=await fetch(base+'/reservation/'+path,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken,'X-Firebase-AppCheck':attestation.token},body:JSON.stringify(body),cache:'no-store',credentials:'omit',redirect:'error'});
  let data;try{data=await res.json();}catch{throw Error('접수 여부를 확인하지 못했습니다.');}
  if(auth.currentUser!==current||auth.currentUser?.uid!==uid||!res.ok||data?.status!==((path==='list'||path==='account-status')?'ok':path==='withdraw'?'pending':path==='link-member'?'linked':'confirmed'))throw Error('접수 여부를 확인하지 못했습니다.');return data;
}
export async function submit(config,requestId,form,settings){return call(config,'submit',{requestId,form},settings);}
export async function recover(config,requestId,settings){return call(config,'status',{requestId},settings);}

export async function accountStatus(config,settings){return call(config,'account-status',{},settings);}
export async function listOwn(config,settings){return call(config,'list',{},settings);}
export async function watchUser(config,settings,onChange){const {auth}=await setup(config,settings);return onAuthStateChanged(auth,onChange);}

// Explicit opt-in only; caller supplies a same-page member request id obtained
// after confirmed Firestore creation. No token or member id is persisted here.
export async function linkMember(config,memberId,consent,settings){
 if(settings?.memberLinkEnabled!==true||settings?.memberLinkPolicyReviewed!==true||typeof settings.memberLinkPolicyVersion!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(settings.memberLinkPolicyVersion)||consent!==true||typeof memberId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(memberId))throw Error('회원 연결을 확인해 주세요.');
 const {getMemberLinkToken}=await import('./member-sync.js');
 const memberIdToken=await getMemberLinkToken(config);
 return call(config,'link-member',{memberId,memberIdToken,consent:true,policyVersion:settings.memberLinkPolicyVersion},settings);
}

// A fresh sign-in is required; this queues a request and never deletes the Auth account.
export async function requestWithdrawal(config,password,settings){
 const {auth}=await setup(config,settings);const current=auth.currentUser;
 if(settings?.withdrawalEnabled!==true||settings?.withdrawalPolicyReviewed!==true||!current?.emailVerified||typeof current.email!=='string'||typeof password!=='string'||!password)throw Error('재인증이 필요합니다.');
 await reauthenticateWithCredential(current,EmailAuthProvider.credential(current.email,password));
 if(auth.currentUser!==current)throw Error('인증이 변경되었습니다.');
 await current.getIdToken(true);const result=await call(config,'withdraw',{},settings);
 // Preserve the accepted request result even if browser sign-out fails.
 try{await signOut(auth);return {...result,signedOut:true};}catch{return {...result,signedOut:false};}
}
