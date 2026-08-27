#!/usr/bin/env bash
# Does the container actually work, and does the volume actually persist?
#
# "docker build succeeded" answers neither. This builds the image, starts it,
# claims the installation through the panel, then restarts, recreates, and
# rebuilds the image on the same volume — checking after each that the password
# and the database are still there.
#
#   npm run validate:docker
#
# Needs a working Docker daemon. Exits 2 (not 1) when there isn't one, so CI
# can tell "not tested here" from "broken".

set -uo pipefail

PROJECT="levix-validate-$$"
DATA_VOLUME="${PROJECT}_levix-data"
PORT=34333
PASSWORD="a-good-password-for-docker"

passed=0
failed=0

ok() {
  if [ "$2" = "0" ]; then
    passed=$((passed + 1))
    printf '  ok    %s\n' "$1"
  else
    failed=$((failed + 1))
    printf '  FAIL  %s\n' "$1"
  fi
}

cleanup() {
  printf '\n· cleaning up\n'
  compose down -v >/dev/null 2>&1
}
trap cleanup EXIT

# The published port and the data volume are overridden so a validation run
# never collides with a real Levix on this machine.
overlay() {
  cat <<EOF
services:
  levix:
    ports: ["127.0.0.1:${PORT}:3001"]
EOF
}

compose() {
  overlay | docker compose -p "$PROJECT" -f docker-compose.yml -f - "$@"
}

# --- is Docker even here? --------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  printf '\n  Docker is not installed — nothing was tested.\n\n'
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  printf '\n  The Docker daemon is not reachable — nothing was tested.\n\n'
  exit 2
fi

printf '\n▸ Validating the container (project %s)\n\n' "$PROJECT"

# --- build and start -------------------------------------------------------

printf '· build\n'
compose build >/tmp/levix-docker-build.log 2>&1
ok "the image builds" "$?"
if [ "$failed" != "0" ]; then tail -20 /tmp/levix-docker-build.log; exit 1; fi

printf '\n· start\n'
compose up -d >/dev/null 2>&1
ok "the container starts" "$?"

# Wait for the panel rather than sleeping blindly.
ready=1
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/setup" >/dev/null 2>&1; then ready=0; break; fi
  sleep 2
done
ok "the panel answers on the published port" "$ready"

if [ "$ready" != "0" ]; then
  printf '\n  logs:\n'
  compose logs --tail 40 levix
  exit 1
fi

# --- it must not be running as root ---------------------------------------

printf '\n· the process inside\n'

whoami_out="$(compose exec -T levix id -un 2>/dev/null | tr -d '\r\n')"
if [ "$whoami_out" = "node" ]; then status=0; else status=1; fi
ok "it runs as the unprivileged 'node' user (got '${whoami_out}')" "$status"

# One process, not a pool. The slim runtime image deliberately omits procps,
# so inspect /proc instead of requiring `ps` just for this validation.
# shellcheck disable=SC2016 # This script is evaluated by sh inside the container.
count="$(compose exec -T levix sh -c '
count=0
node_path="$(command -v node)"
for executable in /proc/[0-9]*/exe; do
  if [ "$(readlink "$executable" 2>/dev/null)" = "$node_path" ]; then
    count=$((count + 1))
  fi
done
printf '%s\n' "$count"
' 2>/dev/null)"
count="$(printf '%s' "$count" | tr -d '\r\n')"
if [ "${count:-0}" = "1" ]; then status=0; else status=1; fi
ok "exactly one Levix process is running (got '${count}')" "$status"

# --- /data is writable without anyone chmod-ing anything -------------------

printf '\n· the volume\n'

compose exec -T levix sh -c 'test -w /data' >/dev/null 2>&1
ok "/data is writable by that user on a fresh volume" "$?"

compose exec -T levix sh -c 'test -f /data/levix.db' >/dev/null 2>&1
ok "the database was created in /data" "$?"

# Nothing important may be written outside /data.
stray="$(compose exec -T levix sh -c 'ls -A /app/data /app/logs /app/memory 2>/dev/null | head -1' | tr -d '\r\n')"
if [ -z "$stray" ]; then status=0; else status=1; fi
ok "nothing was written next to the application code (found '${stray}')" "$status"

# --- claim it, then prove the claim survives -------------------------------

printf '\n· persistence\n'

# Docker's published-port NAT makes a request from the host arrive from the
# bridge gateway, so the panel correctly treats it as remote and asks for the
# one-time setup code. Claim through loopback inside the container instead;
# this test is about password persistence, while setup-code enforcement has
# its own panel coverage.
compose exec -T levix node --input-type=module -e '
  const password = process.argv[1];
  const response = await fetch("http://127.0.0.1:3001/setup", {
    method: "POST",
    body: new URLSearchParams({ password, confirm: password }),
    redirect: "manual",
  });
  process.exitCode = response.status === 303 ? 0 : 1;
' "$PASSWORD" >/dev/null 2>&1
ok "the first-run password can be set" "$?"

check_login() {
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "http://127.0.0.1:${PORT}/login" -d "password=${PASSWORD}")"
  [ "$code" = "303" ]
}

wait_for_panel() {
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

check_login
ok "the password works right away" "$?"

compose restart >/dev/null 2>&1 && wait_for_panel
ok "the panel comes back after 'compose restart'" "$?"
check_login
ok "…and the password survived it" "$?"

compose down >/dev/null 2>&1
compose up -d >/dev/null 2>&1 && wait_for_panel
ok "the panel comes back after 'down' then 'up'" "$?"
check_login
ok "…and the password survived that too" "$?"

# --- an upgrade: new image, same volume ------------------------------------

printf '\n· upgrading the image, keeping the volume\n'

compose build --no-cache >/dev/null 2>&1
compose up -d --force-recreate >/dev/null 2>&1 && wait_for_panel
ok "the panel comes back on a rebuilt image" "$?"
check_login
ok "…and the data survived the upgrade" "$?"

docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1
ok "the named volume still exists" "$?"

# --- the domain command knows where it is ----------------------------------

printf '\n· levix domain inside a container\n'

domain_out="$(compose exec -T levix node /app/bin/levix.js domain bot.example.com </dev/null 2>&1 | tr -d '\r')"
printf '%s' "$domain_out" | grep -qi "container"
ok "it detects the container and refuses to touch a web server" "$?"
printf '%s' "$domain_out" | grep -q "127.0.0.1:3001"
ok "…and prints the upstream to configure on the host" "$?"

# --- done ------------------------------------------------------------------

printf '\n%s\n' "════════════════════════════════════════════════════════════"
printf '  %s checks · %s failed\n\n' "$passed" "$failed"
[ "$failed" = "0" ]
