# Case study: evaluating the vercel-security-audit skill

We used coding.sh to test a third-party Agent Skill:
[vercel-security-audit](https://github.com/DarlingtonDeveloper/vercel-security-audit) by
DarlingtonDeveloper (MIT). It guides an agent through a read-only review of a Vercel team's security
settings. The skill ships 13 behaviour scenarios in `evals/scenarios.md` that, as far as we know,
had not been run against a live agent. We turned 12 of them into coding.sh tasks and ran Claude Code
with and without the skill.

Everything to reproduce it is in [examples/skill-eval](../../examples/skill-eval). The general
recipe is [Evaluate an Agent Skill](../how-to/evaluate-a-skill.md).

**Status: the pipeline is built and checked end to end with a fake agent. The live run has not
happened yet: the machine it runs on has no Claude credentials.** The live section below says what
it needs.

## Setup

| | |
|---|---|
| Skill | commit `c219b212`, fetched and hash-checked at run time, not copied into this repo |
| Arm A | Claude Code 2.1.310, no project files |
| Arm B | the same, plus the whole skill directory at `.claude/skills/vercel-security-audit` |
| Model | `claude-sonnet-5-5` for both arms and the judge |
| Tasks | 12, one per scenario, in 6 suites: scope (2), interpretation (4), privacy (1), read-only (2), coverage (2), delivery (1) |
| Account | none. A stub `vercel` CLI answers from a synthetic team, `harbor-synth`, and refuses every write |
| Sandbox | a Docker container that sees only its output directory and the model key |
| Budget | `--max-cost 15` (USD, agent plus judge) |

Each run is graded in two steps. First a script checks the stub's call log, the agent's tool calls
and every file it saved. It fails the run on a forbidden command (`vercel env pull`, firewall
publish, deploys, logins, sending mail, installing packages), on reading account data when the
scenario says to stop first, and on any fixture secret (an email, a token name, a firewall value)
in the answer or a saved file. If that passes, an LLM judge answers the scenario's pass criteria as
a yes/no checklist, with critical items that must pass.

Scenario 13 is left out. It asks whether a non-specialist can act on a finished report, which needs
a real collection pass, a sanitised evidence bundle and a person from that audience to read it.

## Dry run

Before spending money, the whole pipeline ran with a scripted fake `claude` and the offline mock
judge. The fake agent's behaviour is written by us, so its pass and fail numbers say nothing about
the skill or about Claude Code, and we don't publish them as results. What the dry run checked:

- Every deterministic check fires on the mistake it targets (a forbidden command, reading account
  data before scope is agreed, a fixture secret in a saved file) and none fires on a clean run.
- The skill loads in every arm-B run, which the one-item gate needs.
- Judge calls are counted, priced and skipped after a failed check, and `--max-cost` stops the run
  at the cap without dropping the comparison.
- With 12 tasks, every per-suite gate reads Hold and the minimum detectable effect is about 40
  points, so a run worth acting on needs `--k 3` and more scenarios per suite.

## What we fixed in coding.sh

The eval needed things coding.sh did not do. Each landed with tests:

- `coding.sh eval import <dir>...` loads hand-written tasks (`task.json`, `instruction.md`, `repo/`,
  `tests/`). Before, a task could only come from a captured session.
- Verifiers get the agent's final answer and full stdout (`CODING_SH_AGENT_OUTPUT`,
  `CODING_SH_AGENT_STDOUT`), so they can grade what the agent said and ran, not only the files.
- `coding.sh judge grade` runs any grader, including an LLM checklist with trace checks, from
  inside a verifier, and records each judge call.
- `compare --tag` runs imported draft tasks. `compare --max-cost` caps spend. The report shows
  `agent spend` and `grader spend` rows.
- `compare` writes the hook script when it is missing. Without it, runs in a fresh store were not
  captured and the item gate could only say RERUN.
- Per-task rows show task names instead of ids.

## Live run

Not run. The desktop that runs heavy jobs has no Claude Code login, and we did not want to copy a
personal `~/.claude` into a container running third-party scripts. To run it:

1. Create an Anthropic API key with a spend limit of about $20 in the console. The agent and the
   judge both use it.
2. On the machine with Docker, put it in a file only you can read:
   `printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" > anthropic.env && chmod 600 anthropic.env`
3. `examples/skill-eval/run.sh <out-dir> --env-file anthropic.env`

That is 24 agent sessions at `k=1`, stopped at $15. Read `agent spend` per run in the report before
sizing a bigger run. For a result worth acting on, use `--k 3` and add scenarios until each suite has
8 or more: the gate needs 8 wins with no losses to ship.
