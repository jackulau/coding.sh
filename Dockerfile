# syntax=docker/dockerfile:1
# coding.sh serve: ingest (OTLP and native), the viewer and the API on one port, 4318.
#   docker build -t coding-sh .
#   docker run -d --name coding-sh -p 4318:4318 -v coding-sh:/data coding-sh
#   docker logs coding-sh        # the read key, the ingest key and how to connect
# With no keys configured, the first start makes a key pair and keeps it in /data/serve-keys.json.
# Set CODING_SH_INGEST_KEYS and CODING_SH_READ_KEYS (and CODING_SH_STORE_URL=postgres://…) to use
# your own keys and database. See docs/how-to/self-host-team.md and docs/production/README.md.
#
# PLUGINS picks the store drivers baked in. Leave it empty for a lean SQLite-only image:
#   docker build --build-arg PLUGINS= -t coding-sh:sqlite .

# ---- build: compile coding.sh, pack it with its store plugins, install their prod deps.
# Everything here is plain JavaScript, so it runs on the build machine's own platform and the
# result is copied into each target platform's runtime image (no emulated npm for arm64).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
ARG PLUGINS="coding.sh-store-postgres coding.sh-store-s3 coding.sh-store-clickhouse"
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /src
COPY . .
RUN set -eu; ws="-w coding.sh"; for p in $PLUGINS; do ws="$ws -w $p"; done; \
    npm ci $ws; \
    npm run build --if-present $ws; \
    mkdir /pack; npm pack --silent --pack-destination /pack $ws
# A real install from the packed tarballs: the same layout `npm i coding.sh coding.sh-store-postgres`
# gives a user, so plugins resolve from /app/node_modules with no registration.
WORKDIR /app
RUN set -eu; \
    printf '{"name":"coding-sh-server","private":true,"type":"module"}\n' > package.json; \
    npm install --omit=dev --no-save --no-package-lock /pack/*.tgz; \
    cp node_modules/coding.sh/dist/*.mjs ./; \
    node cli.mjs --version; \
    for p in $PLUGINS; do node --input-type=module -e "await import('$p')"; done; \
    rm -rf /root/.npm; mkdir -p /data

# ---- runtime: distroless, nonroot, no shell, no package manager
FROM gcr.io/distroless/nodejs22-debian12:nonroot
ARG VERSION=dev
LABEL org.opencontainers.image.title="coding.sh" \
      org.opencontainers.image.description="coding.sh serve: local-first observability and evals for AI agents, self-hosted" \
      org.opencontainers.image.source="https://github.com/jackulau/coding.sh" \
      org.opencontainers.image.documentation="https://coding.sh/docs/how-to/self-host-team" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
COPY --from=build /app /app
# Writable home for sqlite mode, the first-start keys, the writer lock and caches. Mount a volume
# here (docker run -v, compose, Fly); no VOLUME instruction, because some platforms (Railway) reject it.
COPY --from=build --chown=65532:65532 /data /data
ENV NODE_ENV=production \
    CODING_SH_HOME=/data \
    CODING_SH_HOST=0.0.0.0
EXPOSE 4318
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/nodejs/bin/node","/app/cli.mjs","serve","healthcheck"]
CMD ["/app/cli.mjs","serve"]
