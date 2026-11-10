#!/usr/bin/env bash
# The sandbox container and the bundled browser, for real (ADR-0013). Mirrors docker-compose.yml
# plus docker-compose.browser.yml with plain `docker run`.
#
#   scripts/sandbox-smoke.sh <browser-image>
#
# Environment: DOCKER (docker binary), NO_CHROMIUM_SANDBOX=1 when the host cannot give Chromium
# its own sandbox (the check that it is on is then skipped).
set -euo pipefail

IMAGE="${1:?usage: sandbox-smoke.sh <browser-image>}"
export PATH="$HOME/.docker/bin:$PATH"
cd "$(dirname "$0")/.."
ID="$$"
MAIN="protea-smoke-main-$ID"
SBX="protea-smoke-sbx-$ID"
NET="protea-smoke-sbx-net-$ID"
MAINNET="protea-smoke-main-net-$ID"
VOLS=(data workspace browser home run)
vol() { echo "protea-smoke-$ID-$1"; }

cleanup() {
  docker rm -f "$MAIN" "$SBX" >/dev/null 2>&1 || true
  for v in "${VOLS[@]}"; do docker volume rm -f "$(vol "$v")" >/dev/null 2>&1 || true; done
  docker network rm "$NET" "$MAINNET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
step() { echo "--- $*"; }
fail() {
  echo "FAILED: $*" >&2
  docker logs --tail 40 "$MAIN" >&2 || true
  docker logs --tail 40 "$SBX" >&2 || true
  exit 1
}

docker network create "$NET" >/dev/null
docker network create "$MAINNET" >/dev/null
HARDEN=(--security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL)

start_sandbox() {
  docker run -d --name "$SBX" --network "$NET" "${HARDEN[@]}" --no-healthcheck \
    -v "$(vol home):/home/protea" -v "$(vol workspace):/workspace" -v "$(vol browser):/workspace/browser:ro" -v "$(vol run):/run/protea-sandbox" \
    "$IMAGE" sandbox serve >/dev/null
}

step "start both containers"
start_sandbox
docker run -d --name "$MAIN" --network "$MAINNET" "${HARDEN[@]}" \
  --security-opt seccomp=docker/seccomp-chromium.json --shm-size 512m --memory 2g --pids-limit 1024 \
  -v "$(vol data):/data" -v "$(vol workspace):/data/workspace" -v "$(vol browser):/data/workspace/browser" -v "$(vol run):/run/protea-sandbox:ro" \
  -e PROTEA_PROVIDERS__DEFAULT=echo -e PROTEA_PLUGINS__SHELL__ENABLED=true \
  --health-interval 2s --health-start-period 5s --stop-timeout 40 \
  "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$MAIN")" = "healthy" ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$MAIN")" = "healthy" ] || fail "the daemon is not healthy"

sh_() { docker exec "$MAIN" protea sandbox run "$1"; }
for _ in $(seq 1 30); do sh_ true >/dev/null 2>&1 && break; sleep 1; done
sh_ true >/dev/null || fail "the sandbox agent does not answer"

step "non-root, no capabilities, no secrets, none of Protea's data"
[ "$(sh_ 'id -u')" = "1000" ] || fail "commands do not run as uid 1000"
[ "$(sh_ 'grep CapEff /proc/self/status | cut -f2')" = "0000000000000000" ] || fail "commands have capabilities"
# The image declares /data a volume, so the directory exists; it must be an empty one of its own.
[ "$(sh_ 'ls -A /data 2>/dev/null | wc -l')" = "0" ] || fail "Protea's data is visible in the sandbox"
if sh_ 'env' | grep -qE 'PROVIDER_|PROTEA_ADMIN|API_KEY'; then fail "secrets in the environment"; fi

step "no route to the control plane"
main_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$MAINNET\").IPAddress}}" "$MAIN")"
[ -n "$main_ip" ] || fail "no address for the daemon"
if sh_ "curl -sS -m 4 http://$main_ip:7788/healthz" >/dev/null 2>&1; then fail "the sandbox reached the control plane"; fi

step "the shell keeps going, also across a restart of the daemon and of the sandbox"
sh_ 'mkdir -p /workspace/proj && cd /workspace/proj && export SMOKE=kept' >/dev/null
[ "$(sh_ 'echo "$PWD $SMOKE"')" = "/workspace/proj kept" ] || fail "state did not carry over"
docker restart -t 40 "$MAIN" >/dev/null
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$MAIN")" = "healthy" ] && break; sleep 1; done
[ "$(sh_ 'echo "$PWD $SMOKE"')" = "/workspace/proj kept" ] || fail "state did not survive a daemon restart"
docker restart -t 10 "$SBX" >/dev/null
for _ in $(seq 1 30); do sh_ true >/dev/null 2>&1 && break; sleep 1; done
[ "$(sh_ 'echo "$PWD $SMOKE"')" = "/workspace/proj kept" ] || fail "state did not survive a sandbox restart"

step "a stop reaches the processes (tini can signal them)"
if docker logs "$MAIN" 2>&1 | grep -q 'FATAL tini'; then fail "tini could not forward the signal to the daemon"; fi
if docker logs "$SBX" 2>&1 | grep -q 'FATAL tini'; then fail "tini could not forward the signal to the agent"; fi
docker exec "$MAIN" sh -c 'ls /data/runs/*/shutdown.json' >/dev/null || fail "the daemon did not shut down cleanly on restart"

step "what is shared and what is not"
sh_ 'echo hello > /workspace/from-sandbox' >/dev/null
[ "$(docker exec "$MAIN" cat /data/workspace/from-sandbox)" = "hello" ] || fail "the workspace is not shared"
docker exec "$MAIN" sh -c 'echo shot > /data/workspace/browser/shot.txt'
[ "$(sh_ 'cat /workspace/browser/shot.txt')" = "shot" ] || fail "the browser files are not visible in the sandbox"
if sh_ 'touch /workspace/browser/planted 2>/dev/null' >/dev/null 2>&1; then fail "the sandbox can write the browser's files"; fi

step "the browser server starts, without the tool that runs code in its own process"
docker exec "$MAIN" protea mcp preset browser >/dev/null || fail "the browser server did not start"
tools="$(docker exec "$MAIN" protea mcp tools browser)"
grep -q browser_navigate <<<"$tools" || fail "no browser_navigate: $tools"
if grep -v filtered <<<"$tools" | grep -q browser_run_code_unsafe; then fail "browser_run_code_unsafe is offered: $tools"; fi

step "a page opens, a screenshot comes back, local files stay closed"
cat scripts/browser-probe.mjs | docker exec -i -u 1000 -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright "$MAIN" node --input-type=module - "${NO_CHROMIUM_SANDBOX:+--no-sandbox}" || fail "the browser probe failed"

echo "OK"
