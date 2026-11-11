# coding.sh with T3 Code

T3 Code is a desktop app that runs other coding agents for you: Codex, Claude Code, OpenCode,
Cursor, Pi, Grok and ACP agents. coding.sh reads what T3 Code stores on your machine and puts each
thread next to the sessions you ran in a terminal, with cost per model, flags and evals.

It runs on your machine. Nothing is sent anywhere unless you add a sink.

## Set it up

```sh
npx coding.sh                       # or: coding.sh init
```

T3 Code needs no hooks: `init` lists it with "no hooks needed; imports from its store". coding.sh
finds T3 Code when `~/.t3/userdata` exists (`$T3CODE_HOME/userdata` when set) or, on macOS, when
it is in `/Applications` or `~/Applications`.

coding.sh opens T3 Code's databases (`statev2.sqlite`, and the older `state.sqlite`) as copies and
never writes to them. It reads them again before each read, such as `sessions`, `show`, `usage` or
the viewer, and skips threads that haven't changed.

For live capture of T3's Codex and Claude Code runs, let `init` set up those two agents too. T3
Code starts them with their own hooks, which mark each session as started by T3 Code.

Codex runs new hooks only after you approve them once: start `codex` in a terminal and run `/hooks`.
`coding.sh doctor` names the `init --agent` command for an agent that isn't set up.

## Look at your T3 Code threads

```sh
coding.sh sessions --where agent:t3code
coding.sh sessions --where 'agent:t3code provider:codex'
coding.sh usage --by agent-model --since 30d
coding.sh show <session-id>
```

Each agent thread T3 Code started is one session under the agent `t3code`, and its `provider`
names the agent T3 Code ran. A T3 thread that ran Codex is the same session as the Codex rollout on
disk, so it shows once.

Every model call keeps its tokens, so `usage` totals tokens and cost per model across T3 Code and
your other agents. Each session gets the same flags as every other agent, and `coding.sh improve`
ranks what to fix first.

## What is recorded

| Agent T3 Code ran | Content comes from |
|---|---|
| Codex, Claude Code | their own rollout or transcript, read as when you run them in a terminal |
| OpenCode, Cursor, Pi | that agent's own store, linked to T3 Code |
| Grok, ACP agents and others | T3 Code's store: prompts, replies, shell commands, file diffs, other tool calls, searches, errors, compactions, subagents, tokens per turn |

When the agent's own session isn't on this machine, its content comes from T3 Code's store.

When you switch a thread to another agent, the new agent's part is a child session of the first.
A T3 subagent thread is a child session of its parent. T3 Code's own running cost for a thread is
kept as reported cost next to the session and is never added to it.

## Make evals from T3 Code threads

T3 Code has no headless mode, so an eval runs the agent T3 Code ran instead:

```sh
coding.sh sessions --where 'agent:t3code is:flagged'
coding.sh eval init --session <session-id> --agent codex --verifier 'npm test'
coding.sh eval run failures --yes
```

`eval init` drafts a task from each session you name: the repo as it was when the session
started, its first prompt as the instruction, and your verifier as the check. It skips a session
it can't draft a task from and says why. Pass `--agent`: without it, the suite takes the
sessions' agent, `t3code`, which can't run.

## What it does not do

- For agents other than Codex and Claude Code, sessions appear when coding.sh next reads T3
  Code's store, not as each step happens.
- For Grok, ACP agents and the others, tokens come per turn, not per model call. T3's older
  `state.sqlite` has only running totals per thread.
- `init` does not register the coding.sh MCP server with T3 Code.
- Capture is verified on a real install (T3 Code 0.1.7 driving Pi), but not on Windows yet.

## Next

- [coding.sh with Pi](pi.md): what a Pi session records.
- [Track agent cost](claude-code-cost.md): where each cost figure comes from.
- [Build evals from your agent's failures](evals-from-failures.md): make a task fair and validate it.
- [Adapters: host apps](../ADAPTERS.md#host-apps-t3-code): how T3 Code sessions are matched to the
  agents it ran.
