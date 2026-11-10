#!/usr/bin/env bash
# Build the Protea image locally (docs/10-architecture/16-deployment.md §1).
#
#   scripts/docker-build.sh            # full image: protea:latest, protea:<version>, protea:<version>-<sha>
#   scripts/docker-build.sh slim       # slim image: protea:slim, protea:<version>-slim
#   scripts/docker-build.sh browser    # with Chromium: protea:browser, protea:<version>-browser
#   scripts/docker-build.sh all        # all three
#
# Environment: IMAGE (repository name, default protea), PLATFORM (e.g. linux/amd64; default the
# host's), DOCKER (docker binary). The revision label comes from git; a dirty tree adds "-dirty".
set -euo pipefail

cd "$(dirname "$0")/.."
target="${1:-full}"
image="${IMAGE:-protea}"
docker_bin="${DOCKER:-docker}"
if ! command -v "$docker_bin" >/dev/null 2>&1 && [ -x "$HOME/.docker/bin/docker" ]; then
  docker_bin="$HOME/.docker/bin/docker" # Docker Desktop on macOS without the CLI on PATH
fi

version="$(node -p "require('./package.json').version")"
sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then sha="${sha}-dirty"; fi
created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

build() {
  local stage="$1"; shift
  local tags=()
  for t in "$@"; do tags+=(-t "$image:$t"); done
  echo "==> building $stage: ${*/#/$image:}"
  "$docker_bin" build \
    --target "$stage" \
    ${PLATFORM:+--platform "$PLATFORM"} \
    --build-arg "VERSION=$version" \
    --label "org.opencontainers.image.revision=$sha" \
    --label "org.opencontainers.image.created=$created" \
    "${tags[@]}" \
    .
}

case "$target" in
  full) build full latest "$version" "$version-$sha" ;;
  slim) build slim slim "$version-slim" "$version-$sha-slim" ;;
  browser) build browser browser "$version-browser" "$version-$sha-browser" ;;
  all)
    build full latest "$version" "$version-$sha"
    build slim slim "$version-slim" "$version-$sha-slim"
    build browser browser "$version-browser" "$version-$sha-browser"
    ;;
  *) echo "usage: $0 [full|slim|browser|all]" >&2; exit 2 ;;
esac
echo "==> done. Run it: docker run -d --name protea -v protea-data:/data -p 127.0.0.1:7788:7788 --stop-timeout 40 --restart unless-stopped $image:latest"
