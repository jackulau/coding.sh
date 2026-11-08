# Ease of setup

How easy coding.sh is to set up, measured two ways: a person running the installer, and an AI
agent that has only [/agents.md](https://coding.sh/agents.md). `scripts/e2e/ease.mjs` runs both
paths under a throwaway `HOME`, npm prefix and npm cache. It never reads or writes the real
`~/.claude`, `~/.codex` or `~/.coding.sh`.

## Run it

From the repo root, after `npm ci`:

```sh
(cd packages/coding.sh && npm run build)
node scripts/e2e/ease.mjs            # both paths, a summary per check
node scripts/e2e/ease.mjs --json     # one JSON document
node scripts/e2e/ease.mjs --real     # a real Claude Code 2.1.319 against the stub model (needs network for npm)
```

To measure an older build, check it out in another worktree, build it, and point the benchmark at
its package, installer and agents.md:

```sh
node scripts/e2e/ease.mjs --pkg <base>/packages/coding.sh --install-sh <base>/install.sh \
  --agents-md <base>/apps/site/src/lib/agent-docs.ts
```

It exits 0 when the agent path's setup succeeds and the person saw their session. The human path
needs `python3` for its pseudo-terminal; without it, that path is skipped.

## What it measures

**Human.** `install.sh` runs in a pseudo-terminal from a local tarball (`CODING_SH_TARBALL`), and
every `(Y/n)` prompt is answered with Enter.

- `prompts`: questions asked. `flags`: options a person had to type. `steps`: things a person does
  (run the one-liner, start an agent session).
- `installMs`: installer wall time, `init` included.
- `emptyStates`: after `init` and before the first session, which of five empty states name the
  right next step. The five are `show latest`, `status`, `sessions`, the viewer's `/api/ingest`,
  and the MCP `status` tool. Sending the person back to `coding.sh init`, which changes nothing at
  that point, counts as wrong.
- `visibleMs`: from the session's last hook to the session in the viewer's API, with no command
  typed in between.

**Agent.** The benchmark reads the `sh` blocks and inline `coding.sh …` spans from agents.md and
runs them in order, with no terminal. Each check passes or fails:

| Check | Passes when |
|---|---|
| install | the doc's non-interactive installer line exits 0 and `coding.sh` is on PATH |
| hook | the doc's `init` lines exit 0 and Claude Code's settings hold the hook |
| verify | `doctor --json` is one JSON document with `ok: true` and Claude Code hooked |
| errors | before the first session, `show latest --json` fails with one JSON line whose next command is not `init` |
| capture | a Claude Code session runs the hooks init wrote; they exit 0, print nothing and write to the spool |
| readBack | the doc's `show latest --json` and `sessions --since 1d --json` return that session |
| mcp | the MCP server from Claude Code's config lists its tools and `sessions_list` returns the session |
| commands | every `coding.sh <command>` the doc names answers `--help` |

`setupSuccess` needs install, hook, verify, capture, readBack and mcp.

The session is, by default, the hook payloads a pinned Claude Code recorded against the stub model
(`test/fixtures/adapters/claude-code/hooks.spool.jsonl`). Each payload is piped to the exact
command `init` wrote into `~/.claude/settings.json`, as Claude Code does. `--real` runs `claude -p`
instead.

## Results

Measured on 2026-11-08 on an Apple Silicon Mac, Node 22.19, three runs each.

| | origin/main (05224ba) | this change |
|---|---|---|
| Human: commands to type | 1 | 1 |
| Human: prompts | 1 | 1 |
| Human: flags | 0 | 0 |
| Human: steps | 2 | 2 |
| Human: install and init | 0.9 s (3.8 s with a cold npm cache) | 0.8 to 1.2 s |
| Human: session visible after its last hook | 2 to 3 ms | 2 to 3 ms |
| Human: empty states with the right next step | 0 of 5 | 5 of 5 |
| Agent: checks passed | 7 of 8 | 8 of 8 |
| Agent: setup success | yes | yes |

`--real` (Claude Code 2.1.319 against the stub model) gave the same 8 of 8 and 5 of 5, in about
24 s including the npm install.

What failed before:

- `init` never said that capture starts with the next agent session. Before the first session,
  the viewer told the person to run `npx coding.sh init` again, `show latest`, `status`,
  `improve` and the MCP server said to run `init`, and `sessions` gave no hint.
- Agent `errors`: after `init`, the error's `next` still pointed at `init`. agents.md documented
  `next` as `["<suggested command>"]`; the CLI prints `["<what to do>:", "<command>"]`.
- With no terminal, the installer ended with "Run: coding.sh", which only prints help there.

## Caveats

- Install times come from a local tarball, so they leave out the npm download. A first install
  from npm takes as long as the download.
- The default session replays recorded hook payloads instead of running Claude Code. It tests the
  hook commands `init` wrote, not whether Claude Code loads them. `--real` covers that.
- The agent path runs the commands agents.md lists. It does not test whether a model reading the
  page would pick the same commands.
- `visibleMs` is the viewer's API, not a rendered page.
- The fake `claude` on PATH only answers `--version`. Other agents are not covered.
- A Vercel-like path is still longer in one place: the first session has to start after `init`,
  because agents load hooks at session start. Importing past sessions during `init` covers this
  for people with history.
