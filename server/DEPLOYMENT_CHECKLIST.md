# 예약 서버 배포 준비 — 실행 금지 초안

이 문서는 **승인 전 배포·Cloud Run 생성·Firebase 설정 변경·결제 활성화를 지시하지 않는다**. 아래 배포·트래픽 변경 명령은 검토용이며 사용자 승인 후에만 사용한다. 실제 프로젝트와 과금 상태, 권한, 계정 및 서비스 존재 여부는 현재 미확인이다. 공개 저장소, 로그, 채팅에 키·토큰·서비스 계정 키 JSON·고객 정보를 남기지 않는다.

## 읽기 전용 사전 검사

저장소 루트에서 검토할 사이트 설정 파일을 로컬에 준비하고, 운영 담당자가 아래 **비밀이 아닌** 환경 변수들을 본인 환경에 설정한 다음 실행한다. 변수 값을 채팅이나 로그에 복사하지 않는다.

- `OKCLEAN_TARGET=production`, `NODE_ENV=production`
- `OKCLEAN_PROJECT_ID` 와 `GOOGLE_CLOUD_PROJECT`: 검토 대상 Google Cloud 프로젝트 ID. 사이트 Firebase `projectId`와 같아야 한다. `GCLOUD_PROJECT`가 있으면 이것도 같아야 한다.
- `OKCLEAN_FIREBASE_WEB_APP_ID`: 검토 대상 웹 앱의 Firebase `appId`와 같아야 한다.
- `CONSENT_VERSION`: 검토된 사이트의 `reservation.consentVersion`과 같아야 한다.
- `ALLOWED_ORIGIN=https://ok-clean.github.io`
- `OKCLEAN_REGION`: 대상 Cloud Run 리전.
- `OKCLEAN_SERVICE_ACCOUNT`: 해당 프로젝트의 전용 사용자 관리 서비스 계정 이메일.

Cloud Run이 `GOOGLE_CLOUD_PROJECT`를 자동 주입한다고 가정하지 말고 서버 리비전 설정에도 명시한다. 실제 키 JSON을 환경에 지정하지 않고 서비스 아이덴티티를 사용한다. 다른 에뮬레이터·App Check 디버그 환경 변수도 해제한다.

```bash
node server/preflight.cjs /검토할/사이트-config.json
```

실패는 출력된 코드명에 해당하는 항목을 수정한 뒤 재검사한다. `PRECHECK_OK`는 **로컬 설정값 간 일치만** 의미한다. 실제 Google Cloud/Firebase 프로젝트의 일치·계정 권한·App Check 등록·운영 규칙·비용·개인정보 처리방침 페이지 실재·보유기간에 따른 자동 삭제·실제 접속 성공은 확인하지 않는다. 가격표는 컨테이너 이미지 빌드 시 사이트 설정에서 추출되므로 이미지와 사이트 가격 버전이 같은지도 별도로 확인한다.

## 배포 예시 — 승인 전 절대 실행하지 않음

기존 Cloud Run 서비스에 이미 승인·검증된 이미지 digest를 **새 리비전으로만** 배포하는 예시다. 실서비스·결제 상태가 미확인이고 최초 서비스 생성 시 동작은 별도로 확인해야 하므로, 실제 사용할 서비스가 존재하고 현재 트래픽·이전 리비전을 확인하기 전에는 사용하지 않는다. 기존 환경 변수를 삭제하지 않도록 `--update-env-vars`를 사용한다.

```bash
# EXAMPLE ONLY — 승인 전 실행 금지
# 모든 대문자 값은 검토 후 운영 담당자가 직접 치환한다.
gcloud run deploy SERVICE_NAME \
  --project PROJECT_ID --region REGION \
  --image IMAGE_WITH_VERIFIED_DIGEST \
  --service-account SERVICE_ACCOUNT_EMAIL \
  --update-env-vars NODE_ENV=production,OKCLEAN_PROJECT_ID=PROJECT_ID,GOOGLE_CLOUD_PROJECT=PROJECT_ID,OKCLEAN_FIREBASE_WEB_APP_ID=FIREBASE_WEB_APP_ID,ALLOWED_ORIGIN=https://ok-clean.github.io,CONSENT_VERSION=REVIEWED_POLICY_VERSION \
  --no-traffic
```

`--no-traffic`은 기존 서비스의 기본 트래픽을 새 리비전에 보내지 않는 설정이다. 태그를 추가하면 별도의 직접 접근 URL이 생길 수 있으므로 접근 정책을 먼저 검토한다. Cloud Run 공개 접근은 별도 승인과 IAM 검토가 필요하며 위 명령은 공개 접근을 설정하지 않는다. 일반 고객의 브라우저 Firebase ID 토큰과 Cloud Run IAM 호출 토큰은 다른 개념이다. 공개 접근을 허용하는 경우에도 서버 Firebase ID 토큰·App Check·관리자 권한 검증을 강제해야 한다.

## 승인 후 점검과 롤백 계획

1. 운영자 전용 IAM·서비스 계정의 최소 권한, Firestore 규칙, 고객 인증 제공업체, 관리자 클레임, Firebase App Check 등록, API 활성화 상태 및 서비스의 HTTPS/CORS를 확인한다. 서비스 계정의 App Check 토큰 검증 권한도 확인한다. Firebase 콘솔 App Check → 앱 → 디버그 토큰 관리에서 운영 앱에 등록된 불필요한 디버그 토큰을 제거한다. 등록된 디버그 토큰은 유효한 App Check 토큰으로 교환될 수 있어 서버의 앱 ID 검증만으로 출처를 구분할 수 없다.
2. 개인정보를 사용하지 않는 독립 테스트 환경에서 예약·계산 검증·실패/재시도·본인 복구·타인/비관리자 차단·관리자 상태 이력을 점검한다. 실제 운영 프로젝트에서 테스트 데이터 생성은 별도 승인 없이 하지 않는다.
3. 배포 전 서비스의 기존 리비전과 트래픽 비율 및 사이트 이전 버전을 기록한다. 장애 시 승인된 운영자가 Cloud Run에서 기존 리비전으로 트래픽을 되돌리고, 사이트도 기존 배포 버전으로 되돌린 후 예약·상담 동작을 확인한다. 트래픽 변경 명령 자체가 운영 변경이므로 별도 승인이 필요하다.
4. Cloud Run 오류율·지연·인증 거부·Firestore 오류를 개인정보나 토큰 없이 모니터링한다. 실행 횟수·CPU/메모리 시간·Firestore·네트워크·App Check·이미지 보관·빌드 등을 예산에 포함한다. **알림 전용 예산은 지출을 자동 제한하지 않는다.** 실제 계정의 예산·상한 기능 지원 여부와 경고 수신자를 확인한다.
5. 요청 제한 문서의 만료 삭제 정책과 고객정보·상태이력 보유/삭제 절차를 수립한다. 현재 단순 로컬 검사는 삭제가 실행되는지 보장하지 않는다.

참고: [Cloud Run 리비전·트래픽 관리](https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration), [서비스 아이덴티티와 환경변수](https://cloud.google.com/run/docs/configuring/services/environment-variables), [App Check 서버 검증](https://firebase.google.com/docs/app-check/custom-resource-backend), [예산 알림](https://cloud.google.com/billing/docs/how-to/budgets).
