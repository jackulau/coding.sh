# Sandbox for the plugin A/B: coding.sh built from this repo, a pinned Claude Code, and
# coding.sh's source for the judge script. Build from the repo root (run.sh does):
#   docker build -f examples/plugin-ab/Dockerfile .
FROM node:24-bookworm-slim AS build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /src
COPY . .
RUN npm ci -w coding.sh && npm run build -w coding.sh && mkdir /pack && npm pack --silent --pack-destination /pack -w coding.sh

FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.319
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /pack/ /tmp/pack/
RUN npm install -g /tmp/pack/*.tgz "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && rm -rf /tmp/pack /root/.npm
COPY --from=build /src/packages/coding.sh/src/ /opt/coding.sh-src/
COPY examples/plugin-ab/ /opt/plugin-ab/
# Claude Code refuses --permission-mode bypassPermissions as root.
RUN useradd -m -u 10001 eval && git config --system user.name eval && git config --system user.email eval@example.test
USER eval
ENV CODING_SH_SRC=/opt/coding.sh-src
WORKDIR /home/eval
ENTRYPOINT ["sh", "/opt/plugin-ab/inside.sh"]
