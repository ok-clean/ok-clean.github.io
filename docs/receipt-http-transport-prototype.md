# 고객 접수 확인 HTTP 전송 시제품 — 미배포

**상태:** 서버용 코드와 가짜 인증 데이터를 사용하는 테스트입니다. GitHub Pages 또는 운영 Firebase에 연결되지 않으며 고객정보·비밀번호·결제 설정을 추가하지 않았습니다.

## 구현
- POST `/api/receipt-status` 한 경로만 처리하는 Node HTTP 함수 (`prototype/security/receipt-http-adapter.cjs`)
- Bearer ID 토큰과 JSON 본문에서 요청번호 한 필드만 요구하며 기본 1024바이트 초과를 거부합니다.
- HTTPS Origin 허용 목록으로 CORS를 제한하고, no-store·no-cache·no-referrer·nosniff 응답 헤더를 사용합니다. CORS는 인증을 대체하지 않습니다.
- 기존 `receipt-status-handler.cjs`의 본인 UID·인증 상태·속도 제한을 거쳐 접수 존재 여부만 반환합니다. 이름·전화번호·상세 주소는 전혀 반환하지 않습니다.
- 타인 소유 요청과 존재하지 않는 요청은 동일한 최소 응답을 사용합니다.

## 운영 연결 전 필수 보안 조건
1. 실제 신뢰할 수 있는 서버에서 Firebase Admin SDK로 ID 토큰의 서명·프로젝트·만료를 확인하고, 서버 측 DB 조회와 분산 속도 제한을 구현해야 합니다. 현재는 전부 테스트용 콜백이며 HTTP 서버를 배포하지 않습니다.
2. 기존 요청의 소유자인 익명 Firebase UID와 고객이 검증한 로그인 UID가 **동일한지** 확인해야 합니다. 같은 Firebase 계정에 자격 증명을 연결해 UID를 유지하는 방법을 우선 검토하고, 새 계정으로 로그인했다면 전화번호나 요청 ID만으로 소유권을 넘기지 않습니다.
3. 인증 전 IP 제한, App Check, 남용 감지, 개인정보를 남기지 않는 로그, 백업 포함 보존·삭제 정책 및 운영 Firebase 기존 회원 규칙 통합 검증이 필요합니다.
4. 허용 출처에는 실제 서비스 URL만 사용합니다. 토큰을 URL·로그·공개 저장소에 남기지 않으며 클라이언트에 관리자 자격 증명을 제공하지 않습니다.
5. GitHub Pages는 Node 서버를 실행할 수 없습니다. 별도 호스팅·비용·승인 여부를 검토한 뒤에만 실제 서비스를 연결할 수 있습니다.
6. PR #5→#12→#13→#14→이 PR과 PR #8의 공개 배포 제외 관계를 확인해야 합니다. main 병합·운영 배포·유료 신청은 별도 승인 전 금지입니다.

## 로컬 테스트
- `node prototype/security/receipt-http-adapter.test.cjs`
- `node prototype/security/receipt-http-integration.test.cjs`
- 모두 가짜 데이터만 사용하며 테스트 서버는 127.0.0.1에만 임시로 열립니다.
