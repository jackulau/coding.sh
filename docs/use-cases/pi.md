# coding.sh with Pi

Pi keeps each session in a file on your machine. coding.sh records the same sessions through a Pi
extension and puts them next to the ones from your other agents, with cost per model call, the
flags that mark a run that went wrong, and evals you can run with Pi as the agent. It runs on your
machine. Nothing is sent anywhere unless you add a sink.

## What coding.sh adds

- **History across tools.** Pi sessions show up in `coding.sh sessions`, `search`, `show` and the
  viewer next to Claude Code, Codex and the other agents, in one list and one search.
- **Cost by model.** Pi writes tokens and a cost on every reply. coding.sh keeps Pi's own cost on
  each model call, so the figure is not an estimate, and totals it per session, repo, agent and
  model.
- **Flags.** Each session gets the same checks as every other agent, such as `no-verification`
  (files changed and no test, type check, lint or build ran) and `repeated-tool-failure`.
  `coding.sh improve` ranks what to fix first.
- **Evals.** Pi has a headless mode, so coding.sh can run it: turn a failed session into a task
  and run it with `--agent pi`, or compare two versions of your `AGENTS.md`, skills or Pi settings.

## Set it up

```sh
npx coding.sh                       # or: coding.sh init --agent pi
```

`init` finds Pi when the `pi` command is on your PATH or `~/.pi/agent` exists, and writes one file,
the extension `~/.pi/agent/extensions/coding-sh.ts` (under `$PI_CODING_AGENT_DIR` when you set it).
It then imports the sessions Pi already keeps in `~/.pi/agent/sessions`
(`$PI_CODING_AGENT_SESSION_DIR`). Pi loads extensions when a session starts, so start a new Pi
session to record it live.

The extension only listens. It handles no request events, so it can't block or change a tool call
or a prompt. `coding.sh uninstall --agent pi` removes it. With `--scope project` it goes to
`.pi/extensions/coding-sh.ts` in the project instead, and Pi loads it headless only when the project
is trusted or with `--approve`.

## What is recorded

From the extension, live:

- your prompts and Pi's replies;
- each model call with its provider, model, input, output, cache-read and cache-write tokens, Pi's
  cost, its stop reason and how long the reply took;
- each tool call with its arguments, output, whether it failed and how long it took, and the file
  changes it made;
- compactions, model changes and the end of each run, including runs you stopped.

From the session files, on import: the same steps, plus model changes recorded in the file and the
shell commands you ran yourself in Pi (as the `user_bash` tool). A step seen by both the extension
and the session file is stored once.

```sh
coding.sh sessions --where agent:pi
coding.sh show latest
coding.sh usage --by agent-model --since 30d
coding.sh ingest --backfill --agent pi       # import Pi's session files again
```

## Evals with Pi

```sh
coding.sh eval init --sessions --agent pi --verifier 'npm test'
coding.sh eval run failures --yes
```

`eval init --sessions` drafts a task from each failed or flagged session in this repo from the
last 14 days, up to 10. `eval run` runs `pi --mode json --approve` on each task, in its own Pi
agent directory with a copy of your `auth.json`, so your provider logins work and your own sessions
and settings are left alone. `coding.sh harness snapshot --agent pi` saves the files that shape a
Pi run (`AGENTS.md`, Claude Code's instructions file, `.pi/settings.json`, `.pi/SYSTEM.md`, skills, prompts and
extensions, in the project and in `~/.pi/agent`) as a bundle you can compare against another one.

## What it does not do

- `init` does not register the coding.sh MCP server with Pi, so Pi can't read its own sessions
  over MCP.
- Pi's thinking blocks are not stored, only the text of each reply.
- Pi has no subagents, so there is no session tree.

Pi capture is verified on a real install (Pi 1.5.0 against a local stub model), and CI repeats that
run on Linux and Windows on every change.

## Next

- [Track agent cost](claude-code-cost.md): where each cost figure comes from.
- [Build evals from your agent's failures](evals-from-failures.md): make a task fair and validate it.
- [coding.sh with T3 Code](t3-code.md): Pi sessions that T3 Code started.
- [Agents and OpenTelemetry](../guides/agents.md): what each agent records.
