# Sandbox for the skill eval: coding.sh built from this repo, Claude Code, Python
# for the skill's scripts, and the stub `vercel` first on PATH. Build from the
# repo root (run.sh does): docker build -f examples/skill-eval/Dockerfile .
# Live mode (run.sh --live) also uses the real Vercel CLI in /opt/vercel-cli, which
# only the vproxy user can run, behind the read-only proxy in live/.
FROM node:24-bookworm-slim AS build
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /src
COPY . .
RUN npm ci -w coding.sh && npm run build -w coding.sh && mkdir /pack && npm pack --silent --pack-destination /pack -w coding.sh

FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.310
ARG VERCEL_CLI_VERSION=65.3.1
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
RUN apt-get update && apt-get install -y --no-install-recommends python3 git curl ca-certificates sudo && rm -rf /var/lib/apt/lists/*
COPY --from=build /pack/ /tmp/pack/
RUN npm install -g /tmp/pack/*.tgz "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && rm -rf /tmp/pack /root/.npm
RUN useradd -r -m -u 10002 -d /var/lib/vproxy -s /usr/sbin/nologin vproxy \
 && npm install --prefix /opt/vercel-cli "vercel@${VERCEL_CLI_VERSION}" && rm -rf /root/.npm \
 && chown -R root:vproxy /opt/vercel-cli && chmod 750 /opt/vercel-cli
COPY examples/skill-eval/ /opt/skill-eval/
# Claude Code refuses --permission-mode bypassPermissions as root.
# In live mode eval may run only the proxy and the leak check as vproxy, keeping
# CODING_SH_RUN_ID so the proxy logs to the right run.
RUN useradd -m -u 10001 eval && git config --system user.name eval && git config --system user.email eval@example.test \
 && printf '%s\n' 'Defaults:eval env_keep += "CODING_SH_RUN_ID"' \
    'eval ALL=(vproxy) NOPASSWD: /opt/skill-eval/live/vercel-live, /opt/skill-eval/live/leaks' > /etc/sudoers.d/skill-eval \
 && chmod 440 /etc/sudoers.d/skill-eval && visudo -cq
USER eval
ENV SKILL_EVAL=/opt/skill-eval PATH=/opt/skill-eval/bin:$PATH
WORKDIR /home/eval
ENTRYPOINT ["sh", "/opt/skill-eval/inside.sh"]
