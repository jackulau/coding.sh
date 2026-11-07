# syntax=docker/dockerfile:1
# coding.sh serve: the production observability server. Point it at a database:
#   docker build -t coding-sh .
#   docker run -p 4318:4318 -e CODING_SH_STORE_URL=postgres://… \
#     -e CODING_SH_INGEST_KEYS=myapp:csh_ik_… -e CODING_SH_READ_KEYS='*:csh_rk_…' coding-sh
# The image refuses to start without keys (or --insecure). See docs/production/README.md.
#
# PLUGINS picks the store drivers baked in. Leave it empty for a lean SQLite-only image:
#   docker build --build-arg PLUGINS= -t coding-sh:sqlite .

# ---- build: compile coding.sh, pack it with its store plugins, install their prod deps
FROM node:22-bookworm-slim AS build
ARG PLUGINS="coding.sh-store-postgres coding.sh-store-s3"
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
WORKDIR /app
COPY --from=build /app /app
# Writable home for sqlite mode, the writer lock and caches. Mount a volume here (compose, Fly);
# no VOLUME instruction, because some platforms (Railway) reject it.
COPY --from=build --chown=65532:65532 /data /data
ENV NODE_ENV=production \
    CODING_SH_HOME=/data \
    CODING_SH_HOST=0.0.0.0
EXPOSE 4318
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD ["/nodejs/bin/node","/app/cli.mjs","serve","healthcheck"]
CMD ["/app/cli.mjs","serve"]
