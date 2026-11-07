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

doctor exits 1 only when the spool or the store fails. The other rows are information.

| Row says | Means | Fix |
|---|---|---|
| `not hooked` | The agent is installed but has no coding.sh hook in its user config or in a project doctor checked, and no events in the last 5 minutes. | `coding.sh init --agent <id>` |
| `hooked in <file> (project)` | The hook is in a project's config (`init --scope project`), not the user config. doctor looks in the current directory, its parents and the directories the agent's recent sessions ran in. The agent is captured in that project only. | Nothing, or `coding.sh init --agent <id>` to capture every project. |
| `events arriving, hook not in user config` | Events came in during the last 5 minutes, but doctor found no hook in the user config or a project it checked. | Nothing if those sessions are the ones you want. Run doctor from the project to see its hook. |
| `hooked but not firing` | The hook is in place but the agent will not run it. The note under the row says why (see below). | Follow the note. |
| `no events yet` | Nothing captured from this agent. Normal right after `init`. | Use the agent, then `coding.sh sessions`. |
| `reads its store` / `no store yet` | Host apps such as T3 Code are read from their own database, not hooks. | Nothing to do. |
| `Hook missing at …/bin/hook.mjs` | `init` has not run, or the file was deleted. | `coding.sh init` |
| `Hook …/bin/hook.mjs is stale` | The hook bin is from another coding.sh version, or `bin/cli-path` names another install. The agent configs are fine. After an upgrade in place (`npm i -g`), the `coding.sh ingest` the hook starts at the next session end refreshes the bin by itself. | `coding.sh update --refresh-bin` |
| `Spool … not writable` | coding.sh can't write to `~/.coding.sh/spool` (or `$CODING_SH_HOME/spool`). | Fix the directory's owner or permissions. |
| `Store can't open: …` | The index could not be opened. The message has the cause. | See `store_unavailable` below. |
| `Receiver port 4318 in use` | Something listens on the OTLP port, usually `coding.sh collector`. | Nothing, or `doctor --port <n>` to check another port. |
| `Agents none detected` | No supported agent was found on PATH or in its usual config dir. | Capture any command with `coding.sh run -- <cmd>`. |

Notes that mean a hook will not fire:

- **Codex: `coding.sh hook(s) not trusted yet`.** Codex runs a new or changed hook only after you
  approve it. Start `codex`, run `/hooks` and approve the coding.sh entries. coding.sh never writes
  trust state for you.
- **Codex: `hooks are disabled in config.toml ([features] hooks = false)`.** Remove that line or set
  it to `true` in `~/.codex/config.toml`.
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
7. **Is it older than `init`?** Import past transcripts with `coding.sh ingest --backfill --since 30d`.
   Re-running it adds nothing new.

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

- **No model latency or tokens.** Hooks see tool calls, not model calls. Most adapters recover
  model calls from the agent's transcript after the session ends. For measured latency from Claude
  Code, turn on its OpenTelemetry export and run `coding.sh collector`.
- **No cost.** Most coding-agent transcripts carry tokens, not dollars. See
  [Find your most expensive sessions](how-to/expensive-sessions.md#where-cost-comes-from).
- **Prompts and tool output are missing.** `capture.mode` is `metadata`, or a repo's
  `.coding.sh/config.toml` set it. Check with `coding.sh config get capture.mode`.
- **Text shows `[redacted:<kind>]`.** A redactor matched it. Redaction runs before anything is
  stored. See [Configuration](reference/config.md#capture).
- **Cursor headless runs have no prompt or reply.** `cursor-agent -p` does not fire the prompt and
  response hooks. This is a Cursor limitation.
- **`eval new` fails with `has no repo state`.** The session did not run inside a git repository,
  so there is no start state to replay. Record it with `coding.sh run --` from inside the repository.
  See [Turn a session into an eval](how-to/session-to-eval.md).

## Old sessions show doubled counts

Sessions captured before an upgrade keep the rows the older coding.sh parsed. When an adapter's
parsing changes, coding.sh re-parses that agent's stored sessions in the background, from their
transcripts and from the hook lines still in the spool. This runs on the next session end, read
or viewer start after the upgrade. Each session is swapped in one step, so reads never wait or see
it half done.

- **Do it now.** `coding.sh ingest --rebuild` re-parses every session. Add `--agent pi` for one
  agent. It prints how many sessions it re-parsed and how many it kept.
- **Some sessions were kept.** A session whose transcript is gone, and whose hook lines gc removed
  (`retention.keepSpoolDays`, 7 days by default), keeps its rows. Rows that repeat another row
  of the same call or prompt are still removed. `coding.sh ingest --rebuild --json` lists each
  kept session with the reason.
- **Nothing happens.** Re-parse needs the local SQLite index (or a store plugin that supports it),
  and `CODING_SH_NO_AUTO_INGEST=1` turns off the background run. `--rebuild` still works.

## Errors by reason

Every error prints a message and, usually, the next command to try. With `--json` it is one line on
stderr:

```json
{"status":"error","reason":"not_found","message":"Can't find session \"nope\"","next":["List sessions:","coding.sh sessions"]}
```

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
| `confirmation_required` | `Set up coding.sh for 1 agent (2 config files, backed up first) needs confirmation. Pass --yes to confirm` | Not a terminal, so it can't ask. Re-run with `--yes`, or `--dry-run` first to see the changes. |
| `insecure_bind` | `refusing to listen on 0.0.0.0 without auth: …` | Set `CODING_SH_INGEST_KEYS` and `CODING_SH_READ_KEYS` (make keys with `coding.sh serve keygen`), or pass `--insecure` on a trusted network. |
| `unknown_agent` | `Unknown agent "claude"` | Use an agent id from [Coding agents](https://coding.sh/docs/agents). |
| `unknown_key` | `Can't set "capture.mod". Settable keys: …` | Use a key from [Configuration](reference/config.md). |
| `invalid_case` | (dataset add) a case that is not `{"input":…}` JSON | Fix the `--case` JSON. |
| `invalid_grader` | `Invalid grader: …` | Fix the `--grader` JSON. See [Evals](https://coding.sh/docs/evals#graders). |
| `invalid_matrix` | `Invalid matrix in matrix.json: …` (exp run) | Fix the spec: a cell that differs from the baseline outside `vary`, an override of graders or the dataset, or a bad axis or baseline. `--plan` checks it without running. See [Evals](https://coding.sh/docs/evals#matrix). |
| `invalid_driver` | (toolevals) `Unknown agent "…"` or a malformed driver | Use `agent:<id>[:model]` or `model:<provider>/<model>`. |
| `invalid_arms` | (toolevals compare) a baseline or candidate that is not `<variant>@<driver>` | Use arm names from the experiment. |
| `unsupported_target` | `compress works on MCP targets; gh is cli` | Run `compress` on an MCP target. |
| `no_control` | `A continuation task needs a control arm: …` (exp run) | Run the recorded config as A and your change as B (`--arm control=… --arm cand=…`), or use `coding.sh exp ab`. `--no-control` runs it alone, without a noise floor. |

### Errors (exit 1)

The command ran and something failed.

| Reason | Example message | Fix |
|---|---|---|
| `store_unavailable` | `Couldn't open the coding.sh store: no index store for "foo://". Install the npm package "coding.sh-store-foo" …` | Check `[store]` in the config (`coding.sh config path`) and `CODING_SH_STORE_URL`. For `postgres://`, install `coding.sh-store-postgres` and check the database is reachable (`connect ECONNREFUSED` means it is not). |
| `locked` | `Can't ingest: …` | Another ingest is running. Wait for it, then run `coding.sh ingest`. |
| `port_in_use` | `Can't start the collector: port 4318 is in use` | Stop the other process, or pass `--port 0` for any free port. Same for `ui` and `serve`. |
| `not_found` | `Can't find session "nope"` (a session id or a unique prefix of one, 4+ characters), `No sessions captured yet`, `Can't find experiment "a"` | List what exists: `coding.sh sessions`, `exp list`, `dataset list`, `eval list`, `harness list`. |
| `bad_flag` | (usage) `--by must be one of agent, model, agent-model, day, repo` | Use one of the listed values. |
| `config_changed` | `Can't resume exp_…: its config changed since it started (dataset, task)` | `--resume` refuses when the dataset version, graders, trials, task, agent script or timeouts differ from the interrupted run. Restore them, or start a new run without `--resume`. |
| `already_complete` | `exp_… already finished; nothing to resume` | The run is done: `coding.sh exp show <id>`. |
| `busy` | `exp_… is still running (pid 4182 on desk); stop it first` | Another process is running it. Stop that process, or wait; `coding.sh exp status` shows its progress. |
| `cancelled_experiment` | `Experiment base (…) was cancelled after 3 case runs; comparing a partial result is misleading` | Re-run the experiment, or pass `--force` to `exp compare` to compare the partial result. |
| `arm_failed` | `arm cand: the first run failed: …` (exp metrics) | Run that arm's command by hand. It must exit 0 and print a JSON object of numbers. |
| `no_pairs` | `No pair finished in both arms, so there is nothing to compare` (exp metrics) | Read the run errors in the report, fix the arm, and rerun. |
| `judge_error` | `The pairwise judge failed on every case: …` | Check the judge's `provider`, `model`, `baseURL` and API key variable, then re-run `exp compare --pairwise`. |
| `unsafe_edit` | `Can't set capture.mode: the edit would change other settings too` | Edit the config file by hand; the message prints its path. |
| `no_budget` | `answers has no budget_usd, so it can't be scheduled` | Add `budget_usd = 5` (or your cap) to the benchmark file. Printing the schedule works without one. |
| `ambiguous` | `2 tasks are named "…"`, `Session id prefix "9f1c" is ambiguous. It matches: …` | Pass one of the ids it prints, or more of the session id. |
| `exists` | `Target gh already exists in coding.sh.toml`, `bench/answers.toml already exists` | Pick another name, or `--force` where offered. |
| `conflict` | `Can't export to …: the directory is not empty` | Pick an empty directory, or add `--force`. |
| `no_agents` | `No supported agents found on this machine` | Install a supported agent, or use `coding.sh run -- <cmd>`. |
| `hook_missing` | `Can't find hook.mjs to install` | From a source checkout, run `npm run build` first. |
| `draft_failed` | `Couldn't draft a task from …: session … has no repo state; cannot build a task` | Record the session inside a git repository, ideally with `coding.sh run --`. |
| `no_tasks` | `No validated tasks to run` | `coding.sh eval new` then `eval validate`, or add tool-eval tasks. |
| `unsupported_agent` | `Agent aider has no headless driver, so bundle … can't be run` | Use an agent that can run headless. |
| `nothing_to_ablate` | `nothing to ablate: … is in neither bundle base nor any selected task's repo` (exit 2) | Check the `--without` path against `coding.sh harness list --json`. |
| `unsupported_gateway` | `--gateway can route through vercel, openrouter, litellm, ramp; got "helicone"` | Pick one of those; other gateways are detect and enrich only. |
| `missing_key` | `--gateway needs an AI Gateway key in $AI_GATEWAY_API_KEY` (or `--gateway openrouter needs a key in $OPENROUTER_API_KEY`) | Export the named variable, or set `[gateway] apiKeyEnv` / `[gateway.<name>] apiKeyEnv`. |
| `missing_api_key` | `Driver model:anthropic/claude-sonnet-5 needs $ANTHROPIC_API_KEY` | Export the variable it names. |
| `invalid_file` | `Couldn't import cases.csv: …`, `2 problems in labels labels.jsonl` (refine score) | Fix the file. Datasets accept JSONL, JSON and CSV. refine score prints each problem with its line number. |
| `invalid_config` | `Can't read config: …`, `Invalid serve configuration: …` (exit 2) | Fix the file or variable named in the message. See [Configuration](reference/config.md). |
| `no_config` | `No coding.sh.toml found in … or its parents` | `coding.sh toolevals init --cli <bin>` |
| `surface_failed` | `Couldn't read the gh surface: …` | The CLI or MCP server could not be started or listed. Run it by hand to see why. |
| `invalid_definition` | `bench/answers.toml: …` | Fix the benchmark file. |
| `invalid_cases` / `no_cases` | `Can't read cases from …`, `No cases in …`, `No decision points in sessions since 14d` (exp ab, exit 2) | Check the workflow's cases directory. For `exp ab`, look further back (`--since 30d`) or in every repo (`--repo all`); the message lists what each behavior found. |
| `no_diff` | `Session … has no captured diffs`, `No stored runs in experiment exp_…` (judge slop, exit 2) | The agent's capture records no diffs for its file changes, or the experiment is not a `compare` run (only those keep the agent's diff). Grade a diff directly: `git diff \| coding.sh judge slop --diff -`. |
| `over_budget` | `Estimated cost $3.10 is over --max-cost $1.00` (exp ab) | Test fewer decision points (`--limit`), or raise `--max-cost`. A run that passes the cap partway stops and can be resumed. |
| `bad_proposal` | `The proposer's reply is not a usable edit: …` (refine propose, refine run) | Try again, or write the edit yourself and run `refine test` on it. |
| `not_kept` | `r_… was not kept (reject: …)` (refine apply) | Apply only kept candidates, or pass `--force` to apply it anyway (the ledger records it). |
| `files_changed` | `CLAUDE.md changed since r_… was tested`, `… changed since r_… was applied` (refine apply, refine rollback) | Run `refine test r_…` again on the current files, or pass `--force`. A forced rollback loses your later edits to the file. |
| `applied_over` | `r_… was applied over r_… on the same file; roll it back first` (refine rollback) | Roll back the newest apply first. |
| `already_applied` | `r_… is already in the working tree` (refine apply, exit 0) | Nothing to do. |
| `missing_script` | `Run … has no captured script` | The workflow run can't be replayed. |
| `unsupported_truth` | `Case … is graded by a judge; the CLI scores seeded-bugs and verifier cases only` | Score it in the viewer. |
| `cost_confirmation_required` | `Estimated cost $7.20 exceeds confirmAboveUsd $5.00` | With `--json` this is `{"status":"action_required",…}`. Re-run with `--yes`, or raise `[toolevals] confirmAboveUsd`. |
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
