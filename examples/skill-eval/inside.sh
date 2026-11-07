#!/bin/sh
# Runs inside the container (see run.sh). /work is the host's output dir.
#   MODEL     agent model for both arms (default claude-sonnet-5-5)
#   K         attempts per task and arm (default 1)
#   MAX_COST  spend cap in USD, agent plus judge (default 15)
#   SKILL_EVAL_DRY_RUN=1  fake agent and mock judge: tests the pipeline for $0
set -eu
: "${MODEL:=claude-sonnet-5-5}" "${K:=1}" "${MAX_COST:=15}"
export CODING_SH_HOME=/work/csh VSTUB_STATE=/work/vstub SKILL_EVAL_OUT=/work/out/checks CODING_SH_NO_UPDATE_CHECK=1
if [ "${SKILL_EVAL_DRY_RUN:-}" = 1 ]; then
  export PATH="$SKILL_EVAL/dry-run/bin:$PATH" SKILL_EVAL_JUDGE=mock
elif [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "No model auth. Pass ANTHROPIC_API_KEY (used by the agent and the judge) with --env-file." >&2
  exit 2
fi
mkdir -p /work/out
sh "$SKILL_EVAL/fetch-skill.sh" /work/skill

# Arm A: no project files. Arm B: the whole skill directory at project scope.
rm -rf /work/arms
mkdir -p /work/arms/no-skill/.claude /work/arms/with-skill/.claude/skills
cp -R /work/skill/vercel-security-audit /work/arms/with-skill/.claude/skills/
coding.sh harness snapshot --agent claude-code --dir /work/arms/no-skill --name no-skill --model "$MODEL"
coding.sh harness snapshot --agent claude-code --dir /work/arms/with-skill --name with-skill --model "$MODEL"
coding.sh eval import "$SKILL_EVAL"/tasks/*/

set +e
coding.sh compare no-skill with-skill --tag skill-eval --gate --by suite: --k "$K" --max-cost "$MAX_COST" --yes --json > /work/out/compare.json
status=$?
set -e
exp=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["experimentId"])' /work/out/compare.json)
coding.sh compare no-skill with-skill --experiment "$exp" --gate --by suite: > /work/out/compare.txt 2>&1 || true
cat /work/out/compare.txt
echo "experiment $exp, gate exit $status"
