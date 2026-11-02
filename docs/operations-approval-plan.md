# 운영 연결 준비 / 승인 경계

이 문서는 PR #62의 준비용 계약이다. 클라우드 설정이나 실제 고객자료를 변경하지 않는다.
v4 공급자 주입형 키 수명주기·쓰기 격리·체크포인트 어댑터와 읽기 전용 점검기는 구현한다.
실제 클라우드 SDK 공급자 연결, 외부 writer 격리 및 WORM 보장은 운영 인프라 검증 전까지 미확정이다.
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
| authorities | control, validator, issuer 각각 독립 serviceAccount, keyVersion, algorithm=EC_SIGN_ED25519, state=ENABLED, capabilities, publicKeySha256, notBefore/expiresAt(UTC epoch ms) |
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
   상태 재조회 실패는 v4 키 어댑터에서 차단한다. 실제 KMS/원장 공급자 연결은 별도 검증한다.
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
v4 추가 파일은 운영 어댑터와 관련 검사이며 기존 운영 진입점은 변경하지 않는다. 기존 페이지·가격·고객 API·데모 어댑터 변경 없음.
62→56 정렬, 57 개인정보 변경과 충돌 조정, 최신 main 회귀, 운영 보안 실증 후 main/서버 배포를
각각 승인한다. 승인 전 기존 PR 병합/종료, Firebase/IAM 변경, 키 발급, 데이터 파기는 금지한다.
320/390/1440 UI는 이전 동일 구현의 성공 증거를 재사용한다. 새 HEAD CI는 별도로 기록한다.

## 후속 보강: 키 수명과 입력 보호

키 참조가 서로 달라도 공개키가 같으면 독립성이 없으므로 세 SPKI DER SHA-256 fingerprint도
서로 달라야 한다. issuer fingerprint는 기존 OKCLEAN_RESTORE_PUBLIC_KEY와 대조한다.
모든 키는 정수 notBefore/expiresAt 기간 안에 있어야 한다. 이 기간은 운영자 계획값이며 KMS의
실제 유효 상태/폐기 조회를 대신하지 않는다. 고정 버전·키 상태 검사는 기존 구현을 재사용한다.

manifest/site 파일은 각각 64KiB 이내여야 하며, camelCase privateKey/idToken/authorization과
추가 secret 환경변수도 거부한다. 출력은 원문 대신 고정 코드만 남긴다. --prepare 성공을
배포 승인으로 사용하지 않으며 --deployment는 계속 실패한다.

실제 운영 구현에는 여전히 고객/관리자/재적용 writer별 fencing token과 멱등성 본문 결속,
commit 직전 권한 재검증, 키 폐기 조회 실패 시 차단, generation에 결속된 전체 checkpoint,
append-only 감사 기록이 필요하다. 승인만으로 이 구현이 완료되는 것은 아니다.


## v4 구현 및 공급자 계약

모든 신규 모듈은 운영 진입점에 연결하지 않는다. 테스트 공급자는 메모리에서 거래를 직렬화하고
rollback을 모사하며, 이를 실제 여러 서버/여러 DB의 원자성이나 WORM 증거로 해석하지 않는다.
production hardguard와 --deployment 실패는 그대로다. 모의 검증 성공은 실제 운영 검증이 아니다.

| 모듈 | 구현 범위 | 실제 연결 시 입증할 경계 |
|---|---|---|
| key-lifecycle-adapter.cjs | 역할/목적/키버전/내용/자원 해시 결속, 키 교체·폐기 상태, 발급 영수증, 과거 검증과 실행 권한 분리 | 독립 KMS 권한, 정확한 버전 상태·공개키 지문, 내구성 있는 원자적 registry와 감사, 모든 발급 경로 적용 |
| write-isolation-adapter.cjs | 생성/수정/복원/삭제 구분, 권한·App Check 재확인, 멱등 영수증, revision/fencing token, tombstone | 원본과 다른 격리 DB, 모든 writer 통제, control/권한/본문/영수증/감사의 단일 원자적 commit 및 deadline |
| checkpoint-store-adapter.cjs | 기존 checkpointMessage 검증, 순서/이전 해시/외부 anchor, 생성 전용 기록, 보존기간·legal hold, 재시도 | 객체/anchor/감사 원자성, 독립 anchor 보호, IAM overwrite/delete 차단 및 실제 저장소 retention lock |
| operations-restore-bridge.cjs | 현재 control 키 검증 + 요청별 issuer 증명 + 저장된 체크포인트를 연결, 요청/작업/revision 결속 | 여러 공급자 사이 원자성을 외부 격리가 보장해야 함; historical 검증만으로 실행 허용 금지 |
| operations-readiness-reader.cjs | 신선한 자원/IAM/App Check/쓰기 정책 스냅샷 비교, 시작/종료 revision·토큰 검증 | 신뢰할 수 있는 읽기 전용 SDK 공급자, 상속/그룹/조건/impersonation을 포함한 실효권한 전개 |

읽기 전용 점검기의 provider는 readRevision/readInventory/readEffectiveIam/readAppCheck/
readDatabasePolicy만 제공한다. 정규화된 값의 project/revision/observedAt를 모두 결속한다.
mode=synthetic은 기본값이며 live-readonly라도 productionVerified/deployAllowed는 false이다.
체크 성공은 해당 읽기 검사 범위만 의미한다. 외부 fence/WORM·전체 운영 통합을 대신하지 않는다.
토큰은 SDK 검증기에만 전달하고 결과/감사/예외에 원문을 반환하지 않는다.

키 폐기는 신규 발급/운영 권한을 차단한다. 보관된 공개키와 발급 영수증을 유지하여 과거 기록의
서명을 검사할 수 있지만, 그 결과는 historicalOnly/authorizesOperation=false로 한정한다.
과거 검증 성공을 복원 허가로 바꾸지 않는다. 키 원문 생성·폐기 API는 없다.
기존 legacy 서명 경로가 자동으로 신규 키 수명주기 보호를 얻지는 않는다. 승인된 연결 작업은
모든 서명/검증 경로를 신규 계약으로 연결하고 누락된 우회 경로를 검사해야 한다.

## 운영 승인표 — 실제 값 확정 후 실행

| 승인 | 적용 대상 및 변경 | 위험 | 검증 방법 | 복구 계획 |
|---|---|---|---|---|
| A 자원 | source/ledger/control 프로젝트, DB ID/UUID, KMS 버전, bucket/anchor/sink, 모든 writer 목록 확정 | 잘못된 대상 접근, 원본/복원 혼동 | metadata와 repo 설정 대조, DB 재생성 UUID 검사 | 아직 변경 없음; 불일치 시 중단 |
| B 조회 | 위 자원의 제한된 읽기 권한과 operations_auditor 주체 확정 | 과도한 조회, 상속권한 누락 | 실효권한 전개와 allowlist, App Check 및 revoked token 실증 | 점검 주체 권한 회수, 발급 차단 유지 |
| B 적용 | 독립 SA/KMS 권한, 외부 쓰기 격리, 변경 방지 저장소 정책 적용 | 서비스 중단, 비용, 비가역 retention lock | 별도 staging 장애·재시도·경합·키교체·삭제불가 실증 | 이전 서비스 revision 복귀; lock은 되돌릴 수 있다고 약속하지 않음 |
| C 개인정보 | 유형별 파기 범위·보존 예외·시행일·과거 백업 처리 확정 | 오삭제 또는 과보존 | 합성자료로 preview와 legal hold, 복원 후 재삭제 검증 | 파기 전 차단 유지; 실제 삭제를 코드 rollback으로 복구하지 않음 |
| D 연동 | 공급자 SDK 연결과 설정 적용, staging/실운영 연동 검사 | SDK 원자성/권한 차이, 신규 비용·쓰기 | 대상·변경·합성자료 범위를 명시한 별도 승인 후 실행 | 격리/issuer 차단, 이전 revision, 원본/원장/epoch 보존 |
| D 배포 | 검증된 HEAD의 PR 병합과 홈페이지/서버 배포 | 기존 기능 회귀 | 최종 HEAD CI·320/390/1440·권한·운영 점검 | 배포별 역순 revision 복귀; 고객자료/백업 복원은 별도 승인 |

다음 단계는 운영 자원과 공급자 경계를 확정한 뒤 SDK 연결 및 staging 통합을 수행하는 것이다.
자원 선택을 코드가 임의로 만들어내지 않으며, 공급자 계약 테스트를 실제 IAM·원자성 입증으로
대체하지 않는다. 운영 발급 활성화/main 병합/배포는 이 문서나 테스트 통과로 승인되지 않는다.


v4 복원 연결은 비소비형 키 검증(consume:false)과 DB 내 요청 영수증을 조합한다.
키 검증을 먼저 소비한 다음 DB가 실패하면 재시도를 막는 문제가 있으므로, 키 검증 결과 자체는
실행 권한을 반환하지 않는다. operations-restore-bridge가 현재 control/issuer 키와 요청별
내용·checkpoint 결속을 확인한 뒤 격리된 쓰기만 승인한다. writer는 거래 안에서 다시 확인하고,
요청 영수증·본문·감사를 함께 저장한다. 독립 공급자 사이의 폐기/쓰기 원자성은 이 코드만으로
보장하지 않으며 외부 fence와 실제 공급자 통합 검사가 필수다.


## v5 실제 SDK 공급자 연결 코드

기존 의존성 firebase-admin 14.5.0, google-auth-library 11.3.2와 lockfile을 그대로 사용한다.
새로운 운영 진입점은 만들지 않았다. 초기화된 Firebase App/Firestore 및 GoogleAuth 인스턴스를
서버의 신뢰된 구성에서 공급하며, 브라우저/요청 본문에서 프로젝트나 관리자 권한을 받지 않는다.
운영 활성화는 기존 issuer hardguard 해제와 별도의 승인된 서버 구성·실제 권한 검증을 요구한다.
환경변수/manifest가 없거나 공급자 생성자의 자원 결속 검사가 실패하면 연결을 거부한다.

| 공급자 | 실제 SDK 호출 및 보장 범위 | 차단/제한 |
|---|---|---|
| firestore-write-provider | Admin SDK runTransaction/get/set/create; 본문·멱등 영수증·감사 동일 DB 거래 | 기본/운영 쓰기 거부; 실제 SDK host 또는 servicePath/port와 ssl=false까지 확인한 demo loopback만 쓰기 허용 |
| firestore-evidence-provider | SDK 원자 거래로 키 registry/영수증/감사와 checkpoint records/head/audit 저장 | 사전 생성된 registry/head 필요; 읽기 후 쓰기 순서, 크기/행 수 제한; Firestore 자체를 WORM으로 표시하지 않음 |
| gcp-kms-provider | GoogleAuth 요청으로 version/getPublicKey/asymmetricSign; CRC32C·SPKI·상태·알고리즘·응답서명 검증 | 실제 인증은 읽기만, 서명 경로는 명시적 모의 transport만; 키 생성/변경/파기 API 없음 |
| gcs-checkpoint-provider | GoogleAuth GCS JSON API, generation=0 조건부 생성 계약, generation 고정 다운로드·SHA256·보존/hold 대조 | 실제 인증은 읽기만, 생성은 명시적 모의 transport; overwrite/delete/retention lock 변경 API 없음 |
| firebase-sdk-identity | getAuth(app).verifyIdToken(token,true), getAppCheck(app).verifyToken(token) | 발급자/대상/만료/appId 대조, authVersion 없으면 거부; 사용자·권한·토큰 생성/변경 없음 |
| gcp-readonly-inspector | 프로젝트/웹앱/DB metadata, getIamPolicy(version3), AppCheck enforcement 및 debug token 페이지 조회 | GET와 읽기 전용 getIamPolicy POST만; 프로젝트 정책이 맞아도 상속·그룹·조건·deny·impersonation 전체 검증 완료로 표시하지 않음 |

기존 v4 write/lifecycle/checkpoint/restore bridge에 위 SDK 공급자를 주입한다. 예약 원본 DB와
격리 대상 DB는 ID와 UUID 모두 구분하고 거래 전후 확인한다. 실제 에뮬레이터 시험의 DB UUID,
인증·복원 증명은 합성 값이며 실제 Firestore metadata/IAM/Auth 운영 증명이 아니다.
감사 기록은 공급자 내 create 전용 문서와 고정 코드·해시·추적 ID를 사용한다. SDK 예외 본문,
토큰, 고객 본문은 진단 출력에 포함하지 않는다. 운영 로그 sink의 보존/조회 권한은 별도 검증한다.

### 공급자 실제 보장의 한계

- Firestore 거래는 같은 DB의 데이터 원자성을 제공하지만 임의의 서버 commit 시각을 application
  deadline 이내로 강제하는 API는 없다. 늦거나 끊긴 응답은 불확정으로 처리하고 격리를 유지한다.
  같은 requestId로 영수증을 확인한다. timeout이 이미 실행된 commit을 취소했다고 주장하지 않는다.
- Firestore anchor, GCS 객체, KMS registry는 서로 다른 서비스다. 하나의 원자적 commit으로 묶었다고
  표시하지 않는다. 외부 fence·독립 anchor 보호와 장애 단계별 재개 검증이 필요하다.
- GCS retention lock·uniform access·객체 generation/bytes를 읽어 대조해도 전체 IAM과 법적 보존을
  증명하지 않는다. temporary hold 변경 권한 및 bucket 정책의 실효권한은 따로 승인·검증한다.
- IAM 프로젝트 역할 목록 확인만으로 유효 권한을 완성했다고 판단하지 않는다. 상속/리소스/그룹/
  조건/서비스계정 위임/deny 정책은 미확인 차단 요소로 남긴다. AppCheck Firestore enforcement는
  custom backend 배포의 검증 코드 적용을 증명하지 않는다.

### 운영 승인 체크리스트 (v5)

| 영역 | 구현 상태/필요 자원·권한 | 위험·적용 절차 | 검증·실패 복구 | 승인 |
|---|---|---|---|---|
| Firebase | 실제 SDK 연결/metadata 검사 구현; 프로젝트·원본/격리 DB ID·UUID와 읽기 권한 필요 | 잘못된 대상 연결; metadata를 설정과 대조 후만 연결 | 원본 쓰기 없는 조회→staging 거래; 불일치 즉시 중단 | 자원확정/운영연결 필요 |
| IAM | 프로젝트 정책 SDK 조회/역할 대조 구현; 독립 SA와 계층별 정책 조회 필요 | 과권한·상속 누락; 각 역할 allowlist 및 실효권한 분석 | 권한 부족/과다/위임/조건 검사; 이전 정책 snapshot 복구는 별도승인 | 조회 범위/적용 필요 |
| App Check | Admin SDK 검증 및 enforcement/debug 조회 구현 | 앱 불일치·debug 우회; 등록 앱/운영 정책 확정 | 누락/위조/만료 거부, custom backend 실제 검사; 실패 시 API 차단 | 실제 운영검증 필요 |
| KMS | 버전/지문/CRC/서명 SDK 코드·모의 계약 완료; 독립 키·서비스계정 필요 | 폐기·교체 오설정; 알고리즘/버전/권한 확정 후 staging 연결 | 권한 거부/교체 경합/폐기 검증; 발급 차단 유지, 공개키 이력 보존 | 실제 서명·키 변경 별도승인 |
| 체크포인트 | Firestore 기록 및 GCS 조건부 생성/조회 코드 완료; 독립 bucket/anchor 필요 | lock 비가역성·서비스간 부분 실패; 기간/비용 검토 후 생성 | 덮어쓰기/삭제 불가·부분 실패·재시도 실증; 객체/원장 임의 되돌림 금지 | 저장소/lock/권한 적용 필요 |
| 예약 격리 | SDK 거래·멱등성·감사·복원 계약 완료; 모든 writer 차단 인프라 필요 | Admin SDK 우회·late commit; writer 목록과 격리 권한 확정 | 실제 동시 writer/중단 재개; 격리 유지하고 영수증으로 확인 | 운영 쓰기·격리 적용 필요 |
| 개인정보 | hold/보존기간 역행 차단 구현; 유형별 범위·예외·시행일 필요 | 오삭제/과보존; 합성 preview 후 범위 결정 | backup 복원 후 재삭제와 예외 검증; 실제 파기는 코드 rollback 대상 아님 | 정책 결정 필요 |
| 배포 | Draft/CI/실행 차단 유지; 검증 HEAD·서버 revision 필요 | 기존 기능 회귀; 승인된 범위에서 단계별 연동→병합→배포 | 최종 CI 및 운영 점검; 이전 revision 복귀, 고객자료는 별도승인 | 각각 별도승인 |

### 검증 실행

`npm ci --prefix server --ignore-scripts --no-audit --no-fund`

`.github/workflows/cloud-sdk-contracts.yml`은 고정 SDK의 단위/요청 계약과 공식 Firestore
에뮬레이터 두 통합 스크립트를 실행한다. 기존 208개 회귀와 기존 9개 CI도 유지한다.
GCS/KMS 외부 계정/테스트 프로젝트는 제공되지 않아 모의 transport 검사만 수행한다.
실제 IAM/AppCheck·KMS·GCS·staging·운영 연동 성공으로 집계하지 않는다.
운영을 테스트 프로젝트로 사용하거나 테스트 데이터를 운영 DB에 생성하지 않는다.

### 공식 API 근거

- https://firebase.google.com/docs/firestore/manage-data/transactions
- https://firebase.google.com/docs/auth/admin/verify-id-tokens
- https://firebase.google.com/docs/app-check/custom-resource-backend
- https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.services/get
- https://firebase.google.com/docs/reference/appcheck/rest/v1/projects.apps.debugTokens/list
- https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/getIamPolicy
- https://firebase.google.com/docs/reference/firebase-management/rest/v1beta1/projects.webApps/get
- https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys.cryptoKeyVersions/asymmetricSign
- https://docs.cloud.google.com/kms/docs/data-integrity-guidelines
- https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert
