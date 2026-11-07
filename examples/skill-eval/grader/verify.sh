#!/bin/sh
# Verifier for one skill-eval task. Runs in the work tree, where the task's hidden
# grader/ dir (checks.json, checklist.json) has just been written.
#   1. check.py: deterministic checks (forbidden commands, scope, redaction).
#   2. coding.sh judge grade: the scenario's LLM checklist over the answer, any
#      saved report and the tool-call trace. Skipped when step 1 already failed,
#      so a run that broke a hard rule costs no judge call.
# SKILL_EVAL_JUDGE=mock swaps the judge for coding.sh's offline mock provider.
# SKILL_EVAL_JUDGE=skip (no ANTHROPIC_API_KEY) grades on step 1 alone.
set -u
here=$(cd "$(dirname "$0")" && pwd)
python3 "$here/check.py" grader/checks.json || { echo "deterministic checks failed; judge skipped"; exit 1; }
if [ "${SKILL_EVAL_JUDGE:-}" = skip ]; then
  echo "judge skipped: no ANTHROPIC_API_KEY, graded on the deterministic checks only"
  exit 0
fi
checklist=grader/checklist.json
if [ "${SKILL_EVAL_JUDGE:-}" = mock ]; then
  python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); c["provider"]="mock"; c.pop("model",None); json.dump(c,open(sys.argv[2],"w"))' "$checklist" grader/checklist.mock.json
  checklist=grader/checklist.mock.json
fi
exec coding.sh judge grade --grader "$checklist" --output "$(dirname "$CODING_SH_AGENT_OUTPUT")/graded.txt"
