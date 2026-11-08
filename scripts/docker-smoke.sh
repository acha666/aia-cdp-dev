#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
ID=aia-cdp-smoke-$$-$RANDOM
IMAGE=$ID:latest NAME=$ID VOLUME=$ID
CERTS=tests/fixtures/pki/certs
AIA_ADMIN_TOKEN=smoke-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export AIA_ADMIN_TOKEN

die() {
  printf 'docker-smoke: %s\n' "$*" >&2
  exit 1
}

T=$(mktemp -d "${TMPDIR:-/tmp}/aia-cdp-docker-smoke.XXXXXX")
cleanup() {
  rm -rf "$T"
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

failures=0
check() {
  local description=$1
  shift
  if "$@"; then
    printf 'ok    %s\n' "$description"
  else
    printf 'FAIL  %s\n' "$description"
    failures=$((failures + 1))
  fi
}
logs() {
  echo "--- container logs" >&2
  docker logs "$NAME" >&2 2>&1 || true
}

echo "docker-smoke: building $IMAGE"
docker build -t "$IMAGE" .
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -p 127.0.0.1::8080 -v "$VOLUME:/data" -e AIA_ADMIN_TOKEN \
  "$IMAGE" >/dev/null
hostport=$(docker port "$NAME" 8080/tcp | head -n 1)
BASE=http://127.0.0.1:${hostport##*:}

started=$(date +%s%3N)
state=''
for _ in $(seq 240); do
  state=$(docker inspect -f '{{.State.Status}}/{{.State.Health.Status}}' "$NAME")
  case $state in
    running/healthy | running/unhealthy | exited/* | dead/*) break ;;
  esac
  sleep 0.25
done
if [[ $state != running/healthy ]]; then
  logs
  die "container state $state after $(($(date +%s%3N) - started)) ms, want running/healthy"
fi
check "container healthy after $(($(date +%s%3N) - started)) ms ($BASE)" true

out=$(curl -sS --max-time 5 -w '\n%{http_code}' "$BASE/api/v1/health" 2>&1) || true
if [[ ${out##*$'\n'} == 200 && $out == *'"status":"degraded"'* ]]; then ok=0; else ok=1; fi
check "health is degraded: ${out//$'\n'/ }" test "$ok" = 0

uid=$(docker exec "$NAME" id -u)
check "runs as uid $uid (want 1000)" test "$uid" = 1000

aia() { docker exec -e AIA_URL=http://127.0.0.1:8080 "$NAME" node dist/server/cli/aia.js "$@"; }
aia_check() {
  local description=$1 want=$2 out status=0 ok=1
  shift 2
  out=$(aia "$@" 2>&1) || status=$?
  if ((status == 0)) && [[ $out =~ $want ]]; then ok=0; fi
  check "$description (exit $status): ${out//$'\n'/ | }" test "$ok" = 0
}

mkdir "$T/smoke"
cp "$CERTS/root-ca.der" "$T/smoke/root-ca.der"
cat "$CERTS/issuing-ca-1.pem" "$CERTS/issuing-ca-2.pem" >"$T/smoke/chain.pem"
root=$(sha256sum "$CERTS/root-ca.der" | cut -d ' ' -f 1)
target=$(aia new-target-id)
cat >"$T/smoke/config.json" <<JSON
{
  "version": 1,
  "certificates": { "$root": { "label": "Example Root CA" } },
  "targets": { "$target": { "issuer": "$root", "kind": "full", "label": "Example Root CA" } },
  "paths": {
    "/ca/root-ca.crt": { "certificate": "$root" },
    "/crl/root-ca.crl": { "target": "$target" }
  }
}
JSON
chmod 755 "$T/smoke"
chmod 644 "$T/smoke"/*
docker cp "$T/smoke/." "$NAME:/tmp/aia-smoke"

aia_check "aia import" '3 created, 0 unchanged, 0 failed' \
  import /tmp/aia-smoke/root-ca.der /tmp/aia-smoke/chain.pem
aia_check "aia config apply" '^applied /tmp/aia-smoke/config.json \(ETag "[0-9a-f]{64}"\)$' \
  config apply /tmp/aia-smoke/config.json

check "scripts/smoke.sh $BASE" bash scripts/smoke.sh "$BASE"

started=$(date +%s%3N)
docker stop "$NAME" >/dev/null
elapsed=$(($(date +%s%3N) - started))
check "docker stop took $elapsed ms (want < 5000)" test "$elapsed" -lt 5000
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
check "exit code $code after docker stop (want 0)" test "$code" = 0

if ((failures > 0)); then
  logs
  die "$failures check(s) failed"
fi
echo "docker-smoke: all checks passed"
