# 관리자 앱 별도 출처 준비 및 검증 기록

기준일: 2026-11-05. **사용자 승인 후 관리자 전용 Hosting 사이트 생성과 Firebase 로그인 승인 도메인 등록을 완료했다. 파일 배포는 아직 없으며 실제 Android 설치 검증은 대기 중이다.**

## 승인 후 실제 적용 상태

이번 사용자의 명시적 승인은 기존 프로젝트 안 새 전용 Hosting 사이트 생성·정적 배포·필요한 로그인 도메인/OAuth URI 추가를 포함한다. 같은 범위에 대한 재승인은 필요하지 않다.

- Firebase Console에서 기존 프로젝트 `okclean-admin`에 관리 계정으로 접근했다.
- Spark 요금제 `무료($0/월)`을 확인했다. 요금제 전환이나 결제 연결은 하지 않았다.
- 전용 Hosting 사이트 `okclean-admin-app`을 실제 생성했다. Console의 두 기본 도메인과 `첫 번째 출시 대기 중` 표시를 확인했다.
- Authentication 승인 도메인에 `okclean-admin-app.web.app` 한 항목을 추가하고, 새로고침 후에도 유지됨을 확인했다. 기존 승인 도메인은 보존했다.
- **Hosting 파일 배포·첫 release는 아직 없다.** Google OAuth redirect URI, API key 제한, 새 출처 로그인은 아직 확인하지 못했다.
- 공개 HTTP 확인에서 새 `/admin/`은 404, Firebase 예약 `/__/auth/handler`와 `/__/auth/iframe`은 각각 200 HTML로 응답했다. 인증 helper 제공 여부만 확인한 결과이며 OAuth 승인이나 실제 로그인 성공을 뜻하지 않는다.
- 기존 GitHub Pages 배포는 PR #78의 `51670e0fef7cce51d6e85c6d0eb55ce02f3ecad5`를 유지한다. 기존 `/admin/`의 이동 연결은 활성화하지 않았다.

현재 배포 차단은 인증된 파일 배포 경로다. Firebase Console의 Cloud Shell과 Google Cloud OAuth 설정 화면이 각각 `Site Unavailable`로 열렸으며, 각 한 차례 새로고침 후에도 같았다. 이는 이 작업 환경의 해당 관리 화면 접근 실패이며 새 Hosting 서비스의 장애나 설치 실패를 확인한 결과가 아니다. 로컬 Firebase CLI 15.35.0은 설치됐으나 `login:list`에 인증 계정이 없고, 클라우드 브라우저는 로컬 CLI의 loopback 콜백에 접근하지 못했다. 자격 증명을 읽거나 대화로 요청하지 않았다.

## 확인된 사실과 아직 확인되지 않은 사실

현재 GitHub Pages의 고객 manifest는 `id=/`, `start_url=/app/?src=app`, `scope=/app/`이다. 관리자 manifest의 `id`, `start_url`, `scope`는 모두 `/admin/`이다. 이 값들을 다시 바꾸는 것은 이 방안의 해결책이 아니다.

[기존 실제 Chromium 검사](https://github.com/ok-clean/ok-clean.github.io/actions/runs/41993484133)는 새 일반 프로필에서 관리자와 고객 페이지의 manifest·설치 가능성 오류가 없고, 브라우저가 생성한 `beforeinstallprompt`가 각각 288ms와 512ms에 발생했음을 확인했다. 이 결과는 기존 고객 WebAPK가 설치된 Android 환경을 검사하지 않았다.

다음 Chromium 경로는 **조건부 설치 충돌이 실제 구현에 존재함**을 보여 준다. 확인한 소스 리비전은 `ec2235ec5d2a693ab2fa46d428515cf7fd42e17c`이다.

1. [`WebappsClientAndroid::DoesNewWebAppConflictWithExistingInstallation`](https://github.com/chromium/chromium/blob/ec2235ec5d2a693ab2fa46d428515cf7fd42e17c/chrome/browser/webapps/webapps_client_android.cc)은 새 앱의 시작 URL을 처리할 수 있는 기존 WebAPK를 검사한다. manifest ID 비교만으로 끝나지 않는다.
2. [`WebappsUtils`](https://github.com/chromium/chromium/blob/ec2235ec5d2a693ab2fa46d428515cf7fd42e17c/components/webapps/browser/android/webapps_utils.cc)는 Android 쪽 패키지 조회 결과가 있는지 확인한다.
3. [`WebApkValidator`](https://github.com/chromium/chromium/blob/ec2235ec5d2a693ab2fa46d428515cf7fd42e17c/components/webapk/android/libs/client/src/org/chromium/components/webapk/lib/client/WebApkValidator.java)는 URL을 처리 가능한 패키지를 조회한다. 사용자가 선택한 기본 브라우저만 검사하는 방식이 아니다.
4. [`AppBannerManager`](https://github.com/chromium/chromium/blob/ec2235ec5d2a693ab2fa46d428515cf7fd42e17c/components/webapps/browser/banners/app_banner_manager.cc)는 충돌하면 `ALREADY_INSTALLED`로 중단한다.

아래는 위 코드 경로에 조건을 대입한 판정이다. **휴대폰 재현 실험이나 Android 설치 성공 기록이 아니다.**

| 설치된 고객 앱의 실제 범위 | 설치하려는 관리자 시작 URL | 고객 앱과의 충돌 조건 |
| --- | --- | --- |
| 설치본 없음 | `https://ok-clean.github.io/admin/` | 고객 앱 때문에 발생하는 충돌 없음 |
| 구형 `https://ok-clean.github.io/` | `https://ok-clean.github.io/admin/` | 기존 고객 패키지가 이 URL을 처리하면 충돌 |
| 갱신된 `https://ok-clean.github.io/app/` | `https://ok-clean.github.io/admin/` | 범위가 겹치지 않아 이 충돌 조건은 제거됨 |
| 구형 `https://ok-clean.github.io/` | `https://okclean-admin-app.web.app/admin/` | 출처가 달라 기존 고객 범위에 포함되지 않음 |

영향받은 휴대폰의 설치 패키지·Chrome 버전·실제 저장 범위를 직접 확인하지 못했다. 사용자 보고와 화면은 구형 범위 충돌과 부합하지만, 해당 기기의 확정 원인이라고 단정하지 않는다. 실제 앱 창에서 관리자 화면이 열렸다는 사실만으로 관리자 앱이 이미 설치됐다고 판단해서도 안 된다.

[Chrome 팀의 다중 PWA 설명](https://web.dev/articles/building-multiple-pwas-on-the-same-domain)은 바깥 앱이 설치된 경우 안쪽 앱의 설치 이벤트 억제와 링크 가로채기를 설명한다. [Android manifest 갱신 설명](https://web.dev/articles/manifest-updates)에 따르면 사이트의 새 manifest가 곧바로 이미 설치된 패키지에 적용되는 것은 아니다. 브라우저·OS의 갱신 일정과 조건이 관여한다. 구형 루트 범위가 남은 조건에서는 경로·query·ID·서비스워커만 바꿔 이를 강제로 해제하는 웹 API가 없다. 고객 앱 삭제나 브라우저 전체 데이터 삭제를 기본 해결법으로 삼지 않는다.

## 준비한 구체적인 별도 출처

**승인된 배포 대상:** 기존 Firebase 프로젝트 `okclean-admin` 안에 생성한 전용 Hosting 사이트 `okclean-admin-app`을 사용한다.

- 준비 주소: `https://okclean-admin-app.web.app/admin/`
- 현재 상태: **사이트 생성 완료·파일 미배포. 최종 운영 주소로 안내하지 않는다.**
- 새 프로젝트, 유료 도메인, Functions, App Hosting, Blaze 전환은 필요하지 않다.
- 기존 기본 사이트 `okclean-admin`에는 배포하지 않는다. Console에서 해당 사이트도 첫 번째 출시 대기 상태로 보였으며, 이번 작업은 별도 사이트만 대상으로 한다.
- `okclean-admin-app`은 이번 승인 범위에서 직접 생성한 사이트이므로 후속 작업에서 생성 명령을 다시 실행하지 않는다. 프로젝트와 사이트의 소속을 확인하고 이 대상만 사용한다.

[Firebase 다중 Hosting 공식 문서](https://firebase.google.com/docs/hosting/multisites)는 같은 프로젝트의 Authentication·데이터 자원을 여러 사이트에서 사용할 수 있음을 설명한다. 서로 다른 출처는 브라우저 저장소와 서비스워커를 분리하지만, 같은 프로젝트·같은 Google 계정으로 인증하면 기존 UID와 서버 권한을 계속 사용할 수 있다.

## 로컬 배포 묶음

다음 파일은 클라우드에 접속하지 않고 검토용 묶음만 생성한다.

- `scripts/stage_admin_hosting.py`
- `firebase.admin-hosting.json`
- `tests/test_admin_hosting_stage.py`

예시 실행은 새 출력 경로를 사용한다.

```bash
python scripts/stage_admin_hosting.py . /tmp/okclean-admin-hosting-review \
  --site-id okclean-admin-app \
  --origin https://okclean-admin-app.web.app
```

출력은 `public/`, Hosting 전용 `firebase.json`, 파일별 크기·SHA-256을 담은 `review.json`이다. `review.json`의 상태는 항상 `prepared_only_not_deployed`다.

공개 묶음에는 관리자 HTML·JS·manifest·전용 아이콘 3개, 설치 JS·CSS, 최소 Firebase 공개 설정, 전용 서비스워커, robots.txt만 담긴다. 고객 홈페이지·회원 자료·규칙·개발 파일은 복사하지 않는다. 관리자 JS는 원본 그대로 복사한다. 기존 저장소 파일은 변경하지 않는다.

관리자 manifest의 `/admin/` 식별·시작·범위는 보존한다. Firebase가 제공하는 두 별칭 중 `web.app`을 정식 설치 출처로 고정한다. 다른 별칭의 관리자 HTML을 열면 정식 출처로 이동하며, `/__/auth/` 등 Firebase 예약 URL은 가로채지 않는다. 기존 GitHub Pages에는 이 이동을 적용하지 않는다.

전용 서비스워커는 자체 출처의 공개 GET만 네트워크로 전달한다. 고객 HTML을 대체 페이지로 사용하거나 CacheStorage에 응답을 보관하지 않는다. 외부 SDK·인증·Firestore 요청과 Firebase 예약 경로에는 개입하지 않는다. 관리자 정보의 오프라인 보관을 추가하지 않는다.

## 로그인·권한 보존

기존 `apiKey`, `projectId`, `appId`를 사용하고, **새 묶음의 `authDomain`만 `okclean-admin-app.web.app`으로 맞춘다.** 기존 GitHub `config.json`, `admin/admin.js`, 관리자 UID, Firestore 규칙과 회원 데이터는 변경하지 않는다.

새 출처의 브라우저 저장소에는 이전 관리자 로그인 세션이 없으므로 처음 한 번 관리자 Google 로그인은 필요하다. 토큰을 URL·로컬 파일로 옮기거나 고객 앱의 익명 계정과 연결하지 않는다.

[Firebase redirect 로그인 지침](https://firebase.google.com/docs/auth/web/redirect-best-practices)에 따라 실제 반영 전에 다음을 확인해야 한다.

1. **완료:** Firebase Authentication 승인 도메인에 `okclean-admin-app.web.app`을 추가하고 저장·새로고침 후 유지됨을 확인했다.
2. Google OAuth 클라이언트의 승인된 redirect URI에 `https://okclean-admin-app.web.app/__/auth/handler`가 들어 있는지 확인하고, 필요하면 이 항목만 추가한다.
3. Firebase Hosting의 `/__/auth/handler`와 `/__/auth/iframe`의 200 HTML 응답은 확인했다. 실제 로그인 왕복은 미검증이다. 일반 HTML로 치환하는 catch-all rewrite를 추가하지 않는다.
4. Google 팝업 로그인과 팝업 차단 시 redirect 복귀를 확인한다. 허가된 관리자와 비관리자의 접근 결과를 별도로 검증한다.
5. API key의 웹사이트 제한이나 App Check 허용 출처가 있다면 새 출처가 필요한지 읽기 확인한다. 제한·규칙을 끄거나 전체 허용으로 넓히지 않는다.

신규 도메인 등록은 기존 UID에 없는 관리자 권한을 부여하지 않는다. 실제 로그인과 권한 검사 결과는 아직 없다.

## 비용·현재 접근 한계

[공식 Hosting 요금 문서](https://firebase.google.com/docs/hosting/usage-quotas-pricing)를 2026-11-05에 확인했다. 무료 사용량은 프로젝트 전체 합산 저장 10GB와 전송 10GB/월이며, 다른 Hosting 사이트와 공유한다. Spark에서 한도를 넘으면 배포·서비스가 제한될 수 있고, Blaze에서는 초과 사용량에 요금이 발생한다. 따라서 현 프로젝트의 요금제와 잔여 사용량을 확인하기 전에는 추가 비용이 무조건 0원이라고 말하지 않는다.

이 방안은 정적 Hosting만 사용한다. Console에서 Spark 무료 요금제를 실제 확인했다. 요금제 전환·결제 연결은 수행하지 않는다. 현재 준비 묶음은 11개 파일, 총 58,280바이트다. 향후 사용량 한도는 프로젝트 전체 기준으로 확인한다.

Firebase Console의 관리 세션으로 사이트 생성과 승인 도메인 변경은 적용했다. 현재 실행 환경에는 연결된 Firebase 관리 API/CLI 인증과 실제 Android 기기 제어가 제공되지 않았다. Cloud Shell·Google Cloud 관리 화면 접근 실패로 파일 배포와 OAuth 확인은 대기 중이다. 비밀번호·인증 코드·서비스 계정 키를 공개 저장소나 대화에 기록하지 않는다.

## 남은 적용 순서와 원복

사이트 생성과 승인 도메인 등록은 완료했다. 아래 순서는 남은 작업이며 파일 배포 명령을 실행한 기록이 아니다.

1. 인증된 Firebase CLI 실행 환경을 연결한다. 이미 확인한 프로젝트·Spark 요금제·전용 사이트의 소속을 유지한다. 관리 화면 접근 실패를 앱 설치 완료나 실패로 해석하지 않는다.
2. 최종 검토한 커밋으로 새 묶음을 만들고 `review.json`의 파일 해시를 보존한다.
3. `npx -y firebase-tools@latest hosting:sites:list --project okclean-admin`으로 생성한 `okclean-admin-app`의 소속을 확인한다. 사이트를 다시 생성하거나 기본 사이트를 선택하지 않는다. 유료 전환 요구 시 중단한다.
4. 미확인 OAuth URI와 필요한 출처 제한을 확인·적용한 뒤 생성된 묶음에서 `npx -y firebase-tools@latest deploy --project okclean-admin --config firebase.json --only hosting`을 실행한다. 이 설정에는 Authentication·Firestore·Functions 배포가 없다.
5. 새 공개 파일의 해시·manifest·설치 이벤트, 실제 관리자 로그인·권한, Android 설치를 확인한다. 새 origin에 대한 설치 수락과 `appinstalled`만으로 아이콘 생성·실행을 대신 확인했다고 보고하지 않는다.
6. 새 주소 검증 전에는 기존 `https://ok-clean.github.io/admin/`을 유지한다. 검증 후 기존 주소에 전용 관리자 주소 연결을 추가한다. 기존 앱 창에서 외부 브라우저가 필요한 경우 사용자 클릭으로 한 번만 전환하며 자동 설치를 보장하지 않는다.
7. 문제가 생기면 기존 GitHub 관리자 주소를 계속 사용한다. 새 연결을 제거하고 새 Hosting만 이전 정상 release로 되돌린다. 기존 고객 앱, 기본 Hosting, 인증 사용자·권한·DB를 삭제하거나 되돌리지 않는다.

**승인은 이미 받았다.** 남은 것은 인증된 배포 경로 확보와 검증이다. Firebase 연결과 실제 기기 접근이 없다는 사실을 승인으로 해결된 것처럼 표시하지 않는다.

## 새 출처 공개 배포 검사

`.github/workflows/admin-hosting-installability.yml`은 배포 후 읽기 전용 검사다. 필수 `source_sha`에 실제 Firebase 배포에 사용한 40자리 Git 커밋을 넣는다. 검사 코드와 배포 소스를 따로 체크아웃하고, 배포 소스의 생성기로 만든 11개 공개 파일을 새 출처와 대조한다. `tests/native-install-probe.cjs`의 `admin-hosting` 프로필은 `/admin/`만 검사한다. 기존 `pages` 프로필은 유지한다.

검사는 실제 Chromium 설치 이벤트와 페이지 버튼의 네이티브 확인창 호출, 취소·새로고침·브라우저 재실행을 확인한다. 설치 확인을 수락하지 않고 로그인·운영 데이터 제출도 하지 않는다. 새 Hosting 파일이 배포되지 않은 현재 이 검사는 실행하지 않았다. 문법·워크플로 설정·생성 파일 목록과 잘못된 SHA 입력 거부만 로컬에서 검증했다.

## 검증 상태

로컬 패키지 회귀검사 7개는 공개 파일 제한, 최소 설정·원본 로그인 코드 보존, 전용 사이트 제한, 출력 덮어쓰기·심볼릭 링크 거부, manifest·자원 링크 검증, 인증/데이터 요청 비개입과 오프라인 고객 HTML 혼입 방지를 확인한다. 이 검사는 Android 설치 검사가 아니다.

| 실제 설치 시나리오 | 이 준비안의 현재 결과 |
| --- | --- |
| 앱 없는 휴대폰에서 고객·관리자 각각 설치 | 실기기 검증 대기 |
| 기존 고객 앱 유지 후 관리자 별도 설치 | 실기기 검증 대기 |
| 관리자 설치 후 고객 설치 | 실기기 검증 대기 |
| 과거 고객 설치본에서 실패 재현·수정 효과 | 실기기 검증 대기 |
| 두 아이콘 공존·각각 올바른 화면 실행 | 실기기 검증 대기 |
| 취소·새로고침·브라우저 재실행 | UI 회귀검사와 별도로 실기기 검증 대기 |

완료 기준은 실제 Android에서 기존 고객 앱을 유지한 채 별도 관리자 아이콘을 설치하고 그 아이콘으로 관리자 화면을 실행한 증거다. 이 준비 묶음·로컬 검사·배포 성공은 그 완료 기준을 대신하지 않는다.
