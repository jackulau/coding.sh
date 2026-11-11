# Troubleshooting

For a coding agent, start with `coding.sh doctor`. For your own agent, see
[Your agent's traces don't show up](#your-agents-traces-dont-show-up). If a command failed, find its `reason` in the [error table](#errors-by-reason).
Site version: [coding.sh/docs/troubleshooting](https://coding.sh/docs/troubleshooting).

## Run doctor

```sh
coding.sh doctor          # one line per check
coding.sh doctor --json   # the same as one JSON document
```

```text
! Claude Code     installed, not hooked, no events yet
! Hook            missing at ~/.coding.sh/bin/hook.mjs; run coding.sh init
✓ Spool           ~/.coding.sh/spool writable
✓ Store           sqlite sqlite://~/.coding.sh/index.db
  Receiver        port 4318 free; start with coding.sh collector
  AI Gateway      not configured, no key, 0 tagged sessions

  Capture the agents without hooks:
    coding.sh init --agent claude-code
```

A `!` row is a warning. An agent captured by hooks gets `✓` only when a hook that runs this home's
`hook.mjs` is in a config doctor read, that file exists and nothing blocks it.

Each blocker is printed under the row, with the file and line to change when there is one. When an
agent row is a warning, the last line is `N agents not capturing` in place of `ok`.

doctor exits 1 only when the spool or the store fails, and `ok` in `doctor --json` says the same,
so a script that checks either keeps working.

The warnings are in the JSON as `warnings`: each has a `check` (`agent`, `agents`, `hook`, `mcp`, `sessions` or `proxy`), a `message`, the `agent`
and its `blockers` when it is about one, and the command that fixes it as `next` when one does.

| Row says | Means | Fix |
|---|---|---|
| `not hooked` | The agent is installed but has no coding.sh hook in its user config or in a project doctor checked, and no events in the last 5 minutes. | `coding.sh init --agent <id>` |
| `hooked in <file> (project)` | The hook is in a project's config (`init --scope project`), not the user config. doctor looks in the current directory, its parents and the directories the agent's recent sessions ran in. The agent is captured in that project only. | Nothing, or `coding.sh init --agent <id>` to capture every project. |
| `hooks in <file> run <path>, not this home's hook` | The agent's hooks in that settings file run another coding.sh home's `hook.mjs`, usually because `HOME` or `CODING_SH_HOME` points somewhere else than when the hooks were written. They capture into that home, not this one. `doctor --json` lists each file it read under `hookFiles`, with the hook it runs and `current: false`. | `coding.sh init --agent <id>` hooks this home too. |
| `hooked …, but the hook it runs is missing` | The hooks run this home's `hook.mjs`, and that file is gone. The `Hook` row says the same. | `coding.sh init` |
| `events arriving, hook not in user config` | Events came in during the last 5 minutes, but doctor found no hook in the user config or a project it checked. Still a warning: the events can come from an import, the proxy or a project doctor did not look in. | `coding.sh init --agent <id>`, or run doctor from the project to see its hook. |
| `hooked but not firing` | The hook is in place but the agent will not run it. The note under the row says why (see below). | Follow the note. |
| `no events yet` | Nothing captured from this agent. Normal right after `init`. | Use the agent, then `coding.sh sessions`. |
| `reads its store` / `no store yet` | Host apps such as T3 Code are read from their own database, not hooks. | Nothing to do. |
| `Hook missing at …/bin/hook.mjs` | `init` has not run, or the file was deleted. | `coding.sh init` |
| `Hook …/bin/hook.mjs is stale` | The hook bin is from another coding.sh version, or `bin/cli-path` names another install. The agent configs are fine. After an upgrade in place (`npm i -g`), the `coding.sh ingest` the hook starts at the next session end refreshes the bin by itself. | `coding.sh update --refresh-bin` |
| `Spool … not writable` | coding.sh can't write to `~/.coding.sh/spool` (or `$CODING_SH_HOME/spool`). | Fix the directory's owner or permissions. |
| `Store can't open: …` | The index could not be opened. The message has the cause. | See `store_unavailable` below. |
| `Ingest stopped 4h ago: …` | The `coding.sh ingest` the hook starts at session end has failed since then, so nothing new is indexed. A store it can't open shows at the first failure, any other error once the next ingest fails too. Captures are not lost: the hook keeps writing them to the spool. `coding.sh status` and the status line say the same, and `status --json` and `doctor --json` carry it as `ingestStopped`. The row goes away with the next ingest that works. | The command the row names, usually `coding.sh update` or `coding.sh upgrade-store`. See [A store another coding.sh can't open](#a-store-another-codingsh-cant-open). |
| `Receiver port 4318 in use` | Something listens on the OTLP port, usually `coding.sh collector`. | Nothing, or `doctor --port <n>` to check another port. |
| `Agents none detected` | No supported agent was found on PATH or in its usual config dir. | Capture any command with `coding.sh run -- <cmd>`. |

Notes that mean a hook will not fire. doctor prints them under the agent's row whether or not the
hook is installed yet:

- **Codex: `coding.sh hook(s) not trusted yet`.** Codex runs a new or changed hook only after you
  approve it. Start `codex`, run `/hooks` and approve the coding.sh entries. coding.sh never writes
  trust state for you.
- **Codex: `hooks are disabled in config.toml ([features] hooks = false)`.** Remove that line or set
  it to `true` in `~/.codex/config.toml`. The note ends with the file and the line number.
- **Cursor: `cursor-agent <version> predates CLI hooks`.** Run `cursor-agent update`; hooks need
  2026.01 or newer.
- **OpenCode: `installed plugin targets the wrong OpenCode API`.** Run `coding.sh init` again after
  upgrading OpenCode.

## Sessions don't show up

Work down this list:

1. **Is the hook firing?** `coding.sh doctor`, then fix what it reports.
2. **Did the agent start before `init`?** Agents read their hook config at startup. Restart it.
3. **Is capture switched off?** `CODING_SH_DISABLE=1` in the agent's environment makes the hook
   write nothing.
4. **Is the repo excluded?** `coding.sh config get capture.exclude`. Sessions whose working directory
   matches are dropped at ingest.
5. **Did ingest fail?** Run `coding.sh ingest` and read its output. Hook failures are logged to
   `~/.coding.sh/spool/errors.log`; the hook itself always exits 0 so the agent carries on.
6. **Are you reading another store?** With `--store` or `CODING_SH_STORE_URL` set, commands skip the
   automatic ingest of your local spool. Run `coding.sh ingest --store <url>` to push it, or unset
   the variable.
7. **Is it older than `init`?** `init` imports past transcripts unless you passed `--no-import`.
   Run `coding.sh ingest --backfill` (add `--since 30d` for the last 30 days). Re-running it adds
   nothing new.

## Your agent's traces don't show up

For an agent sending over OpenTelemetry or the SDK:

1. **Is a receiver running?** OpenTelemetry goes to `coding.sh collector`; the SDKs need
   `coding.sh serve`, because the collector only takes OTLP. `serve` takes both. Both default to
   port 4318, so run one at a time.
2. **Is the SDK switched on?** Without `CODING_SH_URL` the SDKs send nothing. `CODING_SH_DEBUG=1`
   logs transport problems.
3. **Did the process exit before sending?** Spans and SDK events are sent in batches. Call
   `await flush()` (TypeScript), `coding_sh.flush()` (Python), or the OTel provider's
   `shutdown()` before a short script exits.
4. **Right protocol?** The Python OTLP HTTP exporter speaks protobuf only: set
   `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`. `OTEL_EXPORTER_OTLP_ENDPOINT` is the base URL;
   a signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` must include `/v1/traces`.
5. **Are you looking under the right name?** The agent id comes from `OTEL_SERVICE_NAME`
   (kebab-cased) or `CODING_SH_SERVICE`. `coding.sh sessions` lists every agent.

## Data looks incomplete

- **No model latency or tokens.** Hooks see tool calls, not model calls. Most adapters read model
  calls from the transcript after the session ends. For Claude Code latency, run `coding.sh collector` and
  turn on its [OpenTelemetry export](https://coding.sh/docs/otel#claude-code).
- **No cost.** Most coding-agent transcripts carry tokens, not dollars. See
  [Find your most expensive sessions](how-to/expensive-sessions.md#where-cost-comes-from).
- **Prompts and tool output are missing.** `capture.mode` is `metadata`, or a repo's
  `.coding.sh/config.toml` set it. Check with `coding.sh config get capture.mode`.
- **Text shows `[redacted:<kind>]`.** A redactor matched it. Redaction runs before anything is
  stored. See [Configuration](reference/config.md#capture).
- **Cursor headless runs have no prompt or reply.** `cursor-agent -p` does not fire the prompt and
  response hooks. This is a Cursor limitation.
- **`eval new` fails with `has no repo state`.** The session ran outside a git repository, so
  there is nothing to replay. Record it with `coding.sh run --` inside the repository. See
  [Turn a session into an eval](how-to/session-to-eval.md).

## Check what the adapters read

`coding.sh doctor --conformance` runs each agent's backfill over the transcripts on this machine
and checks the events it produces. Use it when sessions look wrong, or after an agent update.

```sh
coding.sh doctor --conformance                      # every agent with transcripts from the last 7 days
coding.sh doctor --conformance --agent codex --since 30d
coding.sh doctor --conformance --json               # one JSON document with every count and example
```

```text
✓ Claude Code     50 events, 1 session, no violations
✗ OpenCode        0 events, 0 sessions, 1 violation: empty-backfill 1 (F3)
  empty-backfill: 1 source file(s), 32768 bytes, but the backfill produced no events

  See every violation:
    coding.sh doctor --conformance --json
1/2 agents conform
```

It only reads: nothing is stored, and reports hold ids, counts and short details, never prompt,
reply or tool text. Agents with no transcript changed since `--since` are left out unless you name
them with `--agent`.

Each agent stops after `--max-events` events (200,000 by default) or 60 seconds. Sessions still
being read then skip the checks that need a whole session.

| Rule | What it means |
|---|---|
| `duplicate-id` | Two events share an id but differ in content, so the store keeps only one. |
| `usage-double-count` | Token usage is counted twice: two model calls with one message id both carry it, or a session or turn total sits next to per-call usage. |
| `negative-usage` | A token or cost field is negative or not a number. |
| `dangling-parent` | An event's `parentId` names an event that is not in the data. |
| `parent-other-session` | An event's parent is in another session. |
| `parent-link-broken` | A child session's start names a parent event that is not in its parent session. |
| `empty-backfill` | The agent's source files exist, but the backfill produced no events. |
| `session-without-prompt` | A session did work but has no user message, so it has no title. |
| `exit-code-not-failed` | The first lines of a tool's output report a nonzero exit code, but the call is not marked failed. |
| `tool-end-without-start` | A tool end has no matching start in its session. |
| `duplicate-tool-call` | Two different starts, or two different ends, share one tool call id in a session. |
| `end-before-start` | A tool, subagent or session ends before it starts. |
| `turn-end-repeated` | Two different turn ends close the same turn. |
| `bad-timestamp` | A timestamp is not a number of milliseconds between 2000 and 2100. |
| `negative-duration` | A duration is negative. |
| `backfill-threw` | The backfill threw instead of skipping what it could not read. |

A tool start with no end is counted, not reported: the call was cancelled or is still running.
The F numbers name the bugs in `docs/research/round-1-self.md` each rule was written to catch.
doctor exits 1 when any agent has a violation. Please report one as an issue with the `--json`
output for that agent.

## Old sessions show doubled counts

Sessions captured before an upgrade keep the rows the older coding.sh parsed. When an adapter's
parsing changes, coding.sh re-parses that agent's stored sessions in the background, from their
transcripts and the hook lines still in the spool. It starts on the next session end, read or
viewer start.

Reads and new captures keep working while it runs, and each session is swapped in one step. A
re-parse that is cut short picks up where it stopped. An upgrade that changes stats or flags works
them out again the same way, from the rows already stored.

- **Do it now.** `coding.sh ingest --rebuild` re-parses every session (`--agent pi` for one agent).
  It prints how many it re-parsed, kept and removed.
- **Some sessions were kept.** A session whose transcript and spool lines are both gone keeps its
  rows, minus duplicates. `coding.sh ingest --rebuild --json` lists each one with the reason.
- **Hook lines without a transcript.** A Claude Code session is also kept when its hook lines remain
  and its transcript is gone (an eval run's temporary home), or the turn is now over 8 MB from the
  transcript's end.
- **Some sessions were removed.** A session stored from a copy of another session's transcript (a
  Claude Code subagent copied into a fork) is deleted, so its cost counts once. A copy with hook,
  OTel or SDK rows is kept.
- **Nothing happens.** Re-parse needs the local SQLite index (or a store plugin that supports it),
  and `CODING_SH_NO_AUTO_INGEST=1` turns off the background run. `--rebuild` still works.

## A store another coding.sh can't open

Index migrations are one-way. A coding.sh that migrates `~/.coding.sh/index.db` to a newer schema
leaves every older install that shares it unable to open it (`uses index schema v9, but this
coding.sh only knows up to v8`), and ingest stops. Three checks keep that from happening by
accident, and every migration keeps a way back:

- **The store has an owner**: the coding.sh that `~/.coding.sh/bin/cli-path` names. Another install
  that would migrate it stops with `store_owned` and changes nothing. Run `coding.sh upgrade-store`
  from that install to migrate it and point the hooks there.
- **A source checkout doesn't open the default home.** It stops with `source_checkout` unless
  `CODING_SH_HOME`, `--store` or `CODING_SH_STORE_URL` names a store. Use
  `CODING_SH_HOME=$(mktemp -d)`, or `CODING_SH_DEV_REAL_STORE=1` for the real one.
- **Only a newer release migrates by itself.** From 0.1.6 the store records the newest version
  that opened it. A build with a newer schema but not a newer version (a source build, a stale
  `dist/`) stops with `store_version`.

An upgrade in place (`coding.sh update`, `npm i -g coding.sh`) migrates as before, and an `npm link`
of a checkout counts as an install. `coding.sh upgrade-store` migrates on request. A store written
before 0.1.6 has no version record: an install migrates it, and a source checkout stops the same
way.

**The way back.** Before a migration changes a store that holds data, coding.sh copies the index to
`index.db.v<N>.bak` next to it (`N` is the schema it had).

- **Space.** On APFS, Btrfs and XFS the copy is a clone that takes no space until the files differ.
  Elsewhere it is a full copy, and the migration is refused, naming the space it needs, when that
  would not fit.
- **One copy is kept.** A later migration removes the older one. Delete the file once the new
  version works. `coding.sh purge` deletes it too, since a copy holds every event as it was.
- **Restore.** `coding.sh upgrade-store --restore` puts the copy back, from any coding.sh that
  knows the copy's schema. The index it replaces is kept as `index.db.v<N>.undone`, and later
  captures are ingested again from the spool.
- **After a restore** the build that migrated the store does not migrate it again by itself, and
  `bin/cli-path` points back at the install the upgrade took the hooks from.

**A store already migrated past your install.** The error says nothing is lost: the hook keeps
writing captures to the spool, and the message counts the files waiting there and names the version
that wrote the store.

Update that install (`coding.sh update`), or run `coding.sh upgrade-store --restore` when the
message offers it. Meanwhile `coding.sh status`, the status line and `coding.sh doctor` print
`ingest stopped 4h ago` with the command that fixes it.

## The first command after an upgrade is slow

When a new coding.sh changes the index layout, the first command that opens the index upgrades
it, once. On a store of 100,000 events or more it says so on stderr right away, then prints
what it is doing at most once a second:

```text
coding.sh: the index holds 756,302 events; upgrading it from schema v8 to v11. This runs once.
coding.sh: upgrading the index: search index 300,000 of 756,302 events (39%)
coding.sh: index upgraded in 11.5s. Run `coding.sh gc --compact` to give back the space the old layout used.
```

- **Another command waits.** A command that opens the index while another process upgrades it
  waits for that process and prints its progress (`waiting for another coding.sh (pid …)`).
- **Stopped halfway.** The upgrade runs in one transaction. If it is stopped, the index stays as
  it was and the next command starts it again.
- **The index grew.** Run `coding.sh gc --compact` once the upgrade has finished. It empties
  what old rows still hold and gives the space back.

## Errors by reason

Every error prints a message and, usually, the next command to try. With `--json` it is one line on
stderr:

```json
{"status":"error","reason":"not_found","message":"Can't find session \"nope\"","next":["List sessions:","coding.sh sessions"]}
```

When the next step deletes or overwrites data, cannot be undone, or spends money (`--yes`, `--force`,
`purge`, a rollback), the error also says the user must approve it first, and the JSON has
`askUser: true`:

```json
{"status":"error","reason":"confirmation_required","message":"Run 8 agent sessions (1 arm x 8 prompts x 1) needs confirmation from the user","askUser":true,"next":["coding.sh eval trigger ./skill --yes"]}
```

An agent that reads `askUser: true` asks the user instead of running `next` itself.

Exit codes: `1` error, `2` usage error, `130` canceled. Add `--debug` for a stack trace.

### Usage errors (exit 2)

The command line was wrong. Nothing ran.

| Reason | Example message | Fix |
|---|---|---|
| `unknown_command` | `Unknown command "frobnicate"` | `coding.sh --help` lists commands. Typos get a suggestion. |
| `missing_command` | `Missing command for coding.sh eval. Choose one of: new, validate, list, export` | Add the action. |
| `unknown_action` | `Unknown workflows action "…"` | `coding.sh workflows --help` |
| `unknown_option` | `Unknown option --sinse` / `Did you mean --since?` | Check `coding.sh <command> --help`. |
| `missing_value` | `--since needs a value <WHEN>` | Give the option a value. |
| `invalid_value` | `--by must be one of agent, model, agent-model, day, repo, got "foo"` | Use one of the values the message lists. |
| `extra_argument` | `Unexpected argument "…"` | Quote arguments that contain spaces. |
| `missing_argument` | `Missing --out <DIR>` | Add the argument or option named. |
| `invalid_argument` | (bench) a bad `--date`, `--seed` or contender | Fix the value the message names. |
| `invalid_usage` | Any other usage error. | Read the message. |
| `confirmation_required` | `Set up coding.sh for 1 agent (2 config files, backed up first) needs confirmation from the user` | Not a terminal, so it can't ask. Re-run with `--yes`, or `--dry-run` first to see the changes. An agent asks the user first (`askUser: true`). |
| `cost_confirmation_required` | `Estimated cost $7.20 exceeds confirmAboveUsd $5.00` | With `--json` this is `{"status":"action_required",…}`. Re-run with `--yes`, or raise `[toolevals] confirmAboveUsd`. |
| `insecure_bind` | `refusing to listen on 0.0.0.0 without auth: …` | Only some credentials are set. Set both `CODING_SH_INGEST_KEYS` and `CODING_SH_READ_KEYS` (make keys with `coding.sh serve keygen`), unset both to use the first-start keys, or pass `--insecure` on a trusted network. |
| `unknown_agent` | `Unknown agent "claude"` | Use an agent id from [Coding agents](https://coding.sh/docs/agents). |
| `unknown_key` | `Can't set "capture.mod". Settable keys: …`, or in `--where`: `unknown key "modle" at character 13` | Use a key from [Configuration](reference/config.md), or a `--where` key from [Query and export](reference/query.md#filter-with---where). To search for the word itself, quote it. |
| `bad_value` | `--where: cost: must be a USD amount like 0.5, got "abc" at character 6` | Use a value the key takes; the message gives one. Durations need a unit (`duration>10m`). |
| `unterminated_quote`, `unbalanced_parens` | `--where: missing ')' at character 23` | Close the quote or parenthesis the caret points at. |
| `dangling_or`, `dangling_not`, `empty_group` | `--where: OR needs a clause on each side` | Put a clause after `OR` or `-`, or inside `( )`. |
| `bad_directive`, `too_long`, `bad_query` | `--where: sort: and limit: apply to the whole query; put them outside an OR` | Put `sort:` and `limit:` at the top level, outside parentheses, OR and `-`. A query is at most 2,000 characters. |
| `invalid_case` | (dataset add) a case that is not `{"input":…}` JSON | Fix the `--case` JSON. |
| `invalid_grader` | `Invalid grader: …` | Fix the `--grader` JSON. See [Evals](https://coding.sh/docs/evals#graders). |
| `invalid_matrix` | `Invalid matrix in matrix.json: …` (exp run) | Fix the spec: a cell that differs from the baseline outside `vary`, an override of graders or the dataset, or a bad axis or baseline. `--plan` checks it without running. See [Experiments](https://coding.sh/docs/experiments#matrix). |
| `invalid_driver` | (toolevals) `Unknown agent "…"` or a malformed driver | Use `agent:<id>[:model]` or `model:<provider>/<model>`. |
| `invalid_arms` | (toolevals compare) a baseline or candidate that is not `<variant>@<driver>` | Use arm names from the experiment. |
| `bundle_mismatch` | `exp_… has no runs of good; it ran base and cand. Name the arm: --failing exp_…@<bundle>` (compare --failing) | The experiment did not run the arm `--failing` picked. Name one it ran after `@`. |
| `unsupported_target` | `compress works on MCP targets; gh is cli` | Run `compress` on an MCP target. |
| `unsupported_gateway` | `--gateway can route through vercel, openrouter, litellm, ramp; got "helicone"` | Pick one of those; other gateways are detect and enrich only. |
| `needs_driver` | (toolevals) `Variant old-text changes what the agent reads (descriptions); its reference commands can't fail on that. Pass --driver to run agent trials` | `validate --against` on a variant that changes only descriptions, hidden tools, a bundle or model settings: add `--driver <d>` so the kinded tasks run as agent trials. |
| `no_control` | `A continuation task needs a control arm: …` or `exp_… did not record a command or http task spec, so there is no control arm to replay` (exp run) | Run the recorded config as A and your change as B (`--arm control=… --arm cand=…`), or use `coding.sh exp ab`. `--no-control` runs it alone, without a noise floor. |
| `bad_arg` | `export what? one of sessions, events, labels` | Use one of the listed values. |
| `too_short` | `1 value shorter than 8 characters; a short value would rewrite ordinary text` (purge) | Put the whole secret on its line, not a fragment. |
| `read_only` | `DELETE is not allowed: coding.sh sql is read-only`, `only one statement is allowed (found text after ';')` | `coding.sh sql` only reads. Change data with the command that owns it. |
| `trace_incomplete` | `incomplete trace: 5 tool result(s) in the source but 3 reached the judge` (judge grade) | Tool calls in `--trace` did not reach the judge, a line was cut (`1 line(s) are not whole JSON`), a record is in no format the judge reads, or the file has no JSON records, so a grade would miss them. Fix the capture, or pass `--allow-partial-trace` to grade anyway. |

### Errors (exit 1)

The command ran and something failed.

| Reason | Example message | Fix |
|---|---|---|
| `store_unavailable` | `Couldn't open the coding.sh store: no index store for "foo://". Install the npm package "coding.sh-store-foo" …` | Check `[store]` in the config (`coding.sh config path`) and `CODING_SH_STORE_URL`. For `postgres://`, install `coding.sh-store-postgres` and check the database is reachable (`connect ECONNREFUSED` means it is not). |
| `store_owned` | `~/.coding.sh/index.db is at index schema v8, and this coding.sh 0.1.5 would migrate it to v9. Your hooks run the coding.sh 0.1.4 at …/dist/cli.mjs, which may not open v9.` | Another install owns the store. Ask the user, then run `coding.sh upgrade-store` from the install the hooks should run, or use the one the message names. See [A store another coding.sh can't open](#a-store-another-codingsh-cant-open). |
| `store_version` | `~/.coding.sh/index.db is at index schema v10. It was last written by coding.sh 0.1.6, and this coding.sh 0.1.6 is not a newer release, so it would migrate it to v11 only when asked.` | This build knows a newer schema than the release that wrote the store. Ask the user, then run `coding.sh upgrade-store` (it keeps a copy of the index; `--restore` puts it back), or use the release. |
| `store_newer` | `~/.coding.sh/index.db uses index schema v12, written by coding.sh 0.1.7, but this coding.sh 0.1.6 only knows up to v11. Your captures are safe: 12 capture files wait in the spool (…) and are indexed once a coding.sh that knows v12 runs.` | A newer coding.sh migrated the store. Update this one: `coding.sh update`. To go back instead, `coding.sh upgrade-store --restore` when the message offers it. `coding.sh status` still prints the home, the spool and `ingest stopped` before this error. |
| `no_backup` | `No index from before a migration is kept next to ~/.coding.sh/index.db: nothing to restore` | `upgrade-store --restore` found no `index.db.v<N>.bak` this coding.sh can open: none was kept, or a `coding.sh purge` deleted it. Update instead: `coding.sh update`. |
| `source_checkout` | `coding.sh is running from a source checkout (…), so it won't open your real store in ~/.coding.sh: …` | Set `CODING_SH_HOME` to a temp dir, or `CODING_SH_DEV_REAL_STORE=1` to use the real store. |
| `locked` | `Can't ingest: …` | Another ingest is running. Wait for it, then run `coding.sh ingest`. |
| `port_in_use` | `Can't start the collector: port 4318 is in use` | Stop the other process, or pass `--port 0` for any free port. Same for `ui`, `serve` and `proxy`. |
| `already_running` | `A coding.sh proxy is already running on http://127.0.0.1:4320 (pid 4182)` | Use the running one, or stop it first: `coding.sh proxy stop`. |
| `proxy_failed` | `The background proxy did not start` | Read `~/.coding.sh/proxy.log`, or run `coding.sh proxy` in the foreground to see the error. |
| `fetch_failed` | (compare --parity) `Couldn't fetch https://example.com/: …` | Check the URL and that the site is reachable from this machine. A fetch that takes over 30 s fails too. |
| `redirect_loop` | (compare --parity) `https://example.com/ redirects more than 10 times` | Open the URL in a browser or `curl -sI` it to see where the redirects go. |
| `command_failed` | (compare --parity) `"npm run render" exited 1 and printed no page` | Run the command yourself; it must print the page's HTML on stdout. |
| `not_found` | `Can't find session "nope"` (a session id or a unique prefix of one, 4+ characters), `No sessions captured yet`, `Can't find experiment "a"` | List what exists: `coding.sh sessions`, `exp list`, `dataset list`, `eval list`, `harness list`. |
| `bad_flag` | (usage) `--by must be one of agent, model, agent-model, day, repo` | Use one of the listed values. |
| `config_changed` | `Can't resume exp_…: its config changed since it started (dataset, task)` | `--resume` refuses when the dataset version, graders, trials, task, agent script or timeouts differ from the interrupted run. Restore them, or start a new run without `--resume`. |
| `target_exists` | `traces/ is not empty` (export --evidence) | Pass `--force` to write into it anyway, or pick an empty directory. |
| `already_complete` | `exp_… already finished; nothing to resume` | The run is done: `coding.sh exp show <id>`. |
| `busy` | `exp_… is still running (pid 4182 on desk); stop it first`, `an ingest is running and holds the store: …` (purge) | Another process is running it. Stop that process, or wait; `coding.sh exp status` shows its progress. For purge, try again in a minute. |
| `too_broad` | `the --rule patterns match more than 10000 distinct values, which is ordinary text, not one secret` (purge) | Anchor the pattern on the secret's prefix and length, and check it with `--dry-run`. |
| `cancelled_experiment` | `Experiment base (…) was cancelled after 3 case runs; comparing a partial result is misleading` | Re-run the experiment, or pass `--force` to `exp compare` to compare the partial result. |
| `arm_failed` | `arm cand: the first run failed: …` (exp metrics) | Run that arm's command by hand. It must exit 0 and print a JSON object of numbers. |
| `no_pairs` | `No pair finished in both arms, so there is nothing to compare` (exp metrics) | Read the run errors in the report, fix the arm, and rerun. |
| `unsupported_store` | `coding.sh sql reads the SQLite index; this store is postgres://…@db/csh`, `coding.sh purge rewrites the SQLite index; …`, a `--where` with event keys or bare words on a store plugin with no query path, or a key an older Postgres or ClickHouse plugin doesn't know | For sql, use `coding.sh export`, which reads every store, or query the database with its own client. For purge, remove the value with the database's own tools. For `--where`, upgrade the plugin, or use session keys only. |
| `timeout` | `the query ran past 10s and was stopped` (sql) | Narrow the query, or pass a longer `--timeout`. |
| `not_a_repo` | `not a git repository: /home/user/notes` (attribution, blame) | Run it inside the repository, or pass `--repo <dir>`. |
| `unknown_rev` | `no commit named no-such-branch in /work/demo` (attribution, blame) | Pass a branch, tag or commit that exists to `--rev`: `git log --oneline -n 20`. |
| `clickhouse_unreachable` | `Can't import from ClickHouse: can't reach ClickHouse at http://127.0.0.1:8123: ECONNREFUSED` (collector import) | Check the URL and port (8123, or 8443 with TLS) and that the server is up: `curl http://127.0.0.1:8123/ping`. `The import stopped after 5000 spans (455 sessions stored): …` means the connection dropped part-way and three more tries failed: those spans and their sessions are stored, so run the command it prints to read the rest. |
| `clickhouse_unauthorized` | `ClickHouse refused the credentials: … Authentication failed …` (collector import) | Pass the user and password in the URL or as `CLICKHOUSE_USER` and `CLICKHOUSE_PASSWORD`. |
| `clickhouse_error` | `ClickHouse error: …` (collector import) | Usually a bad `--where`. Check the condition in your own client, or run with `--dry-run` first. A missing table is `not_found`: name it with `--table db.table`. `The import stopped after … spans (… sessions stored): …` is ClickHouse failing on a later page (a memory or time limit): what was read is stored, and the command it prints reads the rest. |
| `sql_error` | `SQLite: no such column: foo` (sql) | List the tables and columns: `coding.sh sql "select name, sql from sqlite_schema"`. See [Query and export](reference/query.md). |
| `judge_error` | `The pairwise judge failed on every case: …` | Check the judge's `provider`, `model`, `baseURL` and API key variable, then re-run `exp compare --pairwise`. |
| `model_error` | ``Every model call failed (6 of 6 trials): claude-code: `claude -p` failed: …`` (exp ab) | Every replayed turn failed, so there is nothing to compare. Fix what the message names (the key, the login, the model name or the base URL), then run it again. When only some trials fail, exp ab warns and counts them as not passing. |
| `init_failed` | `no failed or flagged sessions in /work/demo in the last 14 days …` (eval init), a draft model that returned no usable JSON, or `evals/pdf has files eval init did not write, or that changed since: …` (eval init --force) | List flagged sessions with `coding.sh sessions --where is:flagged`, or name sessions with `--session <id>`. For a draft, check the provider and its API key. For --force, move the listed files out first, or pass `--force-all` to delete them. |
| `draft_suite` | `Suite pdf: 6 prompts in evals/pdf/triggers.toml still say TODO:` (eval run) | Write real prompts there, or have a model draft them: `coding.sh eval init pdf --skill <dir> --draft --force`. |
| `unsafe_edit` | `Can't set capture.mode: the edit would change other settings too` | Edit the config file by hand; the message prints its path. |
| `no_budget` | `answers has no budget_usd, so it can't be scheduled` | Add `budget_usd = 5` (or your cap) to the benchmark file. Printing the schedule works without one. |
| `ambiguous` | `2 tasks are named "…"`, `Session id prefix "9f1c" is ambiguous. It matches: …` | Pass one of the ids it prints, or more of the session id. |
| `exists` | `Target gh already exists in coding.sh.toml`, `bench/answers.toml already exists` | Pick another name, or `--force` where offered. |
| `conflict` | `Can't export to …: the directory is not empty` | Pick an empty directory, or add `--force`. |
| `no_agents` | `No supported agents found on this machine` | Install a supported agent, or use `coding.sh run -- <cmd>`. |
| `hook_missing` | `Can't find hook.mjs to install` | From a source checkout, run `npm run build` first. |
| `remote_unauthorized` | `https://obs.example.com refused the key. Nothing was changed` | `init --remote` needs an ingest key the server knows. A server with no configured keys prints its own on every start: `docker logs coding-sh`. |
| `remote_unreachable` | `Can't reach https://obs.example.com: …. Nothing was changed` | Check the URL and that the server is up: `curl -s <url>/healthz`. |
| `remote_not_serve` | `https://obs.example.com/v1/ingest answered 404: that is not a coding.sh serve that takes ingest` | The URL points somewhere else, or at a `serve --role viewer` replica. Use the server's base URL (the one that answers `/readyz`), with the ingest role. |
| `remote_error` | `https://obs.example.com/v1/ingest answered 503. Nothing was changed` | The server is up but not ready, often while it waits for its database. Check `curl -s <url>/readyz` and try again. |
| `statusline_exists` | `Claude Code already has a status line: ccusage statusline` (statusline install) | Keep it, or replace it with `coding.sh statusline install --force` (uninstall restores the old one). |
| `draft_failed` | `Couldn't draft a task from …: session … has no repo state; cannot build a task` | Record the session inside a git repository, ideally with `coding.sh run --`. |
| `no_tasks` | `No validated tasks to run` | `coding.sh eval new` then `eval validate`, or add tool-eval tasks. |
| `unsupported_agent` | `Agent aider has no headless driver, so bundle … can't be run`, `--run forks Claude Code sessions; this one is codex` | Use an agent that can run headless. For `replay --fork`, leave out `--run`: it sends the one call again for any proxied agent. |
| `nothing_to_ablate` | `nothing to ablate: … is in neither bundle base nor any selected task's repo` (exit 2) | Check the `--without` path against `coding.sh harness list --json`. |
| `missing_key` | `--gateway needs an AI Gateway key in $AI_GATEWAY_API_KEY` (or `--gateway openrouter needs a key in $OPENROUTER_API_KEY`), `exp ab replays your sessions against the model API: set ANTHROPIC_API_KEY`, `refine asks a model to write the edit: set ANTHROPIC_API_KEY` | Export the named variable, or set `[gateway] apiKeyEnv` / `[gateway.<name>] apiKeyEnv`. For `exp ab` and `refine`, logging in to Claude Code or Codex also works: they run on your subscription. Without either, commit the AGENTS.md edit and run `coding.sh improve check` once new sessions arrive. |
| `missing_cli` | ``--provider claude-code runs `claude`, which is not on PATH`` | Install Claude Code (or Codex for `--provider codex`), or set an API key and use `--provider anthropic` or `openai`. |
| `not_logged_in` | ``--provider claude-code: `claude` is not logged in`` | Run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`, or log in with `claude`; for Codex, `codex login`. |
| `no_rule` | `Issue 2 (npm test fails the same way in several sessions) has no line that fixes it: …` (improve fix) | Fix what the message says, such as the test command, instead of adding a line. |
| `missing_api_key` | `Driver model:anthropic/claude-sonnet-5 needs $ANTHROPIC_API_KEY`, `exp replay calls the Anthropic API with your own key, and $ANTHROPIC_API_KEY is not set`, `--fork calls the Anthropic API, and $ANTHROPIC_API_KEY is not set` | Export the variable it names, or for Anthropic a subscription token in `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`). `exp replay` and `--fork` never reuse the agent's login (it is not stored). |
| `no_calls` | `This session has no model calls with stored requests` (replay --fork) | Capture the session through the proxy (`coding.sh init --proxy`) with `capture.mode = "full"`, then run the agent again. |
| `no_call` | `No stored model call comes before step 3` (replay --fork) | Fork a later step: the proxy started after that step's call. |
| `bad_step` | `step 40 is past the last step (31)` (replay --fork) | `coding.sh replay <session>` lists the steps. |
| `bad_with` | `--with "=x.md": expected DEST=SRC or a path`, `--with ../x.md is outside the fork's directory` | Give `--with AGENTS.md=fixed.md`, or a path inside the project or under `~/`. |
| `no_workdir` | `The session's directory /work/demo is not on this machine, so the fork has nothing to start from` (replay --fork --run) | Run it on the machine the session ran on, or fork without `--run`. |
| `workdir_exists` | `/tmp/fork already exists` (replay --fork --run --workdir) | Pick a new `--workdir`, or leave it out for a temp dir. |
| `no_prompt` | `The stored request has no prompt to start the agent with` (replay --fork --run) | Fork a step whose call starts from a user prompt, or fork without `--run`. |
| `nothing_to_check` | `Step 4's recorded reply was text, and the fork gave no single tool call to expect instead` (replay --fork --save-case) | Fork with a few trials first (`-k 3`), so the case has a tool call to expect. |
| `insufficient_data` | `Not enough to distill from: the corpus has 8 episodes; distilling needs at least 20` (refine distill) | Run more tasks or look further back (`--since 90d --repo all`), or lower the bar with `--min-episodes` and `--min-failures`. |
| `invalid_file` | `Couldn't import cases.csv: …`, `2 problems in labels labels.jsonl` (refine score) | Fix the file. Datasets accept JSONL, JSON and CSV. refine score prints each problem with its line number. |
| `invalid_config` | `Can't read config: …`, `Invalid serve configuration: …` (exit 2) | Fix the file or variable named in the message. See [Configuration](reference/config.md). |
| `no_config` | `No coding.sh.toml found in … or its parents` | `coding.sh toolevals init --cli <bin>` |
| `surface_failed` | `Couldn't read the gh surface: …` | The CLI or MCP server could not be started or listed. Run it by hand to see why. |
| `invalid_definition` | `bench/answers.toml: …` | Fix the benchmark file. |
| `invalid_cases` / `no_cases` | `Can't read cases from …`, `No cases in …`, `No decision points in sessions since 14d` (exp ab, exit 2) | Check the workflow's cases directory. For `exp ab`, look further back (`--since 30d`) or in every repo (`--repo all`); the message lists what each behavior found. |
| `no_diff` | `Session … has no captured diffs`, `No stored runs in experiment exp_…` (judge slop, exit 2) | The agent's capture records no diffs for its file changes, or the experiment is not a `compare` run (only those keep the agent's diff). Grade a diff directly: `git diff \| coding.sh judge slop --diff -`. |
| `over_budget` | `Estimated cost $3.10 is over --max-cost $1.00` (exp ab) | Test fewer decision points (`--limit`), or raise `--max-cost`. A run that passes the cap partway stops and can be resumed. |
| `cost_unknown` | `--budget needs a cost per run, and none is known: no cost known for 4 tasks (…)` (compare) | No stored run, source session or other task says what a run costs. Pass `--cost-per-run <USD>`. |
| `budget_too_small` | `--budget $0.10 fits no task: the cheapest costs $0.20 a run, times 2 arms x 1` (compare) | Raise `--budget`, or lower `--k`. |
| `bad_proposal` | `The proposer's reply is not a usable edit: …`, `… is not a usable cut: …` (refine propose, refine run) | Try again, or write the edit yourself and run `refine test` on it. `refine run` asks again and stops after three unusable replies in a row. |
| `proposer_failed` | `--proposer-command exited 1: …` (refine propose, refine run) | Run the command by hand with the prompt on stdin; it must print the JSON reply on stdout and exit 0. |
| `not_kept` | `r_… was not kept (reject: …)` (refine apply) | Apply only kept candidates, or pass `--force` to apply it anyway (the ledger records it). |
| `files_changed` | `AGENTS.md changed since r_… was tested`, `… changed since r_… was applied` (refine apply, refine rollback) | Run `refine test r_…` again on the current files, or pass `--force`. A forced rollback loses your later edits to the file. |
| `applied_over` | `r_… was applied over r_… on the same file; roll it back first` (refine rollback) | Roll back the newest apply first. |
| `already_applied` | `r_… is already in the working tree` (refine apply, exit 0) | Nothing to do. |
| `no_recordings` | `exp_… has no recorded model calls to replay` (exp run --replay) | Record a run first with `coding.sh exp run spec.json --record`, then replay that experiment. See [how-to/replay-llm-calls.md](how-to/replay-llm-calls.md). |
| `not_replayable` | `None of these calls can be replayed` (exp replay) | Replay needs calls logged by `coding.sh proxy` with `capture.mode = "full"`: in `metadata` mode the request is not stored. |
| `missing_script` | `Run … has no captured script` | The workflow run can't be replayed. |
| `score_failed` | `Couldn't score wf_… on case-3: …` (workflows score) | The case's scorer threw. Check the case's truth file and, for a judge, its provider and API key. |
| `adaptive_samples` | `Experiment … ran adaptive samples: its trial count depends on its outcomes, so a paired CI over it is biased` (exp compare, toolevals compare) | Compare runs with a fixed trial count (`--trials`, `-k`). `exp compare --force` compares anyway. |
| `invalid_baseline` | `Baseline texp_… ran none of these tasks` (toolevals run --stop-on-regression) | Pass a baseline experiment of the same target and tasks. |
| `no_release` | `No coding.sh release has been published yet` | Install from source. |
| `update_check_failed` | `Couldn't check for updates: …` | Usually offline. Try again later. |
| `install_failed` | `npm install failed (exit 1): …` | Run the npm command it printed yourself to see the full error. |
| `no_install_target` | `coding.sh v… is out, but the release has no installable package` | Install with the one-line installer instead. |
| `error` | Any other failure. | Re-run with `--debug` and [open an issue](https://github.com/jackulau/coding.sh/issues). |

### Canceled (exit 130)

| Reason | Means |
|---|---|
| `canceled` | You answered no, or pressed Ctrl-C. `Canceled. Nothing was changed`. |

## Still stuck

- `coding.sh <command> --help` shows every option.
- `--debug` adds a stack trace to any error.
- [Open an issue](https://github.com/jackulau/coding.sh/issues) with the output of
  `coding.sh doctor --json` and `coding.sh version`. Check it for paths you'd rather not share first.
