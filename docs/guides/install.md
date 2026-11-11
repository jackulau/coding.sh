# Install, update and uninstall

Install coding.sh with one line or with npm, check it with doctor, and remove it cleanly.
Site version: [coding.sh/docs/install](https://coding.sh/docs/install).

## Install

```sh
curl -fsSL https://coding.sh/install | sh
```

Or with npm:

```sh
npm install -g coding.sh
coding.sh init             # finds your agents, shows one plan, asks once (Y/n)
coding.sh                  # opens the viewer
```

The script checks for Node 22.15 or newer and installs coding.sh from npm. If npm does not have the
release (or can't be reached), it takes the tarball from the GitHub release instead. Then it runs
`coding.sh init` and opens the viewer.

`npx coding.sh init` also works. The hook is copied to a stable path, but the MCP entry points at
the npx cache copy of the CLI. Install globally if you want the MCP server to survive
`npm cache clean`.

## Script options

Set these on the `sh` side of the pipe:

```sh
curl -fsSL https://coding.sh/install | CODING_SH_YES=1 CODING_SH_NO_UI=1 sh
```

| Variable | What it does |
|---|---|
| `CODING_SH_VERSION` | Install this release instead of the latest. Give its tag, as listed on the GitHub releases page. |
| `CODING_SH_TARBALL` | Install this tarball, a path or a URL: a mirror, a machine without internet, or a build you packed. |
| `CODING_SH_SOURCE` | `npm` or `github`: install from that source only. By default npm comes first. |
| `CODING_SH_YES=1` | Run `init --yes`, with no prompt. |
| `CODING_SH_NO_INIT=1` | Install only. Run `coding.sh init` later. |
| `CODING_SH_NO_UI=1` | Don't open the viewer at the end. |

Without a terminal (an agent's shell, CI), the script installs only and prints the next command,
unless `CODING_SH_YES=1` is set.

## Requirements

- Node.js 22.15 or newer. coding.sh uses the SQLite and zstd built into Node, so nothing native is
  compiled.
- git, for the repository snapshots that `coding.sh run` and repo-replay evals take.

## Windows

Run the installer from Git Bash, which comes with [Git for Windows](https://gitforwindows.org).
The source install below works from PowerShell too. Under WSL, coding.sh behaves as it does on
Linux and records the agents you run inside WSL.

- Hooks run `node "C:/Users/you/.coding.sh/bin/hook.mjs" <agent> <event>`. The forward slashes
  and quotes work in cmd.exe, PowerShell and Git Bash, and with spaces in the path.
- Eval task `setup` and verifier commands run in `sh`, so they need Git for Windows.
- `bench schedule --install-cron` needs cron. On Windows, run the printed command from Task
  Scheduler, or use `--workflow-out` for a GitHub Actions schedule.

CI runs the test suite and this installer on Windows. It also installs the current releases of
OpenCode, Pi, Goose, Factory Droid, GitHub Copilot CLI and Aider, runs one session of each against
a stub model and checks what coding.sh recorded. Capture from Claude Code, Codex CLI, Antigravity
CLI, Cursor CLI, Amp and T3 Code has not been checked on Windows yet.

## What `init` changes

`init` points each detected agent's hooks at the hook in `~/.coding.sh/bin` and registers the
coding.sh MCP server with the agents that support MCP. Every config file it edits is backed up to
`~/.coding.sh/backups` first. `coding.sh init --dry-run` prints the plan (each agent, the files it
would change, anything that blocks capture) and writes nothing; `--diff` adds the exact edits.

Then `init` imports the sessions each agent already keeps on this machine (Claude Code transcripts,
Codex rollouts and the others listed in [ADAPTERS.md](../ADAPTERS.md)), so the viewer opens on your
own history. It shows progress and stops after 8 seconds; the rest imports in the background and
shows up in the viewer as it lands.

Set `CODING_SH_INIT_IMPORT_BUDGET_MS` to change the 8 seconds.
`--no-import` skips the import, and `coding.sh ingest --backfill` runs it later. Running `init`
again reads only new or changed transcripts. The import applies the same redaction and
`capture.exclude` rules as live capture.

After that, start a new agent session and use it as usual. Agents read their hooks when a session
starts, so a session that was already open when you ran `init` may not be recorded until you
restart it.

Sessions show up in the viewer, in `coding.sh sessions` and over MCP. There is no ingest step:
read commands, the viewer and the MCP server pick up new events on their own.

Codex runs new hooks only after you approve them with `/hooks` inside Codex. Until then, read
commands and the viewer import each Codex session from its transcript, so you still see its
prompts, tool calls, tokens and cost, but not while it runs.

Check your setup with `coding.sh doctor`.

## Updates

Commands print one dim line on stderr when a newer release is out. The check runs in the
background at most once a day, and commands never wait on it. `coding.sh update` installs the new
release.

The check is off when `CI` is set, or with `NO_UPDATE_NOTIFIER=1`, `CODING_SH_NO_UPDATE_CHECK=1`
or `[update] check = false` in `~/.coding.sh/config.toml`.

## Uninstall

```sh
coding.sh uninstall --dry-run   # show what would change
coding.sh uninstall --yes       # remove hooks and MCP entries from every agent
npm uninstall -g coding.sh
rm -rf ~/.coding.sh             # optional: delete captured data
```

`uninstall` restores each agent config file byte for byte if nothing else has edited it since
`init`. Otherwise it removes only the coding.sh entries.

## From source

```sh
git clone https://github.com/jackulau/coding.sh && cd coding.sh
npm install && npm run build -w coding.sh
npm install -g ./packages/coding.sh   # puts `coding.sh` on PATH (a symlink to this checkout)
coding.sh init
coding.sh
```

Or skip the global install and run `node packages/coding.sh/dist/cli.mjs <command>` directly.
