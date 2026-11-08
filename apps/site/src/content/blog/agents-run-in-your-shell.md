---
title: Coding agents run in your shell
description: Claude Code, Codex and Cursor do their real work as shell commands. coding.sh captures them at the shell, through a hook under 50 ms.
date: 2026-11-08
---

The `.sh` in coding.sh is not a pun. A coding agent does its real work in a shell. It reads files,
runs tests, greps the tree, stages a commit, starts a server — all of it as shell commands the
model decides to run. The model's prose is a plan; the shell is where the plan becomes an action
that can pass, fail, or change your repo. That is the layer worth watching, and it is the layer
coding.sh records.

## Where the work and the risk are

Open any agent session and the shape is the same. A few prompts, a lot of tool calls, and most of
the tool calls are shell commands. `npm test`. `git diff`. `rg TODO`. A one-liner that edits a
file in place. The interesting moments are all here: the command that failed and got retried
without a change, the test that went green only after a test file was edited, the `rm` that was
wider than it looked, the key that ended up on a command line.

coding.sh reads each shell command the agent ran, pairs it with its result, and keeps the diff of
what changed. From that it can tell you plain things that are tedious to reconstruct by hand: which
commands failed, which ones changed files without a test running afterward, and whether a passing
test run was earned or edited into passing.

## A hook, not an integration

coding.sh captures through a hook — a small process the agent's own harness runs after each step.
The rules it follows are shell-citizen rules. It exits 0 so it can never break the agent. It prints
nothing unless the protocol needs a reply. It does no network and no git work. It writes the raw
payload to a spool file and returns, well under 50 ms, so the agent never waits on it.

That is the whole install for Claude Code, Codex, Gemini CLI and the rest: a hook line in the
agent's config, added by `coding.sh init`. No SDK, no wrapper around your commands, no proxy in the
default path. The agent keeps running exactly as it did.

## It is a CLI, so it lives where you do

The tool is a command. You read sessions, usage and diffs in your terminal, next to the agent that
produced them. `coding.sh sessions`, `coding.sh usage --by model`, `coding.sh show <id>`. The
viewer is the same binary: `coding.sh ui` serves a local page on 127.0.0.1 when you want to click
through a replay, and closes when you are done.

Underneath, coding.sh has zero runtime dependencies. Everything is Node's own built-ins — the
SQLite index through `node:sqlite`, compression through `node:zlib`. Install is one line:

```sh
curl -fsSL https://coding.sh/install.sh | sh
```

A tool for agents that work in the shell should be a shell tool. That is the one coding.sh tries to
be.
