// 공개 회원가입용 최소 권한 클라이언트: 회원 목록을 읽을 권한은 없습니다.
import {initializeApp, getApps, getApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {getAuth, signInAnonymously} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {getFirestore, doc, setDoc, serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
export async function submitMember(config, m){
  const app=getApps().length?getApp():initializeApp(config);
  const auth=getAuth(app); if(!auth.currentUser) await signInAnonymously(auth);
  const db=getFirestore(app);
  // 쿠폰번호는 편의 식별자일 뿐, 할인 사용 승인 권한을 부여하지 않습니다.
  const id=crypto.randomUUID();
  await setDoc(doc(db,'member_requests',id),{
    name:String(m.name||'').slice(0,30),phone:String(m.phone||'').slice(0,20),
    area:String(m.area||'').slice(0,40),free:String(m.free||'').slice(0,80),
    ad:!!m.ad,code:String(m.code||'').slice(0,20),ref:String(m.ref||'').slice(0,20),
    joined:serverTimestamp(),status:'신규',couponStatus:'미사용',freeStatus:'미제공',
    memo:'',points:0,grade:'새싹',ownerUid:auth.currentUser.uid
  });
}
