# 운영 연결 준비 / 승인 경계

이 문서는 PR #62의 준비용 계약이다. 클라우드 설정이나 실제 고객자료를 변경하지 않는다.
운영 controller, WORM 저장 어댑터, 키 상태/폐기 조회 어댑터는 미구현이다.
설정에 true를 적는 것으로 실제 격리·권한·불변성을 증명할 수 없다.

## 실행과 판정

`node server/operations-preflight.cjs --prepare MANIFEST.json config.json`

- 환경변수는 기존 server/preflight.cjs의 validateRuntime 계약을 재사용한다.
- 추가 필수 변수: OKCLEAN_RESTORE_CONTROL_PROJECT_ID, OKCLEAN_FIRESTORE_DATABASE_ID,
  OKCLEAN_RESTORE_SERVING_DATABASE_ID, OKCLEAN_RESTORE_ISSUER_ENABLED=false,
  OKCLEAN_RESTORE_RENEWAL_ENABLED=false. 모든 DB 선택은 명시한다.
- 출력은 고정 오류 코드만 포함한다. 환경변수/원본 manifest/입력 경로/예외 원문을 출력하지 않는다.
- 종료 0은 오프라인 계획의 내부 일치만 뜻한다. 실제 IAM 접근 가능 여부를 뜻하지 않는다.
- `--deployment`는 항상 종료 1이다. productionVerified와 deployAllowed는 항상 false이다.
- 실제 issuer 코드는 네트워크·모듈 접근 없는 VM에서 실행하여 기존 하드가드 예외를 확인한다.
- 이 CI는 배포 workflow나 GitHub 보호 규칙이 아니다. 향후 배포 경로에 필수 gate로 연결하고
  브랜치 보호 required check 지정도 별도 승인/검증해야 한다.

## 비밀정보 없는 manifest 계약

`tests/operations-preflight.test.cjs`의 fixture는 완전한 합성 예제이다.
시험 보존기간과 프로젝트 이름을 운영값으로 사용하지 않는다. 별도 JSON에 다음을 채운다.

| 필드 | 값/의미 |
|---|---|
| schemaVersion | 1 |
| projects | source, ledger, control: 서로 다른 실제 프로젝트 ID |
| databases | source, restore: 서로 다른 DB ID; sourceUid, restoreUid: 실제 DB UUID |
| authorities | control, validator, issuer 각각 독립 serviceAccount, keyVersion, algorithm=EC_SIGN_ED25519, state=ENABLED, capabilities |
| checkpoint | bucket, project=control 프로젝트, retentionLocked=true, retentionSeconds=승인기간, writerAccess=create-only |
| fence | mode=deny-all-writers, onExpiry=remain-closed, coversAdminSdk=true, coversRestoreAndDelete=true |
| authentication | checkRevoked=true, appCheckEnforced=true, debugTokensDisabled=true, directClientWrites=false |
| audit | mode=codes-and-hashes-only, separateSink=true, sink=projects/PROJECT/sinks/SINK |
| backup | sourceReadOnly=true, restoreTargetQuarantined=true, automaticRelease=false |
| keyLifecycle | unknownKey=reject, revokedKey=reject, expiredProof=reject, rotation=explicit-version-review |
| publishAllowed | false |

Manifest는 계획 선언이며 실제 IAM 정책 export가 아니다. capabilities는 아래 정확한 내부 계약만 허용한다.
비밀키/서비스계정 JSON/토큰은 넣지 않는다. 비밀정보 검사는 입력의 알려진 credential 필드와 PEM을
탐지하는 보조 검사이며 임의의 모든 비밀을 탐지한다고 보장하지 않는다.

## 최소 권한 적용 구성안 (아직 적용 금지)

| 주체 | 내부 capabilities | 적용할 자원 경계 |
|---|---|---|
| control | fence.observe, checkpoint.create, control.sign | 전용 control 키에만 서명, 별도 checkpoint bucket에 객체 생성만; overwrite/delete/retention 변경 없음 |
| validator | checkpoint.read, restore.read, ledger.read, validation.create, validator.sign | checkpoint 읽기, 격리 복원 DB/원장 읽기, 검증 증거 쓰기, validator 키 서명만 |
| issuer | validation.read, ledger.read, attestation.create, issuer.sign | 원장/증거 읽기, attestation 쓰기, issuer 키 서명만; 고객 DB 및 control 키 권한 없음 |

이 표를 IAM binding으로 자동 적용하지 않는다. 리소스별 실제 지원 권한을 조회한 뒤 custom role과
서비스별 저장 경계를 확정해야 한다. Firestore Admin SDK는 Security Rules를 우회한다.
문서 단위 권한을 IAM으로 보장한다고 가정하지 않으며 필요하면 별도 DB/서비스로 쓰기를 분리한다.
상속 조직/폴더/그룹 권한, impersonation, key administration, owner/editor, 외부 principals까지
확인하지 않은 상태에서는 최소 권한 검증 완료로 표시하지 않는다.

## 승인 ① 자원 확인

현재 코드의 source project는 okclean-admin. 존재/실효 권한은 미검증이다.
ledger/control 프로젝트, 원본/복원 DB ID와 UUID, checkpoint bucket, 감사 sink,
세 독립 서비스계정과 KMS key version 참조를 확정한다. 채팅으로 비밀키를 요구하지 않는다.
권한 승인 후 별도 읽기 전용 검사는 프로젝트/DB metadata, IAM 정책(상속 포함), App Check 앱 및
debug token 사용 현황, KMS algorithm/state/version, bucket retention/lock/IAM, 로그 sink를 확인한다.
고객 문서 읽기는 이 단계에 불필요하다. 누락/권한 거부/조회 실패는 차단 결과다.

## 승인 ② 인프라 적용

1. 변경 전 서비스 revision, IAM 정책, key version 참조와 저장소 설정을 읽기 전용 기록한다.
2. 모든 writer 목록(고객/관리자/Admin SDK/예약 작업/복원/삭제)을 확정하고 독립 control plane에서
   신규 writer까지 차단한다. 교차 프로젝트 원자적 격리의 미해결 설계를 구현·검증한다.
3. 원본 읽기 전용, 복원 대상 격리 후 checkpoint 완전성/불변성을 증명한다. retention lock은
   되돌릴 수 없는 변경 가능성이 있으므로 기간·비용 검토 후 개별 승인 대상으로 둔다.
4. 독립 서명/검증 권한과 키 버전 allowlist를 구현한다. 알 수 없는/폐기/비활성 키는 거부하고,
   rotation은 새 버전 검토→검증자 반영→발급 전환 순서로 설계한다. 기존 proof 만료와 폐기
   상태 재조회 실패를 fail-closed 처리하는 실제 어댑터가 필요하다.
5. 중복 요청/동시 요청/중단 재시도/lease 소실/부분 실패/관리자 폐기/변조/재사용/키교체를
   격리된 staging에서 검증한다. demo 가드를 제거해 운영 어댑터로 재사용하지 않는다.
6. 실패 시 발급 차단과 격리를 유지한다. 이전 서비스 revision 복귀도 승인 범위에서 실행한다.
   원장 epoch·삭제 이력·고객자료를 코드 rollback과 함께 되돌리지 않는다.

## 승인 ③ 개인정보 정책 선택

| 선택 | 필요 결정 | 위험/조건 |
|---|---|---|
| 정책 확정 전 차단 유지 | 현재 상태 유지 | 운영 연결 지연, 자동 파기 시행 안 함 |
| 자료 유형별 확정 후 적용 | 상담/예약/회원/거래/로그/과거 사본 각각 범위·보존 예외·시행일·담당자 | 법정/분쟁 보존 예외와 backup 재삭제 연결 검증 필요 |

상담 90일을 예약·회원 자료로 확대하지 않는다. 합성 테스트 기간은 운영 정책이 아니다.
이미 승인된 일반 방향을 재질문하지 않고 미확정 범위·예외·시행일만 결정한다.

## 승인 ④ 배포와 PR 의존 관계

62 base는 56 작업브랜치이며 main 직접 대상이 아니다. 51/52/53/58을 중복 구현/병합하지 않는다.
현재 추가 파일은 운영 preflight/검사/CI/이 문서뿐이다. 기존 페이지·가격·고객 API·데모 어댑터 변경 없음.
62→56 정렬, 57 개인정보 변경과 충돌 조정, 최신 main 회귀, 운영 보안 실증 후 main/서버 배포를
각각 승인한다. 승인 전 기존 PR 병합/종료, Firebase/IAM 변경, 키 발급, 데이터 파기는 금지한다.
320/390/1440 UI는 이전 동일 구현의 성공 증거를 재사용한다. 새 HEAD CI는 별도로 기록한다.
