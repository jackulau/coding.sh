# coding.sh with Pi

coding.sh records your Pi sessions through a Pi extension and puts them next to the ones from
your other agents, with Pi's own cost per model call, flags for runs that went wrong, and evals
with Pi as the agent. It runs on your machine. Nothing is sent anywhere unless you add a sink.

## Set it up

```sh
npx coding.sh                       # or: coding.sh init --agent pi
```

`init` finds Pi when `pi` is on your PATH or `~/.pi/agent` exists. It writes one file, the
extension `~/.pi/agent/extensions/coding-sh.ts` (under `$PI_CODING_AGENT_DIR` when set), then
imports the sessions in `~/.pi/agent/sessions` (`$PI_CODING_AGENT_SESSION_DIR`). Start a new Pi
session to record live: Pi loads extensions when a session starts.

The extension only listens, so it can't block or change a tool call or a prompt.
`coding.sh uninstall --agent pi` removes it. With `--scope project` it goes to
`.pi/extensions/coding-sh.ts`, which Pi loads headless only when the project is trusted or with
`--approve`.

## Look at your Pi sessions

```sh
coding.sh sessions --where agent:pi
coding.sh show latest
coding.sh usage --by agent-model --since 30d
coding.sh ingest --backfill --agent pi       # import Pi's session files again
```

Pi sessions show up in `sessions`, `search`, `show` and the viewer next to your other agents. Pi
writes a cost on every reply, and coding.sh keeps it on each model call, so the figure is not an
estimate. Each session gets the same flags as every other agent, such as `no-verification` and
`repeated-tool-failure`, and `coding.sh improve` ranks what to fix first.

## What is recorded

The extension records, live:

- your prompts and Pi's replies;
- each model call: provider, model, input, output, cache-read and cache-write tokens, Pi's cost,
  stop reason and duration;
- each tool call: arguments, output, failure, duration and the file changes it made;
- compactions, model changes and the end of each run, including runs you stopped.

Importing the session files gives the same steps, plus model changes recorded in the file and the
shell commands you ran yourself in Pi (as the `user_bash` tool). A step seen by both is stored once.

## Run evals with Pi

```sh
coding.sh eval init --sessions --agent pi --verifier 'npm test'
coding.sh eval run failures --yes
```

`eval init --sessions` drafts a task from each failed or flagged session in this repo from the
last 14 days, up to 10.

`eval run` runs `pi --mode json --approve` on each task in its own Pi agent directory, with a copy
of your `auth.json`. Your provider logins work, and your own sessions and settings are left alone.

`coding.sh harness snapshot --agent pi` saves the files that shape a Pi run as a bundle you can
compare against another: `AGENTS.md`, Claude Code's instructions file, `.pi/settings.json`,
`.pi/SYSTEM.md`, skills, prompts and extensions, in the project and in `~/.pi/agent`.

## What it does not do

- `init` does not register the coding.sh MCP server with Pi.
- Pi's thinking blocks are not stored, only the text of each reply.
- Pi has no subagents, so there is no session tree.

Pi capture is verified on a real install (Pi 1.5.0 against a local stub model), and CI repeats that
run on Linux and Windows on every change.

## Next

- [Track agent cost](claude-code-cost.md): where each cost figure comes from.
- [Build evals from your agent's failures](evals-from-failures.md): make a task fair and validate it.
- [coding.sh with T3 Code](t3-code.md): Pi sessions that T3 Code started.
- [Agents and OpenTelemetry](../guides/agents.md): what each agent records.
