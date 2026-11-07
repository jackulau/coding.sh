# Turn a real session into an eval

When an agent gets something wrong, or right after a struggle, keep it as a test so the next
change to your prompt, harness or model is checked against it. There are two kinds:

- **A repo task** replays the session's starting repo and checks the result with a command. Use it
  for coding work.
- **A dataset case** keeps the session's first prompt as input. Use it for any agent, including
  your own agent traced over OpenTelemetry or the SDK, graded by a check, a judge or your own script.

## Repo task: from a session to a validated task

A repo task needs the repo as it was when the session started. `coding.sh run --` snapshots it
before and after the command, so record the run with it. (Sessions captured only by hooks have no
snapshot yet; drafting from them fails with `draft_failed: ... has no repo state`.)

```sh
cd coding.sh
coding.sh run -- claude -p 'Fix the failing test in packages/coding.sh/test/cli/output.test.ts'
```

Draft a task from it. The verifier must pass only when the work is done. Test files the session
changed and that match `--hidden-test` are taken out of the reference diff and copied in only when
the verifier runs, so the agent never sees the final tests:

```sh
coding.sh eval new latest --name output-test-fix \
  --verifier 'node --no-warnings --test packages/coding.sh/test/cli/output.test.ts' \
  --hidden-test 'packages/coding.sh/test/cli/output.test.ts' \
  --tag cli
```

The instruction defaults to the session's first prompt. Pass `--instruction 'text'` or
`--instruction @prompt.md` to change it, and `--setup 'npm ci'` (repeatable) for setup commands.

Check that the task is fair:

```sh
coding.sh eval validate output-test-fix --k 5
```

| Check | Means |
|---|---|
| no-op attempt fails | the verifier fails on the untouched repo |
| reference passes k/k | the session's own diff passes every time |
| near-misses fail | partial versions of the diff fail |
| no leakage | the hidden test content does not leak into what the agent sees |

A task that passes is marked `validated`; otherwise it stays a `draft` and the output says why.
`--keep` keeps the work directories so you can look.

Use it:

```sh
coding.sh eval list --status validated
coding.sh compare <bundle-a> <bundle-b> --task output-test-fix --k 3   # see Compare two agents
coding.sh eval export output-test-fix --out ./tasks/output-test-fix               # instruction.md, task.json, reference.patch
coding.sh eval export output-test-fix --out ./tasks/output-test-fix --format harbor --force
```

## Dataset case: from any session

Any session with a user prompt works, including hook-captured ones:

```sh
coding.sh sessions --since 7d                         # find the id
coding.sh dataset add regressions --session <session-id> --split test
```

The case's input is the session's first prompt. The agent's last reply is kept in the case's
metadata as `output`, not as the expected answer, so grade these cases with a judge or a
`command` grader rather than `exact`:

```sh
coding.sh exp run --dataset regressions --name base \
  --task '{"kind":"command","command":"node","args":["scripts/agent.mjs"]}' \
  --grader '{"kind":"llm","name":"resolved","rubric":"Pass if the reply resolves the request."}'
```

An LLM judge needs `ANTHROPIC_API_KEY` (or `"provider":"openai"` and `OPENAI_API_KEY`). Before you
trust its verdicts, label some sessions pass or fail in `coding.sh ui` and run
`coding.sh judge calibrate base`. See [Evals](https://coding.sh/docs/evals#judges).

## From inside the agent

With the MCP server registered, an agent can call `eval_from_session` to draft a task from a session
it has captured. It asks you first.
