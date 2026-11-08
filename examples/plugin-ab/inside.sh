#!/bin/sh
# Runs inside the container as user eval. /work is the output dir; run.sh has put the two arms in
# /work/arms. Tasks and scripts are in /opt/plugin-ab.
set -eu
export CODING_SH_HOME=/work/csh CODING_SH_NO_UPDATE_CHECK=1
: "${K:=3}" "${C:=4}" "${MAX_COST:=40}" "${JUDGE:=1}" "${JUDGE_MODEL:=claude-sonnet-5-5}" "${MARKER:=}"
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ] || { echo "no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY" >&2; exit 2; }
AB=/opt/plugin-ab
cd /work
mkdir -p answers
claude --version
coding.sh --version

# Each verifier first saves the agent's final answer and stream for the analysis and the judge,
# then runs the task's hidden check, whose exit code is the pass.
rm -rf tasks
cp -R "$AB/tasks" tasks
for t in tasks/*/task.json; do
  python3 - "$t" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
save = ('cp "$CODING_SH_AGENT_OUTPUT" "/work/answers/$CODING_SH_RUN_ID.txt" 2>/dev/null || true; '
        'cp "$CODING_SH_AGENT_STDOUT" "/work/answers/$CODING_SH_RUN_ID.stdout.jsonl" 2>/dev/null || true; ')
d["verifier"]["command"] = save + d["verifier"]["command"]
json.dump(d, open(p, "w"), indent=2)
EOF
done

coding.sh harness snapshot --agent claude-code --file /work/arms/base/harness.toml
coding.sh harness snapshot --agent claude-code --file /work/arms/plugin/harness.toml
coding.sh eval import tasks/*/
sel="--tag plugin-ab"
[ -n "${ONLY:-}" ] && sel="--task $ONLY"
set +e
# shellcheck disable=SC2086
coding.sh compare base plugin $sel --k "$K" -c "$C" --max-cost "$MAX_COST" --trial-timeout 1200 \
  --gate --by suite: --yes --json > compare.json 2> compare.err
status=$?
set -e
echo "compare exit $status"
exp=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["experimentId"])' compare.json)
coding.sh compare base plugin --experiment "$exp" --gate --by suite: > compare.txt 2>&1 || true
cat compare.txt

python3 "$AB/analysis/runs.py" /work
if [ "$JUDGE" = 1 ]; then
  node --no-warnings "$AB/analysis/judge.ts" /work /work/tasks "$JUDGE_MODEL" || echo "judge failed; analysis runs without it" >&2
fi
if [ -n "$MARKER" ]; then
  python3 "$AB/analysis/analyze.py" /work --marker "$MARKER" | tee summary.txt
else
  python3 "$AB/analysis/analyze.py" /work | tee summary.txt
fi
