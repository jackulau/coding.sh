# coding.sh with T3 Code

T3 Code is a desktop app that runs other coding agents for you: Codex, Claude Code, OpenCode,
Cursor, Pi, Grok and ACP agents. coding.sh reads what T3 Code stores on your machine and puts each
thread next to the sessions you ran in a terminal, with cost per model, the flags that mark a run
that went wrong, and evals. It runs on your machine. Nothing is sent anywhere unless you add a sink.

## What coding.sh adds

- **History across tools.** A T3 thread that ran Codex is the same session as the Codex rollout on
  disk, so it shows once, whether coding.sh read it from T3 Code or from Codex. `sessions`,
  `search`, `show` and the viewer list T3 Code threads with your other agents' sessions, and each
  one says which agent T3 Code ran.
- **Cost by model.** Every model call keeps its tokens, split into input, output, cache reads and
  cache writes, so `coding.sh usage` totals tokens and cost per model across T3 Code and your
  other agents.
- **Flags.** Each session gets the same checks as every other agent, such as `no-verification`
  (files changed and no test, type check, lint or build ran) and `repeated-tool-failure`.
  `coding.sh improve` ranks what to fix first.
- **Evals.** A T3 thread that went wrong can become an eval task, run headless by Codex or Claude
  Code.

## Set it up

```sh
npx coding.sh                       # or: coding.sh init
```

T3 Code needs no hooks. `init` lists it with "no hooks needed; imports from its store" and
installs nothing for it. coding.sh finds T3 Code when `~/.t3/userdata` exists
(`$T3CODE_HOME/userdata` when you set it) or, on macOS, when T3 Code is in `/Applications` or
`~/Applications`.

coding.sh opens T3 Code's databases (`statev2.sqlite`, and the older `state.sqlite`) as copies and
never writes to them. It reads them again before each read, such as `coding.sh sessions`, `show`,
`usage` or the viewer, and skips threads that haven't changed.

For live capture of T3's Codex and Claude Code runs, let `init` set up those two agents as well.
T3 Code starts them with their own hooks, and the hook marks each session as started by T3 Code.
Codex runs new hooks only after you approve them once: start `codex` in a terminal and run
`/hooks`. If either one isn't set up, `coding.sh doctor` names the `init --agent` command to run.

## What is recorded

coding.sh keeps one session per agent thread T3 Code started, under the agent `t3code`. The
session's `provider` names the agent T3 Code ran. Where the content comes from depends on that
agent:

| Agent T3 Code ran | Content |
|---|---|
| Codex, Claude Code | their own rollout or transcript, read the same way as when you run them in a terminal |
| OpenCode, Cursor, Pi | that agent's own store; coding.sh links the session to T3 Code |
| Grok, ACP agents and others | T3 Code's store: prompts and replies, shell commands with their output, file changes with diffs, other tool calls, web and file searches, errors, compactions, subagents, and tokens per turn |

When the agent's own session isn't on this machine, its content comes from T3 Code's store, as in
the last row.

When you switch a thread to another agent, the new agent's part is a child session of the first.
A T3 subagent thread is a child session of its parent. T3 Code's own running cost for a thread is
kept as reported cost next to the session and is never added to it.

```sh
coding.sh sessions --where agent:t3code
coding.sh sessions --where 'agent:t3code provider:codex'
coding.sh usage --by agent-model --since 30d
coding.sh show <session-id>
```

## Evals from T3 Code threads

T3 Code is a desktop app with no headless mode, so an eval can't run it. Run the task with the
agent T3 Code ran instead:

```sh
coding.sh sessions --where 'agent:t3code is:flagged'
coding.sh eval init --session <session-id> --agent codex --verifier 'npm test'
coding.sh eval run failures --yes
```

`eval init` drafts a task from each session you name: the repo as it was when the session
started, its first prompt as the instruction, and your verifier as the check. It skips a session
it can't draft a task from and says why. Pass `--agent`:
without it, the suite takes the sessions' agent, `t3code`, which can't run.

## What it does not do

- For agents other than Codex and Claude Code, the sessions appear when coding.sh next reads T3
  Code's store, not as each step happens.
- For Grok, ACP agents and the others built from T3 Code's store, tokens come per turn, not per
  model call, and T3's older `state.sqlite` has only running totals per thread.
- `init` does not register the coding.sh MCP server with T3 Code.
- Capture from T3 Code has been verified on a real install (T3 Code 0.1.7 driving Pi), but not
  on Windows yet.

## Next

- [coding.sh with Pi](pi.md): what a Pi session records.
- [Track agent cost](claude-code-cost.md): where each cost figure comes from.
- [Build evals from your agent's failures](evals-from-failures.md): make a task fair and validate it.
- [Adapters: host apps](../ADAPTERS.md#host-apps-t3-code): how T3 Code sessions are matched to the
  agents it ran.
