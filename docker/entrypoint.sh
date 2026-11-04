#!/bin/sh
# Protea container entrypoint (docs/10-architecture/16-deployment.md §5). tini is PID 1 and
# runs this script; it ends by exec-ing the daemon, so tini forwards SIGTERM straight to it.
#
#   1. As root: create /data and hand it to the protea user (only when the owner differs),
#      then re-run this script as that user.
#   2. Create the data directories and caches.
#   3. Migrate the SQLite schema (a snapshot of the old database is kept first).
#   4. exec protea serve.
#
# Any other command runs as the protea user: `docker run … protea status`, `… sh`.
set -eu

DATA="${PROTEA_DATA_DIR:-/data}"
RUN_AS="${PROTEA_RUN_AS:-1000:1000}"
uid="${RUN_AS%%:*}"
gid="${RUN_AS##*:}"

if [ "$(id -u)" = "0" ] && [ "${PROTEA_ALLOW_ROOT:-0}" != "1" ]; then
  mkdir -p "$DATA"
  if [ "$(stat -c %u:%g "$DATA")" != "$uid:$gid" ]; then
    echo "protea-entrypoint: giving $DATA to uid $uid (it belonged to $(stat -c %u:%g "$DATA"))" >&2
    chown -R "$uid:$gid" "$DATA"
  fi
  export HOME="${PROTEA_HOME:-/home/protea}"
  exec setpriv --reuid="$uid" --regid="$gid" --init-groups "$0" "$@"
fi

if ! [ -w "$DATA" ]; then
  echo "protea-entrypoint: $DATA is not writable by uid $(id -u); fix its owner or run the container as root so the entrypoint can" >&2
  exit 1
fi

# npx/uvx/pip caches live on the volume, so MCP servers do not download again after a restart.
mkdir -p "$DATA/cache/npm" "$DATA/cache/uv" "$DATA/cache/pip" "$DATA/workspace"
export npm_config_cache="${npm_config_cache:-$DATA/cache/npm}"
export npm_config_update_notifier=false
export UV_CACHE_DIR="${UV_CACHE_DIR:-$DATA/cache/uv}"
export UV_TOOL_DIR="${UV_TOOL_DIR:-$DATA/cache/uv/tools}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$DATA/cache/uv/python}"
export PIP_CACHE_DIR="${PIP_CACHE_DIR:-$DATA/cache/pip}"

if [ "$#" -eq 0 ]; then set -- serve; fi
case "$1" in
  serve)
    shift
    # Fails (and the container exits) when the database is newer than this image or a
    # migration fails; the original file is left in place.
    protea migrate --data-dir "$DATA"
    exec protea serve --data-dir "$DATA" "$@"
    ;;
  protea)
    shift
    exec protea "$@"
    ;;
  -*|status|events|batches|sessions|forks|plugins|mcp|skills|approvals|config|secrets|scheduler|budget|memory|persona|logs|logq|runs|audit|backup|restore|replay|migrate|healthcheck)
    exec protea "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
