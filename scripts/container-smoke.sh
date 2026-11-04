#!/usr/bin/env bash
# Container smoke test (docs/40-plan/01-roadmap.md M6): the image starts as a non-root user,
# becomes healthy, answers through the console, survives docker stop / start without losing
# pending events, writes shutdown.json, and backs up from inside the container.
#
#   scripts/container-smoke.sh [image]        # default protea:dev
set -euo pipefail

IMAGE="${1:-protea:dev}"
NAME="protea-smoke-$$"
VOL="protea-smoke-$$"
PORT="${SMOKE_PORT:-17799}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  docker logs --tail 50 "$NAME" >&2 || true
  exit 1
}
step() { echo "--- $*"; }

wait_healthy() {
  for _ in $(seq 1 90); do
    state="$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)"
    [ "$state" = "healthy" ] && return 0
    [ "$state" = "unhealthy" ] && fail "container became unhealthy"
    sleep 1
  done
  fail "not healthy after 90 s"
}
p() { docker exec "$NAME" protea "$@"; }
# How many of the smoke test's "waiting" events are still pending.
waiting() { p events ls --state pending --limit 100 | grep -c 'smoke-held-' || true; }

step "start $IMAGE (echo provider, 1 CPU / 1 GB)"
docker volume create "$VOL" >/dev/null
docker run -d --name "$NAME" \
  -v "$VOL:/data" -p "127.0.0.1:$PORT:7788" \
  -e PROTEA_PROVIDERS__DEFAULT=echo \
  -e PROTEA_PLUGINS__SHELL__ENABLED=true \
  --health-interval 2s --health-start-period 5s \
  --memory 1g --cpus 1 --stop-timeout 40 \
  "$IMAGE" >/dev/null
wait_healthy
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || fail "/healthz from the host"

step "non-root: the daemon runs as uid 1000, /data belongs to it"
uid="$(docker top "$NAME" -o pid,uid,args | awk '/protea serve/ {print $2; exit}')"
[ "$uid" = "1000" ] || fail "daemon uid is '$uid', expected 1000"
[ "$(docker exec "$NAME" stat -c %u /data/protea.db)" = "1000" ] || fail "protea.db is not owned by uid 1000"

step "an out-of-process plugin runs under its limits (shell: open files 1024)"
for _ in $(seq 1 20); do
  spid="$(docker exec "$NAME" sh -c 'protea status --json | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const p=JSON.parse(s).plugins.find(x=>x.id===\"shell\");console.log(p&&p.state===\"running\"?p.pid:\"\")})"')"
  [ -n "$spid" ] && break
  sleep 1
done
[ -n "$spid" ] || fail "the shell plugin did not start"
nofile="$(docker exec "$NAME" sh -c "awk '/Max open files/ {print \$4 \" \" \$5}' /proc/$spid/limits")"
[ "$nofile" = "1024 1024" ] || fail "shell plugin open-files limit is '$nofile', expected '1024 1024'"
[ "$(docker exec "$NAME" sh -c "stat -c %u /proc/$spid")" = "1000" ] || fail "the plugin does not run as uid 1000"

step "a console message is answered"
out="$(p events push 'hello from the smoke test' --timeout 30)"
echo "$out" | grep -q 'hello from the smoke test' || fail "no echo reply: $out"

step "pending events survive docker stop / start"
p scheduler pause >/dev/null
for i in 1 2 3; do p events push "smoke-held-$i" --no-wait >/dev/null; done
before="$(waiting)"
t0=$(date +%s)
docker stop "$NAME" >/dev/null
echo "stopped in $(( $(date +%s) - t0 )) s"
docker run --rm -v "$VOL:/data" --entrypoint sh "$IMAGE" -c 'ls /data/runs/*/shutdown.json' >/dev/null || fail "no shutdown.json after docker stop"
docker start "$NAME" >/dev/null
wait_healthy
after="$(waiting)"
[ "$before" = "3" ] && [ "$after" = "3" ] || fail "waiting events before stop: '$before', after start: '$after' (expected 3)"
p scheduler resume >/dev/null
for _ in $(seq 1 30); do
  [ "$(waiting)" = "0" ] && break
  sleep 1
done
[ "$(waiting)" = "0" ] || fail "the waiting events were not delivered after resume"

step "backup from inside the container (online, owned by the protea user)"
# (Outputs are captured first: under pipefail, grep -q closing a pipe early fails the writer.)
bk="$(p backup --archive)"
echo "$bk"
grep -q 'backup written' <<<"$bk" || fail "backup failed"
[ "$(docker exec "$NAME" sh -c 'stat -c %u /data/backups/*.tar.gz')" = "1000" ] || fail "the backup is not owned by uid 1000"
listing="$(docker exec "$NAME" sh -c 'tar -tzf /data/backups/*.tar.gz')"
grep -q '/secrets' <<<"$listing" && fail "the backup contains secrets/"

step "migration and image facts"
logs="$(docker logs "$NAME" 2>&1)"
grep -q 'database schema v' <<<"$logs" || fail "the entrypoint did not run the migration step"
docker image inspect "$IMAGE" -f 'image size: {{.Size}} bytes'
echo "OK"
