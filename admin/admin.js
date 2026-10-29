import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,onAuthStateChanged,signOut,connectAuthEmulator} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {getFirestore,collection,query,orderBy,limit,onSnapshot,doc,updateDoc,connectFirestoreEmulator} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
const $=id=>document.getElementById(id), esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const msg=s=>$('message').textContent=s;
let db,auth,unsub,reservationUnsub,records=[],session=0,viewVersion=0,currentUser=null,serverReady=false,productionAppCheck=null;
function clearReservations(){
 if(reservationUnsub){reservationUnsub();reservationUnsub=null;}
 $('reservationDashboard').hidden=true;$('reservationList').replaceChildren();$('reservationMessage').textContent='';
}
// 인증 세대가 바뀌거나 서버 확인이 불가능할 때 화면과 메모리를 즉시 비웁니다.
function clearMembers(){
 ++viewVersion;records=[];serverReady=false;$('dashboard').hidden=true;
 $('members').replaceChildren();$('stats').replaceChildren();$('search').value='';$('statusFilter').value='';
}
function resetSession(){
 ++session;currentUser=null;clearMembers();clearReservations();
 if(unsub){const stop=unsub;unsub=null;stop();}
 return session;
}
function validAuth(started,user){
 if(started!==session||currentUser!==user)return false;
 if(auth.currentUser===user)return true;
 resetSession();msg('인증 상태를 확인하는 중이에요.');return false;
}
function hasAccess(){return !!(serverReady&&currentUser&&validAuth(session,currentUser));}
function hasReservationClaim(claims){return claims?.reservation_admin===true || claims?.super_admin===true || claims?.admin===true;}
const settings=await fetch('../config.json',{cache:'no-store'}).then(r=>r.json()).catch(()=>null);
const config=settings?.firebase;
const localReservation=settings?.reservation?.emulator===true && ['localhost','127.0.0.1'].includes(location.hostname) && /^demo-[a-z0-9-]+$/.test(config?.projectId||'');
// An explicit, complete production configuration is mandatory. Never send an ID token to an arbitrary origin.
function reservationApiUrl(settings){
 try{
  const r=settings?.reservation;if(r?.enabled!==true||typeof r.appCheckSiteKey!=='string'||!r.appCheckSiteKey.trim()||typeof r.apiUrl!=='string')return null;
  const u=new URL(r.apiUrl);
  if(u.protocol!=='https:'||!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/i.test(u.hostname)||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash)return null;
  return u.origin;
 }catch(_){return null;}
}
const productionReservation=localReservation?null:reservationApiUrl(settings);
if(!config?.apiKey||!config?.projectId){msg('Firebase 연결 전입니다. 설치방법에 따라 config.json의 firebase 설정을 입력해 주세요.');$('loginBtn').disabled=true;}
else{
 const app=initializeApp(config);auth=getAuth(app);
 if(localReservation){
  connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 }
 db=getFirestore(app);
 if(localReservation)connectFirestoreEmulator(db,'127.0.0.1',8085);
 $('loginBtn').onclick=async()=>{const started=session;try{await signInWithPopup(auth,new GoogleAuthProvider())}catch(e){if(started!==session)return;if(e.code==='auth/popup-blocked'){try{await signInWithRedirect(auth,new GoogleAuthProvider())}catch(err){if(started===session)msg('로그인 실패: '+err.message)}}else msg('로그인 실패: '+e.message)}};
 $('logout').onclick=async()=>{const started=resetSession();msg('로그아웃 중…');try{await signOut(auth)}catch(e){if(started===session)msg('로그아웃하지 못했어요. 다시 시도해 주세요.')}};
 getRedirectResult(auth).catch(e=>{if(session<=1&&!currentUser&&!$('login').hidden)msg('로그인 실패: '+e.message)});
 onAuthStateChanged(auth,user=>{
  const started=resetSession();currentUser=user;
  $('login').hidden=!!user;$('logout').hidden=!user;
  if(!user){msg('');return;}
  if(localReservation) startReservationView(started,user);
  else if(productionReservation) startProductionReservationView(started,user,app);
  msg('서버에서 회원정보 접근을 확인하는 중…');
  let memberSubscriptionActive=true;
  const isCurrent=()=>memberSubscriptionActive&&validAuth(started,user);
  try{
   unsub=onSnapshot(query(collection(db,'member_requests'),orderBy('joined','desc'),limit(500)),{includeMetadataChanges:true},snapshot=>{
    if(!isCurrent())return;
    // 로컬 캐시는 권한 확인이 아닙니다.
    if(snapshot.metadata?.fromCache !== false){
     clearMembers();msg('서버 확인 전에는 회원정보를 표시하지 않아요. 연결을 확인해 주세요.');return;
    }
    // 이미 확인된 같은 세대에서는 기존 화면을 유지하되 미확정 값은 표시하지 않습니다.
    if(snapshot.metadata?.hasPendingWrites !== false){
     if(!serverReady){clearMembers();msg('서버에서 회원정보 접근을 확인하는 중…');}
     else msg('변경사항을 서버에서 확인하는 중…');
     return;
    }
    records=snapshot.docs.map(d=>({id:d.id,...d.data()}));serverReady=true;render();$('dashboard').hidden=false;
    msg('최근 500건까지 표시됩니다.');
   },e=>{if(!isCurrent())return;memberSubscriptionActive=false;const stop=unsub;unsub=null;if(stop)stop();clearMembers();msg('회원 목록에 접근할 수 없습니다. Firebase 회원 관리 권한과 보안 규칙을 확인해 주세요. ('+e.code+')');});
  }catch(e){if(isCurrent()){clearMembers();msg('회원 목록을 불러오지 못했어요. 연결과 권한을 확인해 주세요.');}}
 });
}
async function startReservationView(started,user){
 try{
  const token=await user.getIdTokenResult();
  if(!validAuth(started,user) || token.claims.admin!==true)return;
  reservationUnsub=onSnapshot(query(collection(db,'quote_requests'),orderBy('createdAt','desc'),limit(100)),{includeMetadataChanges:true},snapshot=>{
   if(!validAuth(started,user))return;
   if(snapshot.metadata?.fromCache!==false || snapshot.metadata?.hasPendingWrites!==false){$('reservationDashboard').hidden=true;$('reservationList').replaceChildren();return;}
   const list=$('reservationList');list.replaceChildren();
   for(const record of snapshot.docs){
    const data=record.data(), card=document.createElement('article'), title=document.createElement('h3'), detail=document.createElement('p');
    title.textContent=(data.service||'청소')+' · '+(data.status||'신규');
    detail.textContent=[data.name,data.phone,data.area,data.notes].filter(Boolean).join(' · ');
    const select=document.createElement('select');
    for(const value of ['신규','검토중','상담중','예약확정','작업완료','종료','취소']){
     const option=document.createElement('option');option.value=value;option.textContent=value;option.selected=value===data.status;select.append(option);
    }
    const save=document.createElement('button');save.type='button';save.textContent='상태 저장';
    save.onclick=async()=>{if(!validAuth(started,user))return;save.disabled=true;try{
     await updateDoc(doc(db,'quote_requests',record.id),{status:select.value});
     if(validAuth(started,user))$('reservationMessage').textContent='상태가 저장되었습니다.';
    }catch(_){if(validAuth(started,user))$('reservationMessage').textContent='상태를 저장하지 못했습니다.';}
    finally{if(save.isConnected)save.disabled=false;}};
    card.append(title,detail,select,save);list.append(card);
   }
   $('reservationDashboard').hidden=false;
  },()=>{if(validAuth(started,user)){clearReservations();$('reservationMessage').textContent='예약 권한을 확인할 수 없습니다.';}});
 }catch(_){if(validAuth(started,user))clearReservations();}
}

// The server is the authority for every list, history, and update request.
async function startProductionReservationView(started,user,app){
 let appCheck,getAppCheckToken;
 try{
  if(globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN)throw Error('App Check unavailable');
  const claim=await user.getIdTokenResult();if(!validAuth(started,user)||!hasReservationClaim(claim.claims))return;
  const sdk=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js');
  if(!validAuth(started,user))return;
  if(!productionAppCheck)productionAppCheck=sdk.initializeAppCheck(app,{provider:new sdk.ReCaptchaV3Provider(settings.reservation.appCheckSiteKey),isTokenAutoRefreshEnabled:true});
  appCheck=productionAppCheck;getAppCheckToken=sdk.getToken;
 }catch(_){if(validAuth(started,user))clearReservations();return;}
 async function call(endpoint,payload){
  if(!validAuth(started,user))throw Error('session ended');
  const [idToken,check]=await Promise.all([user.getIdToken(),getAppCheckToken(appCheck)]);
  if(!validAuth(started,user)||typeof idToken!=='string'||!idToken||typeof check?.token!=='string'||!check.token)throw Error('session ended');
  const response=await fetch(productionReservation+endpoint,{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken,'X-Firebase-AppCheck':check.token},body:JSON.stringify(payload)});
  if(!response.ok)throw Error('server rejected');const result=await response.json();
  if(result.status!=='ok'||!validAuth(started,user))throw Error('invalid response');return result;
 }
 const dashboard=$('reservationDashboard'),list=$('reservationList'),message=$('reservationMessage');
 async function refresh(){
  list.replaceChildren();dashboard.hidden=true;message.textContent='서버에서 예약을 확인하는 중입니다.';
  try{
   const result=await call('/admin/list',{});if(!Array.isArray(result.items))throw Error();
   const fragment=document.createDocumentFragment();
   for(const data of result.items){
    if(typeof data.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(data.id))continue;
    const card=document.createElement('article'),title=document.createElement('h3'),detail=document.createElement('p');
    title.textContent=(data.service||'청소')+' · '+(data.status||'신규');
    detail.textContent=[data.name,data.phone,data.area,data.notes].filter(Boolean).join(' · ');
    const select=document.createElement('select');
    for(const value of ['신규','검토중','상담중','예약확정','작업완료','종료','취소']){const option=document.createElement('option');option.value=value;option.textContent=value;option.selected=value===data.status;select.append(option);}
    const save=document.createElement('button');save.type='button';save.textContent='상태 저장';
    save.onclick=async()=>{save.disabled=true;try{await call('/admin/status',{requestId:data.id,status:select.value});await refresh();if(validAuth(started,user))message.textContent='상태가 저장되었습니다.';}catch(_){if(validAuth(started,user))message.textContent='상태를 저장하지 못했습니다.';}finally{if(save.isConnected)save.disabled=false;}};
    const historyButton=document.createElement('button'),history=document.createElement('div');historyButton.type='button';historyButton.textContent='처리 이력';
    historyButton.onclick=async()=>{historyButton.disabled=true;history.replaceChildren();try{const result=await call('/admin/history',{requestId:data.id});if(!Array.isArray(result.items))throw Error();for(const entry of result.items){const p=document.createElement('p');p.textContent=String(entry.from||'')+' → '+String(entry.to||'');history.append(p);}if(!result.items.length)history.textContent='처리 이력이 없습니다.';}catch(_){if(validAuth(started,user))history.textContent='이력을 확인하지 못했습니다.';}finally{if(historyButton.isConnected)historyButton.disabled=false;}};
    card.append(title,detail,select,save,historyButton,history);fragment.append(card);
   }
   if(!validAuth(started,user))return;list.append(fragment);dashboard.querySelector('h2').textContent='예약 관리';dashboard.querySelector('p').textContent='서버에서 확인한 최근 예약입니다.';dashboard.hidden=false;message.textContent='최근 50건까지 표시됩니다.';
  }catch(_){if(validAuth(started,user)){clearReservations();message.textContent='예약 목록을 확인할 수 없습니다.';}}
 }
 await refresh();
}
const option=(arr,value)=>arr.map(x=>`<option ${x===value?'selected':''}>${esc(x)}</option>`).join('');
function render(){
 const all=records;const search=$('search').value.trim().toLowerCase();const status=$('statusFilter').value;
 const list=all.filter(m=>(!status||m.status===status)&&(!search||[m.name,m.phone,m.area,m.code,m.free].some(v=>String(v||'').toLowerCase().includes(search))));
 const stats=[['전체 회원',all.length],['신규 문의',all.filter(m=>m.status==='신규').length],['미사용 쿠폰',all.filter(m=>m.couponStatus==='미사용').length],['무료서비스 대기',all.filter(m=>m.freeStatus==='미제공').length]];
 $('stats').innerHTML=stats.map(([k,v])=>`<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
 $('members').innerHTML=list.length?list.map(m=>`<details class="person" data-id="${esc(m.id)}"><summary><span><span class="name">${esc(m.name)}</span> · ${esc(m.area)}<br><small class="muted">${esc(m.phone)} · ${esc(m.code)}</small></span><span class="pill">${esc(m.status)}</span></summary><div class="fields">
 <label>상담 상태<select name="status">${option(['신규','상담중','예약확정','작업완료','종료'],m.status)}</select></label>
 <label>쿠폰 상태<select name="couponStatus">${option(['미사용','사용','취소'],m.couponStatus)}</select></label>
 <label>무료서비스 상태<select name="freeStatus">${option(['미제공','제공완료','취소'],m.freeStatus)}</select></label>
 <label>회원 등급<select name="grade">${option(['새싹','실버','골드','VIP'],m.grade)}</select></label>
 <label>포인트(관리자 확인 후 입력)<input name="points" type="number" min="0" max="10000000" value="${Number(m.points)||0}"></label>
 <label>이벤트 수신 동의<input value="${m.ad?'동의':'미동의'}" disabled></label>
 <label>선택 무료서비스<input value="${esc(m.free)}" disabled></label>
 <label>추천인 코드<input value="${esc(m.ref)}" disabled></label>
 <label class="wide">관리 메모<textarea name="memo" maxlength="1000" rows="3">${esc(m.memo)}</textarea></label>
 <button class="primary" data-save="${esc(m.id)}">변경사항 저장</button></div></details>`).join(''):'<p class="muted">표시할 회원이 없습니다.</p>';
}
$('search').oninput=()=>{if(hasAccess())render();};$('statusFilter').onchange=()=>{if(hasAccess())render();};
$('members').addEventListener('click',async e=>{
 const b=e.target.closest('[data-save]');if(!b||!hasAccess())return;const el=b.closest('details');const id=b.dataset.save;
 if(!el||!records.some(record=>record.id===id))return;
 const started=session, view=viewVersion, user=currentUser, v=k=>el.querySelector(`[name="${k}"]`).value;
 const isCurrent=()=>view===viewVersion&&serverReady&&validAuth(started,user);
 b.disabled=true;try{await updateDoc(doc(db,'member_requests',id),{status:v('status'),couponStatus:v('couponStatus'),freeStatus:v('freeStatus'),grade:v('grade'),points:Math.max(0,Math.min(10000000,Number(v('points'))||0)),memo:v('memo').slice(0,1000)});if(isCurrent())msg('저장되었습니다.')}catch(err){if(isCurrent())msg('저장 실패: '+err.message)}finally{if(isCurrent()&&b.isConnected)b.disabled=false}
});
