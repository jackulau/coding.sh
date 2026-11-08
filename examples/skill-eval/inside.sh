#!/bin/sh
# Runs inside the container (see run.sh). /work is the host's output dir.
#   MODEL     agent model for both arms (default claude-sonnet-5-5)
#   K         attempts per task and arm (default 1)
#   MAX_COST  spend cap in USD, agent plus judge (default 15)
#   SKILL_EVAL_DRY_RUN=1  fake agent and mock judge: tests the pipeline for $0
#   SKILL_EVAL_LIVE=1     set by live/entry.sh: the real Vercel team behind the
#                         read-only proxy, and only the tasks that can run live
#   SKILL_EVAL_CANDIDATE=1  arm A is the pinned skill and arm B the edited copy in
#                         /candidate (run.sh --candidate), instead of no skill and skill
#   TASKS                 task number prefixes to run, e.g. "01 06" (default: all)
set -eu
: "${MODEL:=claude-sonnet-5-5}" "${K:=1}" "${MAX_COST:=15}"
export CODING_SH_HOME=/work/csh VSTUB_STATE=/work/vstub SKILL_EVAL_OUT=/work/out/checks CODING_SH_NO_UPDATE_CHECK=1
if [ "${SKILL_EVAL_DRY_RUN:-}" = 1 ]; then
  export PATH="$SKILL_EVAL/dry-run/bin:$PATH" SKILL_EVAL_JUDGE=mock
elif [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "No model auth. Pass ANTHROPIC_API_KEY (agent and judge) or CLAUDE_CODE_OAUTH_TOKEN (agent only) with --env-file." >&2
  exit 2
elif [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  export SKILL_EVAL_JUDGE=skip
  echo "No ANTHROPIC_API_KEY: the LLM judge is skipped. Runs are graded by the deterministic checks only."
fi
mkdir -p /work/out
sh "$SKILL_EVAL/fetch-skill.sh" /work/skill

tasks=$(ls -d "$SKILL_EVAL"/tasks/*/)
tag=skill-eval
if [ "${SKILL_EVAL_LIVE:-}" = 1 ]; then
  # `vercel` is now the proxy. The live copies of the tasks refer to the real team,
  # project and site through $VERCEL_SCOPE, $VERCEL_PROJECT and $LIVE_SITE, and have
  # their own names and the tag `live`, so a store that also holds the stub tasks runs
  # only these.
  export PATH="$SKILL_EVAL/live/bin:$PATH"
  tasks=$(python3 "$SKILL_EVAL/live/tasks" /work/live-tasks)
  tag=live
fi
if [ -n "${TASKS:-}" ]; then
  picked=
  for t in $tasks; do
    for want in $TASKS; do
      case "$(basename "$t")" in "$want"*) picked="$picked $t"; break ;; esac
    done
  done
  [ -n "$picked" ] || { echo "TASKS=$TASKS matches no task." >&2; exit 2; }
  tasks=$picked
fi

# Arm A: no project files. Arm B: the whole skill directory at project scope.
# With a candidate, arm A is the skill and arm B the candidate, at the same path.
rm -rf /work/arms
mkdir -p /work/arms/no-skill/.claude /work/arms/with-skill/.claude/skills
cp -R /work/skill/vercel-security-audit /work/arms/with-skill/.claude/skills/
coding.sh harness snapshot --agent claude-code --dir /work/arms/with-skill --name with-skill --model "$MODEL"
if [ "${SKILL_EVAL_CANDIDATE:-}" = 1 ]; then
  mkdir -p /work/arms/candidate/.claude/skills
  cp -R /candidate /work/arms/candidate/.claude/skills/vercel-security-audit
  coding.sh harness snapshot --agent claude-code --dir /work/arms/candidate --name candidate --model "$MODEL"
  set -- with-skill candidate --promote
else
  coding.sh harness snapshot --agent claude-code --dir /work/arms/no-skill --name no-skill --model "$MODEL"
  set -- no-skill with-skill
fi
# shellcheck disable=SC2086 # $tasks is a glob or a newline-separated list of dirs
coding.sh eval import $tasks

set +e
coding.sh compare "$@" --tag "$tag" --gate --by suite: --k "$K" --max-cost "$MAX_COST" --yes --json > /work/out/compare.json
status=$?
set -e
exp=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["experimentId"])' /work/out/compare.json)
coding.sh compare "$@" --experiment "$exp" --gate --by suite: > /work/out/compare.txt 2>&1 || true
cat /work/out/compare.txt
echo "experiment $exp, gate exit $status"
