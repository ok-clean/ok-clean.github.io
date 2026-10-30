// 공개 회원가입용 최소 권한 클라이언트: 회원 목록을 읽을 권한은 없습니다.
// Firebase imports remain disabled along with the preserved implementation.
// Reactivation requires a privacy/security review before restoring imports.
// import {initializeApp, getApps, getApp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
// import {getAuth, signInAnonymously} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
// import {getFirestore, doc, setDoc, serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
export async function submitMember(config, m){
  // Until privacy and access controls are verified, even direct callers fail
  // before authentication, network requests, or reading submitted data.
  throw new Error('MEMBER_SIGNUP_PAUSED');
  /* Retained implementation for a future reviewed reactivation:
  const app=getApps().length?getApp():initializeApp(config);
  const auth=getAuth(app);
  // 처음에는 저장된 로그인 상태가 아직 복원 중일 수 있습니다.
  // 복원이 끝나지 않으면 호출자가 카카오톡 확인을 안내하도록 중단합니다.
  let readyTimer;
  try {
    await Promise.race([
      auth.authStateReady(),
      new Promise((_,reject)=>{ readyTimer=setTimeout(()=>reject(new Error('회원 인증 준비 시간 초과')),10000); })
    ]);
  } finally { clearTimeout(readyTimer); }
  if(!auth.currentUser) await signInAnonymously(auth);
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
  // Only a newly written document may be considered for account linking.
  // The caller keeps this identifier in memory, not in public browser storage.
  return {memberId:id};
  */
}

