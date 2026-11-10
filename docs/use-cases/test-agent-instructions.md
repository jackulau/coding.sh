# Test an AGENTS.md, rule or skill change

You changed AGENTS.md, a rule or a skill, and want to know whether it helped. coding.sh
answers that from the sessions it has already recorded, or from tasks you give it. Some checks are
free and wait for new sessions. Others call a model now and cost a little.

## Pick a method

| Question | Command | Needs |
|---|---|---|
| What should I change first? | `coding.sh improve` | a week or so of sessions |
| Did a committed change help on real work? | `coding.sh improve check` | sessions before and after the commit |
| Does my uncommitted edit fix the moments the agent got wrong? | `coding.sh exp ab` | an Anthropic or OpenAI API key |
| Does a skill change what the agent does on whole tasks? | `coding.sh compare` | tasks, harness snapshots, agent and judge spend |
| Does the agent load my skill when it should? | `coding.sh eval trigger` | a `triggers.toml` of prompts |

## Before and after, on new sessions

```sh
coding.sh improve              # issues ranked, each with a line to add
coding.sh improve fix 1        # appends that line to AGENTS.md or the agent's own file, uncommitted
git commit AGENTS.md -m "AGENTS.md: run the tests before saying done"
coding.sh improve check        # after a few sessions
```

coding.sh records the git HEAD each session starts at. `improve check` compares the sessions before
a change with the sessions after it: the share of sessions with a failure flag, and, for each new
line that names a command, path or identifier, how often the agent did what it says. The verdicts
are Helped, Regressed, No clear change and Too early to tell. It makes no model calls. It exits 1 on
Regressed, so it can run in CI or a cron job.

## Replay the moments it went wrong

```sh
coding.sh exp ab --dry-run      # the decision points it found, and the cost estimate
coding.sh exp ab --max-cost 1
```

`exp ab` finds decision points in your recent sessions: the agent said it was done without running
anything, ended a turn while tests failed, or retried a failed command unchanged. For each one, the
model writes the agent's next turn twice, once with your committed file and once with your edit,
and a judge scores both. Nothing runs in your repo. The answer is "Ship it", "Hold" or "Don't
ship". `--gate` exits 0 only on "Ship it", and `--watch` reruns on every save. It needs
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. A Claude subscription is not enough.

## Run whole tasks with and without a skill

```sh
coding.sh harness snapshot --agent claude-code --dir arms/no-skill --name no-skill
coding.sh harness snapshot --agent claude-code --dir arms/with-skill --name with-skill
coding.sh compare no-skill with-skill --tag skill-eval --gate --k 3 --max-cost 15
```

`compare` runs the real agent on each task in both setups and grades every run. The pass-rate
difference comes with a 95% paired bootstrap interval, and the gate reads "Ship it", "Hold" or
"Don't ship". With `--without <path>` it removes one file from a setup and reads "Keep it" or
"Drop it". Use this when the skill's value is in behaviour across a whole task.

## Check that a skill loads

The agent loads a skill based on its `description`. `coding.sh eval trigger <skill-dir>` runs
prompts that should and should not load it and reports precision, recall and F1.
`--description "…"` tests a new description against the current one on the same prompts.

## What it does not do

- Small samples give wide answers. "Hold" and "No clear change" mean not proven, not no effect.
- Flags are heuristics. Open the example session before you act on an issue.
- `improve check` leaves out sessions with no recorded git HEAD.

## Questions

### Does this work for other agents' instruction files and Cursor rules?

Yes. `exp ab` and `improve check` read AGENTS.md, GEMINI.md, Claude Code's instructions file, rules under
`.claude/rules/` or `.cursor/rules/`, and a skill's SKILL.md.

### Can I test a draft without editing the repo?

`coding.sh exp ab --b drafts/AGENTS.md` tests a draft file against your current one.
`--a git:main --b .` compares a branch's files with your working tree.

### How many sessions do I need?

The gate needs 8 or more wins with no losses to say "Ship it". `improve check` says Too early to
tell with fewer than 5 sessions after a change.

## Next

- [Test an AGENTS.md change in five minutes](../how-to/test-agents-md-change.md)
- [Improve your agent every week](../guides/improve.md)
- [Evaluate an Agent Skill](../how-to/evaluate-a-skill.md)
- [Evals and comparisons](../guides/evals.md#ab-a-harness-edit-on-your-own-sessions)
