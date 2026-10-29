# 접수 조회 연속 점검 결과 — 2026-10-27

대상: PR #15 / `feature/receipt-http-transport-security-20261027`. 운영 미배포.
기준 커밋: `73c79db442361f65f45804a8aff140db26e9bd87`.

## 재현 후 수정한 문제

- 접수 타임아웃 후 서버 조회에서 성공이 확인되어도, 원래 전송의 늦은 실패 응답이 성공 상태를 `unknown`으로 되돌렸습니다. 검증된 성공은 최종 상태로 유지합니다.
- 화면 상태 알림 콜백이 예외를 던지면 실제 전송 전에 함수가 중단되었습니다. 동기/비동기 화면 오류를 전송·상태 처리와 분리하고 개인정보를 로그로 남기지 않습니다.
- HTTP 본문 수신과 서버 조회에 모듈 자체의 대기 제한이 없었습니다. 각각 기본 5초 제한을 추가했습니다. 본문 초과·중복 인증 헤더·지원하지 않는 인코딩·유효하지 않은 UTF-8·잘못된 요청 ID를 서버 조회 전에 거부합니다.
- 접수 확인 자체가 끝나지 않는 경우를 제한하고, 늦게 도착한 확인 결과로 타임아웃 결과를 바꾸지 않습니다. 존재하지 않음/오류 결과에서 자동 재접수하지 않습니다.

## 새 읽기 전용 클라이언트

`prototype/security/receipt-client.js`는 `getIdToken`과 정확한 HTTPS 엔드포인트를 주입받습니다. 토큰을 URL, 본문, 쿠키, 저장소에 기록하지 않고, 리디렉션·캐시·자동 재시도를 허용하지 않습니다. 응답은 256바이트까지 읽고 정확한 `confirmed` 결과만 인정합니다. 시간 초과·로그인 만료·권한 없음·조회 제한·내부 오류는 모두 `unavailable`로 유지합니다.

실제 운영 홈페이지에는 연결하지 않았습니다. 로컬 HTTP 테스트 예외는 명시적인 `allowLocalTesting:true` 및 루프백 IP에만 적용됩니다. 브라우저 DOM, 실기기, 운영 Firebase ID 토큰을 이 테스트가 검증하는 것은 아닙니다.

## 실제 실행한 검증

로컬 Node.js v22.16.0에서 실행했습니다. 원본 핵심 파일은 GitHub에서 읽어온 내용과 Git blob SHA를 대조했습니다.

```sh
node prototype/security/submission-controller.test.cjs
node prototype/security/receipt-http-adapter.test.cjs
node prototype/security/receipt-http-integration.test.cjs
node --test prototype/security/receipt-resilience.test.cjs prototype/security/receipt-client.test.cjs
```

기존 스크립트 3개 통과, 새 테스트 **35개 통과 / 실패 0**. 새 테스트에는 조회 클라이언트 → 실제 루프백 HTTP → 본인 확인 핸들러 → 가상 DB → 접수 상태 복구의 연결 검사가 포함됩니다. 테스트는 가짜 인증·가짜 데이터만 사용하며 실제 고객 접수를 만들지 않습니다.

GitHub CI에 같은 35개 검사를 추가했습니다. PR별 보안 테스트 중복 실행은 새 실행으로 대체하도록 설정했으며 배포 권한을 추가하지 않았습니다. GitHub Actions의 최종 성공 여부는 해당 커밋의 실행 결과로 별도 확인해야 합니다.

## 운영 전에 여전히 필요한 것

- 검증된 서버의 Firebase Admin SDK 토큰 검증(서명·프로젝트·만료 및 폐기/사용중지 여부), 실제 DB, 분산 요청 제한과 인증 전 IP 제한.
- 익명 접수 계정과 인증 계정 사이의 동일 UID 유지 검증. 요청번호·전화번호만으로 소유권을 이전하지 않습니다.
- 서버 응답 제한은 underlying DB 호출의 강제 취소를 보장하지 않습니다. 서버/프록시의 헤더·연결 제한과 DB 자체의 시간 제한도 필요합니다.
- 한 브라우저 컨트롤러 인스턴스의 중복 방지는 새로고침·여러 탭·재로그인을 넘는 서버 측 멱등성을 대신하지 않습니다.
- 실제 브라우저 화면 연결, 관리자/업체 인증, 견적 비교·예약과 감사 기록, 사진 업로드 및 보존·삭제 절차.
- PR #8의 시제품 Pages 배포 제외 검증. 소스는 공개 저장소에 있으므로 비밀이나 실제 개인정보를 기록하지 않습니다.
- main 병합, 운영 Firebase 규칙 변경, 배포, 유료 서비스 신청은 별도 승인 전 금지입니다.

공식 구현 참고: https://firebase.google.com/docs/auth/admin/verify-id-tokens 및 https://firebase.google.com/docs/auth/admin/manage-sessions (검토일 2026-10-27).
