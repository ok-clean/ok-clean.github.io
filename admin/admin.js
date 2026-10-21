import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth,GoogleAuthProvider,signInWithPopup,signInWithRedirect,getRedirectResult,onAuthStateChanged,signOut} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {getFirestore,collection,query,orderBy,limit,onSnapshot,doc,updateDoc} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
const $=id=>document.getElementById(id), esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const msg=s=>$('message').textContent=s;
let db,auth,unsub,records=[];
const config=await fetch('../config.json',{cache:'no-store'}).then(r=>r.json()).then(c=>c.firebase).catch(()=>null);
if(!config?.apiKey||!config?.projectId){msg('Firebase 연결 전입니다. 설치방법에 따라 config.json의 firebase 설정을 입력해 주세요.');$('loginBtn').disabled=true;}
else{
 const app=initializeApp(config);auth=getAuth(app);db=getFirestore(app);
 $('loginBtn').onclick=async()=>{try{await signInWithPopup(auth,new GoogleAuthProvider())}catch(e){if(e.code==='auth/popup-blocked')await signInWithRedirect(auth,new GoogleAuthProvider());else msg('로그인 실패: '+e.message)}};
 $('logout').onclick=()=>signOut(auth);
 getRedirectResult(auth).catch(e=>msg('로그인 실패: '+e.message));
 onAuthStateChanged(auth,user=>{
  if(unsub){unsub();unsub=null;} $('login').hidden=!!user;$('dashboard').hidden=!user;$('logout').hidden=!user;
  if(!user){records=[];msg('');return;} msg('회원정보를 불러오는 중…');
  unsub=onSnapshot(query(collection(db,'member_requests'),orderBy('joined','desc'),limit(500)),snapshot=>{
    records=snapshot.docs.map(d=>({id:d.id,...d.data()}));msg('최근 500건까지 표시됩니다.');render();
  },e=>{records=[];$('dashboard').hidden=true;msg('회원 목록에 접근할 수 없습니다. Firebase 관리자 UID 등록과 보안 규칙을 확인해 주세요. ('+e.code+')');});
 });
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
$('search').oninput=render;$('statusFilter').onchange=render;
$('members').addEventListener('click',async e=>{
 const b=e.target.closest('[data-save]');if(!b)return;const el=b.closest('details');const id=b.dataset.save;const v=k=>el.querySelector(`[name="${k}"]`).value;
 b.disabled=true;try{await updateDoc(doc(db,'member_requests',id),{status:v('status'),couponStatus:v('couponStatus'),freeStatus:v('freeStatus'),grade:v('grade'),points:Math.max(0,Math.min(10000000,Number(v('points'))||0)),memo:v('memo').slice(0,1000)});msg('저장되었습니다.')}catch(err){msg('저장 실패: '+err.message)}finally{b.disabled=false}
});
