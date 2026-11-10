# syntax=docker/dockerfile:1.7
#
# The Protea image (docs/10-architecture/16-deployment.md, ADR-0007).
#
#   docker build -t protea .                     # full: Node + Python + uv + git + rg + jq + curl
#   docker build -t protea:slim --target slim .  # Node only (no uvx MCP servers, no Python plugins)
#   docker build -t protea:browser --target browser .  # full + Chromium for the browser tools
#
# Stages: builder (install, build, deploy) → assets (what the daemon ships) → slim → full → browser.

ARG NODE_VERSION=22
ARG DEBIAN=trixie
ARG UV_VERSION=0.9.30
ARG PLAYWRIGHT_MCP_VERSION=0.0.85

# —— builder ——
FROM node:${NODE_VERSION}-${DEBIAN}-slim AS builder
# python3/make/g++ only for native modules without a prebuilt binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.3.0 && pnpm --version
ENV CI=1
WORKDIR /src
# Dependencies first, keyed on the lockfile only, so code changes reuse this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --offline \
 && pnpm build
# The CLI with its production dependencies (the daemon, Core, control plane, in-process plugins).
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @protea/cli deploy --prod --legacy /out/app
# Trim what the runtime never loads: sources, type declarations, source maps, other platforms'
# native binaries and the SQLite sources of better-sqlite3.
RUN cd /out/app/node_modules/.pnpm \
 && find . -type f \( -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.map' \) -delete \
 && arch="$(node -p 'process.arch')" \
 && for d in better-sqlite3@*/node_modules/better-sqlite3; do \
      rm -rf "$d/deps" "$d/src" "$d/build"; \
      find "$d/prebuilds" -type f ! -name "linux-${arch}.node" -delete; \
    done
# Shipped assets ($PROTEA_ASSETS_DIR): built-in out-of-process plugins, the default persona,
# built-in skills, the Python plugin SDK and the web console.
RUN set -e; A=/out/app/assets; mkdir -p "$A/plugins" "$A/sdks" "$A/apps/web"; \
    cp -r personas skills "$A/"; \
    cp -r sdks/python "$A/sdks/python"; \
    cp -r apps/web/dist "$A/apps/web/dist"; \
    for m in plugins/*/protea.plugin.json; do \
      d="$(dirname "$m")"; id="$(basename "$d")"; mkdir -p "$A/plugins/$id"; \
      for f in "$d"/*; do \
        case "$(basename "$f")" in src|test|node_modules|tsconfig*.json|package.json) ;; *) cp -r "$f" "$A/plugins/$id/" ;; esac; \
      done; \
    done; \
    find "$A" -name '__pycache__' -prune -exec rm -rf {} +

# —— uv (full image) ——
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# —— slim: Node only ——
FROM node:${NODE_VERSION}-${DEBIAN}-slim AS slim
ARG VERSION=0.1.0
LABEL org.opencontainers.image.title="protea" \
      org.opencontainers.image.description="24/7 event-stream personal assistant harness" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/leafliber/Protea"
ARG NPM_VERSION=12.2.1
ARG UNDICI_VERSION=6.29.1
RUN apt-get update \
 # Debian security updates published after the base image was built: CI's Trivy scan blocks on
 # fixable HIGH/CRITICAL findings (zlib1g, 2026-11), and the base image lags the archive.
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # npx stays (MCP servers); the npm bundled with the base image carries vulnerable dependencies,
 # and corepack/yarn are not used.
 && npm install -g "npm@${NPM_VERSION}" \
 # npm ${NPM_VERSION} still bundles undici 6.29.0 (CVE-2026-109383 and two others); 6.29.1 is the
 # compatible fix. Drop this once npm ships it.
 && cd /usr/local/lib/node_modules/npm/node_modules \
 && npm pack --silent "undici@${UNDICI_VERSION}" --pack-destination /tmp >/dev/null \
 && rm -rf undici && mkdir undici && tar -xzf "/tmp/undici-${UNDICI_VERSION}.tgz" -C undici --strip-components=1 \
 && rm -f /tmp/undici-*.tgz && cd / \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/corepack /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm \
 # The base image's uid/gid 1000 becomes "protea".
 && groupmod -n protea node && usermod -l protea -d /home/protea -m node \
 && mkdir -p /data /workspace /run/protea-sandbox \
 && chown protea:protea /data /workspace /run/protea-sandbox
ENV NODE_ENV=production \
    PROTEA_DATA_DIR=/data \
    PROTEA_ASSETS_DIR=/app/assets \
    PROTEA_IMAGE=slim \
    PROTEA_RUN_AS=1000:1000 \
    TZ=UTC
COPY --from=builder /out/app /app
COPY docker/entrypoint.sh /usr/local/bin/protea-entrypoint
RUN chmod 0755 /usr/local/bin/protea-entrypoint /app/dist/main.js \
 && ln -s /app/dist/main.js /usr/local/bin/protea
WORKDIR /data
VOLUME /data
EXPOSE 7788
# The daemon drains for up to daemon.shutdown.graceMs (25 s); run with --stop-timeout 40.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD ["protea", "healthcheck"]
ENTRYPOINT ["tini", "--", "protea-entrypoint"]
CMD ["serve"]

# —— full (default): + Python, uv/uvx, git, ripgrep, jq, curl ——
FROM slim AS full
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends python3 git ripgrep jq curl openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
ENV PROTEA_IMAGE=full

# —— browser: full + Chromium, for the bundled browser tools (ADR-0013) ——
FROM full AS browser
ARG PLAYWRIGHT_MCP_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PROTEA_IMAGE=browser
# The browser comes from the Playwright this version of the server was built against.
RUN npm install -g --no-fund --no-audit "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && apt-get update \
 && node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install --with-deps --no-shell chromium \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* /root/.npm \
 && chmod -R a+rX /ms-playwright

# The default target stays `full`: a plain `docker build .` takes the last stage.
FROM full
