#!/usr/bin/env bash
set -euo pipefail
[[ "${FIREBASE_AUTH_EMULATOR_HOST:-}" == '127.0.0.1:9099' && "${FIRESTORE_EMULATOR_HOST:-}" == '127.0.0.1:8085' && "${GCLOUD_PROJECT:-}" == 'demo-okclean-integration' ]] || exit 1
name=okclean-reservation-test-${GITHUB_RUN_ID:-local}
cleanup(){ docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Both images are ephemeral and must never be pushed or deployed.
docker build -f server/Dockerfile -t okclean-reservation:integration .
docker build -f tests/Dockerfile.reservation-test -t okclean-reservation:test .
docker run --detach --network host --name "$name" \
  -e FIREBASE_AUTH_EMULATOR_HOST -e FIRESTORE_EMULATOR_HOST -e GCLOUD_PROJECT \
  okclean-reservation:test node /app/tests/server-container-entry.cjs >/dev/null
ready(){ for i in $(seq 1 60); do if curl -sS --max-time 1 http://127.0.0.1:8799/ >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }
ready
node tests/server-container-http.cjs seed
docker restart "$name" >/dev/null
ready
node tests/server-container-http.cjs verify
node tests/server-container-browser.cjs
