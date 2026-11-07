# Sandbox for the skill eval: coding.sh built from this repo, Claude Code, Python
# for the skill's scripts, and the stub `vercel` first on PATH. Build from the
# repo root (run.sh does): docker build -f examples/skill-eval/Dockerfile .
FROM node:24-bookworm-slim AS build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /src
COPY . .
RUN npm ci -w coding.sh && npm run build -w coding.sh && mkdir /pack && npm pack --silent --pack-destination /pack -w coding.sh

FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.310
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN apt-get update && apt-get install -y --no-install-recommends python3 git curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /pack/ /tmp/pack/
RUN npm install -g /tmp/pack/*.tgz "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && rm -rf /tmp/pack /root/.npm
COPY examples/skill-eval/ /opt/skill-eval/
# Claude Code refuses --permission-mode bypassPermissions as root.
RUN useradd -m -u 10001 eval && git config --system user.name eval && git config --system user.email eval@example.test
USER eval
ENV SKILL_EVAL=/opt/skill-eval PATH=/opt/skill-eval/bin:$PATH
WORKDIR /home/eval
ENTRYPOINT ["sh", "/opt/skill-eval/inside.sh"]
