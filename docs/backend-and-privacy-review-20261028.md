# 오케이청소 백엔드·개인정보 검토

검토일: 2026-10-28. 이 문서는 공개 저장소에 올라갈 수 있는 설계 초안이다. 실제 고객 정보, 인증 비밀, 프로젝트의 접속 정보는 넣지 않는다. 요금과 제한은 변경될 수 있어 신청 직전에 다시 확인한다.

## 현재 확인한 사실과 확인하지 못한 사항

- 운영 저장소의 `app.js`는 회원가입 시 이름, 연락처, 지역, 쿠폰번호 등을 이 브라우저의 `localStorage`에 저장한다. Firebase 설정이 있으면 `member-sync.js`를 불러와 익명 인증 후 회원 요청을 보내고, 카카오톡으로 가입 확인을 안내한다. 이 동작은 견적 매칭 시제품과 별개다.
- 저장소의 Firebase 설정에는 프로젝트 식별을 위한 웹 앱 설정이 있지만 여기에는 값을 옮기지 않는다. Firebase는 해당 설정의 공개 여부와 별개로 데이터 접근을 보안 규칙과 인증으로 통제한다. 서비스 계정 키나 관리자 비밀은 브라우저와 저장소에 두지 않는다.
- 저장소의 `firestore.rules`에는 관리자 UID 자리표시자가 있다. 이 파일이 현재 운영 Firebase에 그대로 배포되어 있는지, 실제 관리자 계정·인증 설정·백업·요금제·보관 위치가 무엇인지는 확인하지 못했다. 이 파일만 보고 운영 데이터의 안전성이나 접수 성공 여부를 단정하지 않는다.
- 가입 완료 화면은 기존과 같이 로컬 쿠폰을 표시한다. 이 PR의 선택 버튼은 현재 탭과 이 브라우저의 `member` 저장 항목만 지운다. 관리자 접수 기록, 진행 중인 전송, 다른 탭의 메모리, 카카오톡 대화, 브라우저 자동완성이나 백업은 지우지 않는다. 다른 탭을 닫도록 안내하며 서버 기록 삭제는 별도 상담이 필요하다.
- 기존 개인정보처리방침의 가입 전송 설명은 Firebase 접수 시도를 빠뜨리고 있었다. 이 PR은 실제 연동 설정에 따라 Firebase·Apps Script 전송 시도와 기기 삭제의 한계를 안내한다. 저장 성공이나 실제 위탁·국외 이전을 코드만으로 확정하지 않는다.
- 기존 방침에는 마지막 이용 후 2년 또는 탈퇴 요청 시 파기한다는 문구가 있다. 실제 보관 기간, 처리위탁·국외 이전, 백업·카카오톡 기록의 파기 및 요청 처리 절차는 확인하지 못했으며 이 PR이 구현한 기능도 아니다. 운영 반영 전 실제 절차와 방침이 맞는지 소유자가 확인해야 한다.
- 현재 Pages workflow는 저장소 루트를 배포한다. PR #8은 시제품을 배포물에서 제외하는 제안이지만, 공개 저장소의 브랜치나 파일 자체를 비공개로 만들지는 않는다. GitHub Pages는 정적 파일을 제공하므로 서버 함수는 별도 실행 환경이 필요하다.
- PR #21의 비교 화면과 서버 통신은 가짜 계정과 에뮬레이터를 사용한 시험이다. 운영 인증·서버·DB에 연결되거나 사진 업로드가 구현된 상태가 아니다.

## 후보와 비용·운영 조건

| 항목 | Firebase 검토안 | Supabase Free 검토안 |
| --- | --- | --- |
| 데이터베이스 | Firestore 무료 할당: 프로젝트당 무료 DB 하나, 저장 1 GiB, 읽기 5만·쓰기 2만·삭제 2만 건/일, 전송 10 GiB/월. 보안 규칙의 추가 문서 읽기와 색인 등도 사용량에 영향을 준다. | 무료 DB 500 MB/프로젝트. 무료 프로젝트 수와 사용량은 계정·조직 단위 제한을 확인해야 한다. |
| 사진 | Firebase Storage 사용에는 Blaze 종량제 요금제 연결이 필요하다. 무료 사용량이 있더라도 초과분 및 위치별 요금 가능성이 있다. | 저장 1 GB/조직. 비공개 버킷과 RLS 설계가 가능하지만 자동으로 안전해지는 것은 아니다. |
| 서버 | Firebase Cloud Functions를 배포하려면 Blaze가 필요하다. 현재 비교 시험 코드가 운영 가능해지려면 검증된 신뢰 서버와 제한 정책이 별도로 필요하다. | Edge Functions 무료 호출량이 있으나 실제 인증·DB·파일 권한을 별도 설계하고 검증해야 한다. 기존 Firebase 시제품을 그대로 옮겨 쓸 수는 없다. |
| 이메일·운영 | 인증 방식별 제한을 별도로 확인한다. 이메일 링크 로그인은 Spark에서 하루 5개 제한이며, SMS 인증 발송은 Blaze 전용이다. | 기본 이메일 발송은 팀의 사전 승인 주소만 대상으로 시간당 2개이며 운영용이 아니다. 일반 고객에게 이메일 인증을 쓰려면 별도의 SMTP 등이 필요하며 비용·운영 검토가 필요하다. |
| 복구·가용성 | Firestore TTL 삭제, 관리형 백업·복원은 무료 할당이 없다. 실제 요금제와 복구 계획을 확인한다. | 무료 프로젝트는 활동이 부족하면 약 1주 뒤 일시 중지될 수 있고, 무료 DB의 다운로드 가능한 자동 백업은 제공되지 않는다. 초과 사용이 계속되면 서비스가 제한될 수 있다. |

Supabase 무료 사용량은 조직 단위로 합산되는 항목이 있다. 나가는 전송은 무료 기준 캐시 5 GB와 비캐시 5 GB로 구분되며 DB·함수·파일 전송이 함께 영향을 준다. 무료 할당은 비용과 정상 가동을 보장하는 약정이 아니다.

### 사진 용량 예시 — 운영 결정이 아닌 가정

한 달 100건, 건당 3장, 장당 2 MB, 사진 30일 보관, 균일한 접수, 복사본·썸네일 없음이라고 가정하면 원본만 약 600 MB다. 같은 사진을 평균 2회 내려받으면 약 1,200 MB가 추가 전송된다. 실제 사진 크기·보관 기간·백업·DB 및 다른 프로젝트 사용량에 따라 달라진다. 30일은 계산을 위한 숫자이며 확정된 보관 기간이 아니다. 비용을 0원으로 보장하거나 실사용량을 예측한 것이 아니다.

## 권장 순서

1. 기존 홈페이지와 회원 혜택을 유지하면서 운영 Firebase의 요금제, 현재 배포된 규칙, 관리자 접근, 기존 데이터와 백업을 소유자가 확인한다. 실제 운영 값을 이 공개 문서에 기록하지 않는다.
2. 초기 수동 매칭은 사진을 카카오톡으로 받는 현재 방식도 고려한다. Firestore 시제품은 별도 에뮬레이터에서 계속 검증하고 운영 데이터와 규칙을 덮어쓰지 않는다. 사진의 카카오톡 보관·삭제 방식도 실제 운영 절차에 포함해야 한다.
3. 고객 본인 확인 및 비교 결과는 인증 방식과 요청 소유권 이전 방식을 먼저 확정한다. 익명 UID가 다른 기기·다른 계정의 사용자와 같다고 가정하지 않는다. 현재 비교 시제품에 필요한 서버 실행 환경은 선택 전이며 Pages 단독으로 제공되지 않는다.
4. 사이트 사진 업로드를 열기 전 비공개 저장, 인증·권한, 파일 검증, 보관·삭제, 스팸 방지와 비용을 시험한다. 무료 요금제의 한계와 운영 중단 대응도 확인한다.
5. 사용자 승인 없이 유료 요금제·결제수단을 연결하거나 실제 운영 환경에 배포하지 않는다.

## 운영 보안·개인정보 출시 조건

- 고객은 본인 요청과 허용된 비교 결과만, 승인된 업체는 관리자가 배정한 업무의 최소 정보만, 관리자는 명시적으로 승인된 계정만 접근한다. 이름·전화·상세 주소와 업체 견적은 필요 목적과 단계에 맞게 분리한다. 접근 회수 후 이미 전달·복사된 정보는 회수할 수 없다.
- 실제 인증 토큰은 서버에서 발급자·대상·유효성 및 필요 시 폐기 여부를 확인한다. Firebase Admin SDK는 Firestore 규칙을 우회하므로 서버의 소유권·업체 승인·상태 검증과 최소 IAM 권한이 별도로 필요하다. 관리자 계정은 MFA, 권한 변경 기록과 접근 회수 절차가 필요하다.
- 익명 인증만으로 본인 확인이나 스팸 방지를 충족했다고 보지 않는다. 요청 제한, 중복 방지, 악용 탐지, 오탐 복구와 감사로그를 서버·운영 절차에서 설계한다. 로그에는 이름·연락처·토큰·사진 URL을 남기지 않는다.
- 사진은 비공개 저장을 기본으로 하며 수량·바이트·이미지 해상도 제한, 파일 내용 검증, 안전한 재인코딩과 메타데이터 처리, 악성 파일 대응, 접근 범위와 삭제를 시험한다. 서명 URL은 보유자가 만료 전 접근할 수 있으므로 최소 유효기간, 로그·공유 차단과 권한 회수 지연을 고려한다.
- 수집·이용 목적, 업체 제공 또는 처리위탁, 저장 지역과 국외 이전 해당 여부, 동의 문구, 보유 기간, 요청·사진·로그·백업의 삭제 및 권리 행사 절차를 실제 운영 방식에 맞춰 정한다. 자동 삭제나 복구를 구현하기 전에는 이미 제공되는 기능으로 안내하지 않는다.
- 실사용 전에는 테스트 고객과 테스트 업체로 접근 거부·계정 변경·삭제·접수 실패·가용성·실기기 화면을 확인한다. 운영 Firebase 변경, Pages 배포, 유료 신청은 별도 승인을 받는다.

## 공식 근거

- Firestore 무료 할당 및 유료 기능: https://firebase.google.com/docs/firestore/pricing
- 보안 규칙에 따른 추가 읽기: https://firebase.google.com/docs/firestore/pricing#cloud-firestore-security-rules
- Firebase Storage 요금제: https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024
- Cloud Functions 배포 요금제: https://firebase.google.com/docs/functions/get-started
- Firebase 인증 제한: https://firebase.google.com/docs/auth/limits
- Firebase 웹 API 키 및 보안 규칙: https://firebase.google.com/docs/projects/api-keys
- Firebase 토큰 폐기 확인: https://firebase.google.com/docs/auth/admin/manage-sessions
- Firestore 서버 라이브러리와 규칙: https://firebase.google.com/docs/firestore/security/rules-conditions
- Supabase 플랜 사용량: https://supabase.com/docs/guides/platform/billing-on-supabase
- Supabase 전송량: https://supabase.com/docs/guides/storage/serving/bandwidth
- Supabase 기본 SMTP 제한: https://supabase.com/docs/guides/auth/auth-smtp
- Supabase 일시 중지와 백업: https://supabase.com/docs/guides/deployment/going-into-prod
- Supabase 할당량 초과: https://supabase.com/docs/guides/platform/billing-faq
- Supabase 비공개 버킷: https://supabase.com/docs/guides/storage/buckets/fundamentals
- GitHub Pages 정적 파일: https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site
- 개인정보 처리방침 기재사항: https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0030&lsiSeq=283839&urlMode=lsScJoRltInfoR
