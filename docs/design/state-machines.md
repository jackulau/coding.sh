# State machines

Every explicit and implicit state machine in `packages/coding.sh`, with states, invariants and transition tables, plus the invalid states and transitions the code could actually reach. Each finding was reproduced with a script under a temp HOME, or follows from a code path with only one outcome. Audit of the 2026-11-06 working tree. File:line references point at that tree and drift as the code changes.

Status values: `open`, `fixing`, `fixed` (regression test added), `deferred` (reason given).

## Issues, by impact

### Issue A: Concurrent ingest can double-deliver, stall or lose events

| id | severity | confirmed | finding | status |
|---|---|---|---|---|
| CAP-1 | high | yes | Ingest lock lets two holders in: isStale() is true on ENOENT and the stale lock is broken with an unconditional rmSync | fixed (regression test added) |
| CAP-2 | medium | yes | A leftover lock file (dead holder) disables every hook-triggered background ingest | fixed (regression test added) |
| INS-5 | medium | yes | A stale ingest lock disables every hook-started background ingest (sinks and auto-ingest stall indefinitely) | fixed (regression test added) |
| CAP-3 | medium | yes | Lost wakeup: a Stop captured while an ingest holds the lock is not ingested by anyone | fixed (regression test added) |
| CAP-4 | medium | yes | gc deletes spool files but keeps their cursors (and runs without the ingest lock); a file recreated at the same path is read from a stale offset | fixed (regression test added) |
| STO-5 | low | yes | gc stat→delete is not atomic with a concurrent ingest dedupe hit, leaving an event that references a deleted blob | fixed (gc lock + rename-recheck delete; tiny crash window remains) |
| STO-8 | low | no | Writer-lock lease: a same-host standby can break a live holder after a 2-minute heartbeat gap, and the holder never re-checks | fixed (writer fence + standby; regression tests) |
| CAP-5 | low | yes | Raw spill side file orphaned when the spool append fails or the hook dies between the two writes; gc can never delete it | fixed (regression test added) |
| CAP-6 | low | yes | Torn final line (partial write) is never consumed or gc'd, and fuses with the next line appended to the same path | fixed (regression test added) |
| CAP-7 | low | yes | Spool files are ingested in pid-string order, not time order, so tool.end can precede its tool.start and lose its duration | fixed (regression test added) |

### Issue B: Retention and blob storage lose or corrupt data

| id | severity | confirmed | finding | status |
|---|---|---|---|---|
| STO-1 | high | yes | Retention corrupts sqlite FTS when a deleted session has a message with empty text | fixed (regression test added) |
| STO-2 | high | yes | Retention deletes live sessions: cutoff uses coalesce(ended_at, started_at), not last activity | fixed (regression test added) |
| STO-3 | medium | yes | gc sweeps blobs still held by EvalTask.validation.impossible.variant.hiddenFiles and toolevals TrialResult.tapBlob | fixed (store side + tapBlob write side) |
| STO-4 | medium | yes | FsBlobStore: no fsync on put, a torn blob is never healed by re-put, and get() returns 0 bytes silently | fixed (regression test added) |
| STO-6 | low | yes | FileEvalStore file mode: putDataset is 3 unlocked writes, so history drifts permanently on crash or concurrency | fixed (regression test added) |
| STO-7 | low | yes | memory vs sqlite IndexStore differ for the same calls: getBundle tie-break, listExperiments limit 0, dataset version order | fixed (regression test added) |

### Issue C: Cancelled or broken experiment runs look like real results

| id | severity | confirmed | finding | status |
|---|---|---|---|---|
| EXP-1 | high | yes | Ctrl-C during exp run persists the partial experiment as a normal completed result; aborted/killed trials are stored as failures | fixed (regression test added) |
| EXP-2 | high | yes | compare (runner), eval validate and toolevals run ignore the first SIGINT; the second hard-exits, leaking detached agent process groups and runs/<id>/work dirs | fixed (regression test added) |
| EXP-3 | medium | yes | SIGTERM (no handler) orphans every detached child and discards all completed exp run trials | fixed (regression test added) |
| EXP-4 | medium | yes | Command grader treats any parseable stdout as the grade even when the grader crashed, exited non-zero or was killed; an aborted grade is recorded as a FAIL rather than an error | fixed (regression test added) |
| EXP-5 | medium | yes | Processes settle on 'close', so a command that exits 0 but leaves a background child holding stdout is reported as a timeout after the full timeout (and never settles when timeout is 0) | fixed (regression test added) |
| EXP-6 | medium | yes | Grader errors (e.g. LLM judge HTTP 529 after retries) make the case-trial a failure, so infrastructure outages show up as regressions in exp compare | fixed (regression test added) |
| EXP-7 | low | yes | A tool-eval trial whose sandbox setup fails leaks its sandbox dir even without --keep | fixed (regression test added) |
| EXP-8 | low | yes | The runner compare note claims errored runs count as failures, but an errored run (agent timeout, crash, diff failure) that passes the verifier counts as a pass | fixed (regression test added) |

### Issue D: Session stats double-count or freeze

| id | severity | confirmed | finding | status |
|---|---|---|---|---|
| SES-1 | high | yes | Hook + transcript copies of one Claude session double-count turns (and prompts in metadata mode / reversed order / redaction) | fixed (regression test added) |
| SES-2 | medium | yes | Backfill of a live Claude transcript writes a stale synthesized EOF turn.end; the real end is added later (double turn, wrong duration) | fixed (regression test added) |
| SES-3 | medium | yes | endedAt is never invalidated by later activity: resumed/continued sessions report ended; Codex endedAt frozen at the first SessionEnd | fixed (regression test added) |
| SES-4 | medium | yes | T3 Code v1 (and opencode) session usage-summary keyed ['usage-summary']: first token snapshot wins forever | fixed (regression test added) |
| SES-6 | medium | yes | Stop-hook continuation (stop_hook_active) counts one prompt as multiple turns | fixed (regression test added) |
| SES-5 | low | yes | Codex backfill emits subagent.end for still-running child threads; never corrected | fixed (regression test added) |
| SES-7 | low | yes | toolCalls = max(starts, ends) undercounts when one call has only a start and another only an end | fixed (regression test added) |

### Issue E: Install and config writes damage user files

| id | severity | confirmed | finding | status |
|---|---|---|---|---|
| INS-1 | high | yes | `config set <table>.<key>` edits or inserts the key inside a following [[sinks]] table, silently flipping a remote sink to full capture | fixed |
| INS-2 | medium | yes | atomicWrite/applyWrites replace a symlinked agent config with a regular file (dotfiles detached permanently) | fixed |
| INS-3 | medium | yes | After `codex mcp add`, the coding.sh MCP block in Codex config.toml loses its BEGIN marker: uninstall leaves our server, init never updates it | fixed |
| INS-4 | medium | yes | Gemini settings.json: hook install parses JSONC but writes plain JSON (comments lost for good); the MCP writer on the same file rejects JSONC (partial first init) | fixed |
| INS-6 | medium | yes | `coding.sh update` never refreshes ~/.coding.sh/bin/hook.mjs or cli-path; doctor reports the stale hook as healthy | fixed |
| INS-7 | medium | yes | MCP registration pins process.execPath and the cli.mjs that ran init (nvm-versioned node, npx cache): breaks silently on node switch, cache eviction or prefix change | fixed |
| INS-9 | low | yes | Cursor hooks (no marker) installed under one CODING_SH_HOME are not recognized under another: re-init duplicates every hook, uninstall leaves the old ones | fixed |
| INS-10 | low | no | User-scope and project-scope installs coexist with no warning or dedupe, which may double-capture every event | fixed |

### Issue F: Project isolation on a shared server

| id | severity | confirmed | finding | status |
|---|---|---|---|---|
| INS-8 | medium | yes | A default-project ingest key can write into any other project's sessions by sending sessionId `<project>/<id>` | fixed (regression test added) |

### Issue G: Viewer, MCP and workflow records drift from the store

| id | severity | confirmed | finding | status |
|---|---|---|---|---|
| VWR-1 | medium | yes | Sessions 'Load more' offset pagination repeats rows when sessions are ingested between pages | fixed (regression tests in test/viewer) |
| VWR-2 | medium | yes | 'Load more' response is appended to a different filter's list (no load sequencing) | fixed (regression tests in test/viewer) |
| VWR-3 | medium | yes | A failed search leaves list.error set, so later successful searches still render the error panel | fixed (regression tests in test/viewer) |
| VWR-6 | medium | yes | Workflow experiment record loses writes (score during a run; concurrent job rewrites) | fixed (append-only runs log; regression tests) |
| VWR-4 | low | yes | Expanded subagents persist into the flat 'Include subagents' scope, duplicating child rows | fixed (regression tests in test/viewer) |
| VWR-5 | low | yes | Search results ignore the flag, repo and scope filters while their chips show as pressed | fixed (regression tests in test/viewer) |
| VWR-7 | low | yes | Partially ingested sessions: events are visible and searchable before the session row exists or is recomputed | fixed (regression tests in test/viewer) |
| VWR-8 | low | yes | MCP resources/list offset cursor repeats or skips sessions during concurrent ingest | fixed (keyset cursor; regression tests) |

## Machines by subsystem

## Capture pipeline

Scope: the hook entry (`src/spool/{hook,host,kick,write}.ts`, `src/cli/hookbin.ts`), spool reading (`src/core/spool-read.ts`), ingest (`src/core/{ingest,lock,context}.ts`), spool gc (`src/core/gc.ts`) and the periodic readers (`src/cli/common.ts`, `src/cli/commands/{ui,ingest}.ts`, `src/mcp/server.ts`). File:line refs point at the working tree as of 2026-11-06.

### M1. Hook process (one process per agent hook call)

States: `Start → StdinRead → (Disabled | Parsed | Spilled) → Appended → Replied → Kicked → Exit(0)`. Any error goes to `errors.log` and then `Replied`.

Invariants: the hook always exits 0. Stdout carries only the `--echo-continue`/`--reply` payload. Exactly one spool line per call, appended to the agent's shared day file `<agent>/<utcDay(ts)>.jsonl` (continued in `<utcDay(ts)>.<n>.jsonl` once a file reaches 64 MB). Before, every hook call created its own `<utcDay(ts)>.<pid>.jsonl`.

| From | Event | To | Guard | Ref |
|---|---|---|---|---|
| Start | fd0 is a TTY or closed | StdinRead (empty) | – | hook.ts:49-55 |
| Start | read until EOF, or 10 s of EAGAIN with no data | StdinRead | capped at 64 MB, then drained | hook.ts:62-85 |
| StdinRead | `CODING_SH_DISABLE=1` | Replied | – | hook.ts:119 |
| StdinRead | ≤256 KB and not truncated | Parsed (JSON or plain string) | – | hook.ts:122-130 |
| Parsed / too big | serialized line >256 KB | Spilled: raw written `wx` to `raw/<ts>-<pid>-<rand>.json` | – | write.ts:87-103 |
| Spilled / Parsed | `appendFileSync(O_APPEND)` | Appended | – | write.ts:107, 46-54 |
| any | throw | errors.log | – | hook.ts:152-154 |
| Appended | END_EVENT matches | Kicked (M5) | captured, not RUN_ID, not NO_AUTO_INGEST | hook.ts:171-177, kick.ts:23 |

### M2. Spool file lifecycle (per `source = <agent>/<day>.jsonl`, `<day>.<n>.jsonl`, or a legacy `<day>.<pid>.jsonl`)

States: `Absent → Growing → PartiallyRead (cursor < size) → LocallyRead (local cursor = size) → FullyRead (local and every configured sink ≥ size) → Eligible (mtime older than keepSpoolDays) → Deleted`.

Abnormal states: `TornTail` (last line has no `\n`), `Recreated` (same path after Deleted, with cursors still set), `CursorPastEnd` (cursor > size).

| From | Event | To | Guard | Ref |
|---|---|---|---|---|
| Absent | first append (0600, dir 0700) | Growing | – | write.ts:46-54 |
| Growing | ingest reads complete lines | PartiallyRead / LocallyRead | a line without `\n` is never consumed | spool-read.ts:110-112 |
| PartiallyRead | checkpoint | cursor = readPos (a line boundary) | readPos > local | ingest.ts:346-357 |
| LocallyRead | sink acks a batch | FullyRead | per-line cursor | ingest.ts:277-318 |
| FullyRead | `coding.sh gc` | Deleted (raw side files too) | `now − mtime ≥ keepSpoolDays` and all cursors ≥ size; **no ingest lock taken** | gc.ts:125-143 |
| Deleted | same path is written again | **Recreated with a stale cursor** (invalid) | pid reuse on the same UTC day, or the wrapper | gc.ts:134-139 (cursors not cleared) |
| any | cursor > size at ingest | local cursor reset to 0 (sink cursors not reset) | – | ingest.ts:321-325 |
| Growing | partial `write(2)` (ENOSPC/EIO) | **TornTail: never consumed, never gc'd** (invalid) | – | spool-read.ts:112, gc.ts:130 |

### M3. Ingest lock (`spool/.ingest.lock`, file created with O_EXCL holding `{pid,host,ts}`)

States: `Free`, `Held(owner)` (heartbeat refreshes the mtime every 15 s), `Torn` (content unreadable, judged by mtime only), `Stale` (holder is a dead pid on this host, or the mtime is more than 2 min old), `Released`. **Invariant: at most one holder.**

| From | Event | To | Guard | Ref |
|---|---|---|---|---|
| Free | `tryCreate` (`open wx`) | Held | – | lock.ts:77-91, 101 |
| Held | contender's `isStale` is true | contender `rmSync`s, then retries the create | `isStale` returns true when the file is **gone (ENOENT)**, the holder pid is dead, or the mtime is old | lock.ts:65-75, 102-104 |
| Held | timer | Held (mtime refreshed; also touches a successor's file) | – | lock.ts:109-116 |
| Held | `release()` | Free | `readHolder().pid === process.pid` | lock.ts:121-127 |
| Held | SIGKILL, power loss, `process.exit(130)` on second Ctrl-C, default SIGTERM/SIGHUP | **Orphaned file** (dead pid) | `finally` never runs | main.ts:272, ingest.ts:151-155 |
| Held | contender ENOENT window, or two breakers of one stale lock | **TwoHolders** (invalid; reached) | unconditional `rmSync` | lock.ts:103 |
| Held | holder's event loop stalls or the laptop sleeps for more than 2 min | broken by a peer while the holder keeps writing (no fencing) | – | lock.ts:74, 109 |

Lock users: `ingest --background` (waitMs 0, ingest.ts cmd:21), `autoIngest` in reads and every 3 s in the ui (waitMs 1500, common.ts:35), MCP (waitMs 1000, mcp/server.ts:71), manual `ingest`, `compare`, `toolevals` (waitMs 30 s). **Not under the lock:** `tailIngest`/backfill (common.ts:44-58, ingest.ts cmd:22) and `gc`.

### M4. Cursor progression (per consumer × source; consumer is `local` or `sink:<name>`)

States: `0 → k (line boundary) → size`. Sinks also have `Active ⇄ BackingOff(retryAt)`, stored under `sink:<name>#retryAt`.

| From | Event | To | Guard | Ref |
|---|---|---|---|---|
| local=k | checkpoint after flush + recompute | readPos | readPos > in-memory `local` (read once per file) | ingest.ts:350-353 |
| sink=k | ack ok | `nextOffset` of the last line in the batch | lines never split across batches | ingest.ts:285-314 |
| sink=k | trailing lines with no events | readPos | – | ingest.ts:317 |
| Active | write throws or `!ok` | BackingOff(now + retryAfter, or 10 min) | – | ingest.ts:302-309 |
| BackingOff | `retryAt ≤ now` at the start of a run | Active (re-reads from its cursor) | – | ingest.ts:197-203, 326-328 |
| any | `setCursor` | last writer wins (can regress under two holders) | – | sqlite.ts:559-561 |
| start position | – | `min(local, active sinks)` | – | ingest.ts:328 |

### M5. Background kick (debounce is the lock-file existence check)

| From | Event | To | Guard | Ref |
|---|---|---|---|---|
| Idle | END_EVENT (`stop`, `session.end`, `session.idle`, `afteragent`) | Check | not RUN_ID, not NO_AUTO_INGEST | kick.ts:17, 23 |
| Check | lock file **exists** (live or stale) | Skipped | no staleness check, no pending marker | kick.ts:25 |
| Check | `bin/cli-path` readable and target exists | Spawned (detached, `ingest --background`) | – | kick.ts:26-35 |
| Spawned child | lock busy | exit 0 "busy" | waitMs 0 | ingest.ts cmd:25-28 |
| Spawned child | lock acquired | ingest one snapshot of `listSpoolFiles`, release, then unlocked `tailIngest` | – | ingest.ts:320, cmd:21-22 |

### M6. Periodic ingest (ui every 3 s, MCP per interval)

`Idle → Busy → Idle`. A busy flag prevents overlap within one process (ui.ts:26-33; mcp/server.ts:86 uses `ingesting ??=`). Each tick runs `ingest(lock wait 1500)`, swallows `LockBusyError`, then runs `tailIngest` without the lock (common.ts:30-41). Other errors become a warning on every tick.

### M7. Raw spill side file

`Absent → Written (wx) → Referenced (line appended) → Resolved (ingest reads it into line.raw; the adapter stores it as a blob) → Deleted (gc, with its spool file)`.

Invalid: `Orphan` (written, but the append failed or the process was killed before the append; nothing refers to it, so gc never sees it, write.ts:98→107, gc.ts:131). `Dangling` (the line refers to a missing file; ingest keeps the line, flags it, and has no payload, spool-read.ts:146-149).

### Reached invalid states (details in the JSON)

- **CAP-1: two lock holders.** Repro output: `round 0: 3 of 8 processes hold the lock at once`, and under plain contention `240 acquisitions, 2 found another holder inside the critical section`. Impact repro: `20 captured events -> sink received 40`.
- **CAP-2: an orphaned lock disables every kick.** `isStale(lock) = true`, yet `0/50 Stop events spawned an ingest`.
- **CAP-3: lost wakeup.** `kick for session B: skipped (lock exists)`, `cursor of B's file: 0`, `session B indexed: false`.
- **CAP-4: gc leaves cursors.** `gc deleted spool files: 1 | cursor still: 186`, then `invalid JSON … position 3`, `session 'new' indexed: false`.
- **CAP-5: orphaned raw spill.** `gc removed raw files: 0 | still on disk after gc (30 days old): 1`.
- **CAP-6: TornTail.** `cursor: 186 of size 226 | gc deleted: 0`, and the next good line is lost.
- **CAP-7: file order is by pid string, not time.** `start pid 9999, end pid 10000: tool.end durationMs = undefined`.

Also noted, but **not** listed as findings because I couldn't show them: backfill and `tailIngest` run without the lock, so two processes can each recompute the same session and the last write wins. It looks narrow and mostly heals on the next run. Ingest also re-reports normalize errors and double-counts `excluded` for lines it re-reads only for sinks; that is noise only.
## Sessions and adapters

Scope: `src/core/{sessions,ingest,repo-state,snapshot}.ts`, `src/adapters/**`. All paths below are relative to `packages/coding.sh`.

Most machines here are **implicit**. `buildSession()` (`src/core/sessions.ts:129`) refolds a session's whole event list on every ingest. So "state" is whatever the stored events imply, and **event identity is the transition guard**. The store's `putEvents` is INSERT-OR-IGNORE (`src/store/sqlite.ts:447`, `src/store/memory.ts:96`), so:

- two events with the same id: the **first one wins** and later content is dropped;
- two events with different ids that describe the same thing: **both count**.

### M1. Session status (derived, never stored)

States:
- **absent**: no row.
- **running**: `endedAt` is unset and last activity was under 30 min ago.
- **idle/abandoned**: `endedAt` is unset and last activity was 30 min or more ago.
- **ended**: `endedAt` is set.

The running/idle split comes from `isRunning()` and `lastActivity()` (`src/mcp/data.ts:63-72`). `endedAt` itself is computed at `src/core/sessions.ts:205-207,250-251`.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| absent | any valid event ingested | running | – | `src/core/ingest.ts:530-543` |
| running | `session.end` | ended (`endedAt` = ts of the latest `session.end` in sort order) | – | `src/core/sessions.ts:205-207` |
| running | events only from transcript or conversation-keyed OTel | ended (`endedAt` = end of the last event, moves forward) | `allTranscript` or (`allOtel` and the id is not one of its traceIds) | `src/core/sessions.ts:250-251` |
| running | 30 min with no events | idle | `now - lastActivity >= IDLE_MS` | `src/mcp/data.ts:71` |
| ended | more live events (resume, or activity after a guessed idle end) | **ended (no transition)** | none; nothing reopens a session | `src/core/sessions.ts:205,251` |
| ended | a later `session.end` with a **new** id | ended (`endedAt` moves forward) | Claude hook `SessionEnd` has no key → new id per line | `src/adapters/claude-code.ts:228` |
| ended | a later `session.end` with the **same** id | ended (`endedAt` frozen) | Codex `SessionEnd` key `["end"]`; Claude subagent idle end key `["end"]` | `src/adapters/codex.ts:687`, `src/adapters/claude-code.ts:393` |

**Invariant I1:** `endedAt` is unset, or `endedAt >= max(eventEnd(e))` over captured events. **Violated by SES-3.**

### M2. Turn (open/closed)

There are three sources. They follow different rules.

**Claude transcript converter** (`src/adapters/_shared/claude-transcript.ts`). State is `turnEnded` / `turnId` / `command` at lines 122-127.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| closed | real prompt | open (`turnId = id(promptId ?? uuid)`) | `promptText` is not synthetic | 231-236, 259-268 |
| closed | task-notification | open (emits a notification) | – | 292-296 |
| any | slash command | pending-command | – | 277-280 |
| pending-command | assistant reply | open (synthetic `user.message`) | – | 201, 300-308 |
| pending-command | another user entry, or end of file | closed (notification) | – | 311-319 |
| open | `system` entry with subtype `turn_duration` | closed, `turn.end` key `[uuid]` | `!turnEnded` | 329-334 |
| open | next prompt | closed, synthesized `turn.end` key `[turnId,"end"]` with ts = last entry | – | 341-349 |
| open | **end of file** | closed, synthesized `turn.end` key `[turnId,"end"]` | **no idle guard** | 382-384 |

**Claude hooks:** no open state. Every `Stop` / `StopFailure` emits an **unkeyed** `turn.end` (`src/adapters/claude-code.ts:193-204`), including Stops where `stop_hook_active` is true.

**Codex:** `task_started` sets the turn id. `task_complete` / `turn_aborted` emit `turn.end` keyed `[turnId]` (`src/adapters/codex.ts:376-386`). The hook `Stop` emits `turn.end` keyed `[turnId]` (`src/adapters/codex.ts:666`), so hook and rollout copies dedupe.

**Counting:** `turns = turnEnds || userMessages` (`src/core/sessions.ts:189-191,219`). Every `turn.end` row counts.

**Invariant I2:** one `turn.end` per real turn, with the turn's real end ts. **Violated by SES-1, SES-2, SES-6.**

### M3. Tool call

States: pending (`tool.start`) → done-ok / errored (`tool.end ok=false`) / interrupted (`payload.interrupted`). Two abnormal states also exist: start with no end, and end with no start.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| – | PreToolUse / transcript `tool_use` / rollout `function_call` | pending, key `[toolUseId]` | – | `src/adapters/claude-code.ts:179`, `claude-transcript.ts:216`, `codex.ts:519-528,640` |
| pending | PostToolUse / `tool_result` / `*_output` | done or errored, key `[toolUseId]` | `ok = event == PostToolUse`, `!is_error`, `exit == 0` | `src/adapters/claude-code.ts:182-191`, `claude-transcript.ts:241-254`, `codex.ts:529-543,643-651` |
| – | Cursor postToolUse | pending + done in one step (start rebuilt as `ts - duration`) | – | `src/adapters/cursor.ts:141-152` |
| – | hook line with no `tool_use_id` | Pre and Post get **different** synthetic ids, so they never pair | – | `src/adapters/claude-code.ts:165` |
| done | duration filled from the matching start | – | `e.ts >= start` | `src/core/ingest.ts:432-465` |

**Counting:** `toolCalls = max(starts, ends)` (`src/core/sessions.ts:221`). **Invariant I3:** `toolCalls` = number of distinct `toolUseId`s. **Violated by SES-7.**

### M4. Subagent (parent edge + child session)

| from | event | to | guard | file:line |
|---|---|---|---|---|
| – | Claude `SubagentStart` | parent `subagent.start` key `[id]`; child `session.start` key `["start"]` with `parentLink` | `id = agent_id ?? synthetic` | `src/adapters/claude-code.ts:206-212` |
| child-open | tool or prompt event that carries `agent_id` | child events in `${parent}:sub:${id}` | `inChild` | `src/adapters/claude-code.ts:148-150` |
| child-open | Claude `SubagentStop` | parent `subagent.end` key `[id]`; child `session.end` key `["end"]` | – | `src/adapters/claude-code.ts:214-222` |
| – | Claude backfill of a subagent file | `subagent.start` always; `subagent.end` + `session.end` key `["end"]` | only if `meta.finished`, the journal says done, or **idle > 30 min** | `src/adapters/claude-code.ts:386-394` |
| – | Codex backfill of a child rollout | `subagent.start`, and `subagent.end` key `[childId]` | **always, in `finish()`** | `src/adapters/codex.ts:357-359,545-550` |
| child without parent link | parent's `subagent.*` names `childSessionId` | link stored (memory + kv), applied at end of run | child has no `parent` | `src/core/ingest.ts:481-521,534-537,388` |

**Invariant I4:** `subagent.end` exists only after the child finished, with the child's real end ts and ok. **Violated by SES-5.** The Claude idle guess also freezes, because it is first-wins under key `["end"]`.

### M5. Spool cursor (per spool file, local index and each sink)

| from | event | to | guard | file:line |
|---|---|---|---|---|
| offset k | flush + recompute at checkpoint | `readPos` | `readPos > local` | `src/core/ingest.ts:346-357` |
| offset k | file is now shorter than k | 0 (re-read from the start) | `local > file.size` | `src/core/ingest.ts:322-325` |
| sink offset | batch acknowledged | last line's `nextOffset` | `ack.ok` | `src/core/ingest.ts:277-318` |
| file fully read | gc | file deleted, **cursor key kept** | all cursors >= size and older than `keepSpoolDays` | `src/core/gc.ts:125-143` |

Hook event ids are keyed on spool position (`lineKey`, `src/adapters/_shared/normalize.ts:223`), so re-reading after a crash is idempotent.

### M6. Backfill file watermark (agent + path)

State is the tuple (`size`, `mtime`, `since`); `mtime = 0` means unseen. A file is skipped when it is unchanged and `readSince <= since` (`src/core/ingest.ts:664-673`). The watermark is committed after recompute, with `mtime` written last (`src/core/ingest.ts:710-715`). On a file's first read, all of its sessions are recomputed (`src/core/ingest.ts:694`). A changed file is converted again from the start. Ids are deterministic, so the only risk is evolving content under a fixed id (SES-2, SES-4, SES-5).

### M7. Hooked vs unhooked tailing

- **Codex:** not installed → installed but untrusted, or hooks disabled. In that state `tailWhenUnhooked` returns `{since: installTs}` and a backfill runs on **every lazy CLI read** (`src/adapters/codex.ts:816-822`, `src/cli/common.ts:50-53`). Once trusted, the hooks capture.
- **T3 Code:** `tail()` is true whenever its store exists (`src/adapters/t3code.ts:740`). Each read converts the native Claude transcripts and Codex rollouts again, with the full converters (`src/adapters/t3code.ts:251-261`).

### M8. Live vs backfill dedupe

- Natural keys dedupe tool, llm, subagent and Codex turn/prompt events.
- Prompts and replies with no natural key: backfill drops a transcript copy only when a live copy with equal text is already stored (`src/core/ingest.ts:576-581,615-628,688-692`).
  - This works in one direction only. Spool ingest never dedupes against an earlier backfill.
  - It compares the transcript text **before** redaction and metadata stripping (`src/core/ingest.ts:688-693`) against live text stored **after** both (`src/core/ingest.ts:620-623`).

### M9. End snapshot and M10. Repo state

- `freshEnds` takes a working-tree snapshot for a live `turn.end` / `session.end` ingested within 10 min (`src/core/ingest.ts:254-270,373-375`).
- Repo state is resolved once per session (`src/core/repo-state.ts:50-62`, `src/core/ingest.ts:538-541`); the earliest event repo state wins (`src/core/sessions.ts:175-177`).
- Neither showed a reachable invalid state in this audit.

### Findings

| id | sev | summary | repro |
|---|---|---|---|
| SES-1 | high | Hook and backfill copies of a Claude session double-count turns. Prompts also duplicate in metadata mode, when backfill runs before ingest, and when redaction changes the text. | `r1-hook-then-backfill.ts`, `r1b-variants.ts` |
| SES-2 | medium | Backfilling a live Claude transcript writes a synthesized end-of-file `turn.end`; the real end is added later, so one turn counts twice | `r2-backfill-growing-transcript.ts` |
| SES-3 | medium | `endedAt` is never cleared by later activity. Resumed sessions show as ended; Codex `endedAt` freezes at the first SessionEnd | `r3-resume-after-end.ts` |
| SES-4 | medium | The T3 v1 and opencode `usage-summary` is keyed by a constant, so the first token snapshot wins forever | `r4-t3-usage-summary-frozen.ts` |
| SES-5 | low | Codex backfill emits `subagent.end` for children that are still running, and it is never corrected | `r5-codex-premature-subagent-end.ts` |
| SES-6 | medium | A loop caused by another tool's Stop hook (`stop_hook_active`) counts one prompt as several turns | `r6-stop-hook-and-toolcalls.ts` |
| SES-7 | low | `toolCalls = max(starts, ends)` undercounts when one call has only a start and another only an end | `r6-stop-hook-and-toolcalls.ts` |
## Storage, gc and retention

### M1. Index schema version (`src/store/sqlite.ts`)
States: `v0` (no migrations table) → `v1` … `v4` (= `SQLITE_SCHEMA_VERSION`, :280) | `TooNew` (v > known) | `ReadOnlyUnchecked`.
Invariant: each version is applied at most once, together with its `migrations` row, in one transaction.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| vN | `open()` → `migrate()` | vN+1 … v4 | `m.version > current`, re-checked under `BEGIN IMMEDIATE` (fixed in 4427d92, not re-reported) | sqlite.ts:415-434 |
| vN | migration SQL or `after` throws | vN | ROLLBACK | sqlite.ts:409-411 |
| v>4 | `migrate()` | TooNew (throws "Upgrade coding.sh") | `current > SQLITE_SCHEMA_VERSION` | sqlite.ts:419-421 |
| any | `open({readOnly})` | ReadOnlyUnchecked | no migration and no version check (no callers today) | sqlite.ts:386-389 |

### M2. Transaction (`SqliteIndexStore.tx`)
States: `Idle` → `Open` (BEGIN IMMEDIATE) → `Committed` | `RolledBack`. It does not nest. Bodies are synchronous, so async callers in one process cannot interleave inside a transaction. `SQLITE_BUSY` waits `busy_timeout = 5000` (:385) and then throws, with no retry. Every transactional writer is idempotent (`INSERT OR IGNORE`, upserts), so callers retry safely: serve answers 503, ingest leaves its cursor where it was.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Idle | `tx(fn)` | Open | BEGIN IMMEDIATE takes the write lock or throws BUSY after 5 s | sqlite.ts:404 |
| Open | fn returns | Committed | COMMIT | :407 |
| Open | fn or COMMIT throws | RolledBack | ROLLBACK, error rethrown | :409-411 |
Users: `putEvents` :452, `putDataset` :670, `deleteBefore` :819, `migrate` :425. Nothing calls `tx` from inside a `tx`.

### M3. Blob lifecycle (`fs-blobs.ts`, `core/offload.ts`, `core/ingest.ts`, `server/queue.ts`, `core/gc.ts`)
States: `Absent` → `Tmp` (`<ref>.zst.<pid>.<hex>.tmp`) → `Stored·Young` → `Referenced` (an index row points at it) → `Stored·Old·Unreferenced` → `Deleted`. Side states: `OrphanTmp`, `TornDurable` (after power loss), `Dangling` (a row references a missing blob; metadata mode does this on purpose).
Invariant: a blob that some live record references is never deleted. The guard is the gc mark set plus an mtime age guard (1 day for CLI gc, 1 hour for serve).

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Absent | `put` | Tmp → Stored·Young | `writeFile wx` then `rename`, **no fsync** | fs-blobs.ts:41-45 |
| Tmp | crash before rename | OrphanTmp | `list()` regex skips `.tmp`, so gc never removes it | fs-blobs.ts:107 |
| Stored | `put` of the same content | Stored (mtime refreshed) | `touchIfExists`, never rewrites | fs-blobs.ts:38,57-66 |
| Stored·Young | event commit (`putEvents`, `putTask`, `putRun`, `putBundle`) | Referenced | ref appears in `referencedBlobs` | sqlite.ts:751-763; memory.ts:286-299 |
| Stored | commit fails or crash before commit | Stored·Unreferenced | age guard keeps it ≥ minAge | gc.ts:112 |
| Referenced | retention deletes the row, or only old `tool.end` events hold it | Stored·Unreferenced | `expiredToolOutput` | gc.ts:93-98,164-185 |
| Stored·Old·Unref | gc sweep | Deleted | `stat` then `delete`, not atomic, no lock shared with ingest | gc.ts:103-119 |
| *(bug)* | blob held only by `validation.impossible.variant.hiddenFiles` or a toolevals `tapBlob` | treated as Unreferenced → Deleted | holders missing from `taskBlobs`, `runBlobs` and sqlite `referencedBlobs` | common.ts:133-146; sqlite.ts:753-759 |
| Stored | power loss after rename | TornDurable | `get()` returns 0 bytes, no sha check; re-`put` never heals it | fs-blobs.ts:68-83 |

### M4. Payload offload, per key (`core/offload.ts`)
`Inline` → (`byteLength > maxInlineBytes`) → `Offloaded{key: utf8 preview, keyBlob: ref, truncated: true, ref ∈ event.blobs}`. The preview is never larger than maxInline, so re-offloading is a no-op. In metadata mode `put` only hashes, which leaves a Dangling ref on purpose (queue.ts:277, ingest.ts:408). The blob is written in `prepare` before `putEvents`; if the tick fails it becomes Stored·Unreferenced (M3).

### M5. Dataset, experiment and judge records
Dataset version: `Absent` → `Stored(immutable)`; `latest` pointer is last-writer-wins.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Absent | putDataset (sqlite) | Stored, latest = v | one tx: exists check + insert + latest upsert | sqlite.ts:669-685 |
| Absent | putDataset (memory) | Stored, latest = v | none | memory.ts:223-236 |
| Absent | putDataset (file mode) | VersionFile → +History → +Latest | **3 separate writes, no lock** | datasets/store.ts:113-130 |
| VersionFile | crash before history append, then retry | Stored without a history row (**permanent**) | `existing` ⇒ skips the history append | store.ts:118-127 |
| Absent | 2 concurrent puts (file mode) | duplicate history rows | both read "absent" | store.ts:115,126 |
| any | torn last history line | listing of every dataset throws | JSON.parse with no tolerance | store.ts:152-155,165 |
Experiments and judges are upserts (sqlite.ts:714-747; atomic tmp+rename in file mode). Judge `status`: `draft` → `production` only if `calibration.state === "calibrated"` or `force` (store.ts:240-249).

### M6. Session retention (`server/retention.ts`, `deleteBefore`)
`Live` → `Expired` when `coalesce(ended_at, started_at) < now − days` → `Deleted` (events, FTS rows, labels and session in one tx) → its blobs become Unreferenced (M3).

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Live | hourly `applyRetention` in the writer's exclusive lane | Deleted | `coalesce(ended_at, started_at) < cutoff`, **ignores last event ts** | retention.ts:25-34; sqlite.ts:813-834; memory.ts:75-91 |
| Deleted | FTS 'delete' for a row with generated `text = ''` that was never indexed | **FTS corrupt** (deleteBefore throws, or later `search` throws) | putEvents indexes only if `searchableText !== undefined` | sqlite.ts:468-469 vs :822, :242-246 |
| Unref blobs | daily gc (minAge 1 h) | Deleted | exclusive lane | retention.ts:49-62 |

### M7. Serve ingest queue item (`server/queue.ts`)
`Admitted` (counters reserved) → `Pending` → `Batched` → `Prepared` (mapped, redacted, offloaded; blobs written) → `Dirty-recorded` (`kv serve:dirty`) → `Committed` (putEvents) → `Rebuilt` → `Resolved(200)`. Any throw → `Rejected(503, Retry-After)`.
Invariant: a 200 means the events are committed and their sessions rebuilt. A retry is idempotent because event ids are deterministic and inserts are `INSERT OR IGNORE`.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| — | submit | Admitted/Pending, or 429/503 | `closing`/`stopped`/`writable`/capacity; an empty queue admits anything | queue.ts:112-128 |
| Pending | writer loop | Batched | ≤ tickEvents, after linger turns | :209-221 |
| Batched | tick | Prepared → Dirty-recorded → Committed → Rebuilt → Resolved | sequential awaits | :283-325 |
| any in tick | throw | Rejected(503) for the whole batch; `dirty` kept in memory and kv | catch | :331-335 |
| (crash) | restart / `becomeWriter` | `repair()` rebuilds the dirty sessions, clears kv | — | :140-153; serve.ts:127 |
| Pending | `drain` deadline | Rejected(503) | in-flight tick finishes by itself | :163-177 |
| Exclusive job | between ticks | ran | `runExclusive` | :131-137,191-203 |
I found no lost or double-committed items in this machine.

### M8. Writer lock (`SqliteIndexStore.acquireWriterLock`, `core/lock.ts`)
`Free` → `Held(pid, heartbeat 15 s)` → `Stale` (holder pid dead, or mtime older than 2 min **even if the pid is alive**) → broken by another process. The holder never re-checks ownership, so a stalled-then-resumed writer keeps writing next to the new holder (sqlite.ts:783-811; lock.ts:66-75,108-125; serve.ts:120-131).

### M9. Spool file gc (`gc.ts:121-143`)
`Active` → `Old` (mtime older than keepSpoolDays) → `FullyRead` (local cursor and every sink cursor ≥ size) → `Deleted` (raw side files first).

### Findings (repros in audit repro (store/))
| id | sev | title | repro |
|---|---|---|---|
| STO-1 | high | Retention corrupts the sqlite FTS index on an empty-text message | r3-fts-empty-text.ts |
| STO-2 | high | Retention deletes live sessions (resumed, or no session.end) | r1-retention-active.ts |
| STO-3 | medium | gc deletes blobs still held by impossible-variant hiddenFiles and toolevals tapBlob | r2-gc-unreferenced-holders.ts |
| STO-4 | medium | A torn blob after power loss is never healed and reads back as 0 bytes | r4-blob-torn-never-healed.ts, r4b-sanity.ts |
| STO-5 | low | gc stat→delete race with a concurrent ingest dedupe hit leaves a dangling ref | r6-gc-ingest-race.ts |
| STO-6 | low | FileEvalStore (file mode) dataset history drifts on crash or concurrent put | r5-file-eval-store.ts |
| STO-7 | low | memory vs sqlite give different answers for the same call sequence | r7-conformance-diff.ts |
| STO-8 | low (unconfirmed) | Writer-lock lease can be taken over while the old writer keeps writing | r8-writer-lock-lease.ts |
## Experiments, runner and graders

Scope: `src/experiments/**`, `src/runner/**`, `src/eval/**`, `src/graders/**`, `src/judge/**`, `src/toolevals/**`, and the CLI wiring in `exp`, `eval`, `run`, `judge`, `toolevals` and `harness`. `cli/commands/compare.ts` is included because it is the only CLI caller of `runner/experiment.ts`. Not audited: `src/bench` and `workflows`.

### Cross-cutting facts

- **No experiment-level lifecycle is ever persisted.** No store has a `pending/running/done/failed/cancelled` record. `ExperimentResult` (`datasets/types.ts:200`) has no status field. It is written once, at the end (`experiments/run.ts:194`). The runner (`runner/experiment.ts`) writes only per-run `RunResult`s and no experiment record. Tool-evals write `experiment.json` up front and append to `trials.jsonl` after each trial (`toolevals/experiment.ts:268,290`). As a result:
  - A run can never be stuck in "running".
  - A cancelled or partial run cannot be told apart from a complete one.
  - Nothing can be resumed. There is no resume path, so no resume bug exists, but all in-flight work is lost on a hard exit.
- **Cancellation exists in exactly one path.** `main.ts:267-276` turns the first SIGINT into `controller.abort()` and the second into `process.exit(130)`. There is no SIGTERM handler. Only `exp run` passes `c.signal` down (`exp.ts:73`). `runTask`, `runExperiment` (runner), `validateTask` and `runToolExperiment` accept no signal.
- **Every child process is spawned `detached`** (its own process group): `runner/exec.ts:57`, `graders/proc.ts:59`, `adapters/_shared/run.ts:55`, `adapters/more/_util.ts:781`. The terminal's Ctrl-C therefore never reaches children. They die only if the parent explicitly kills their group.
- **Children settle on `close`, not `exit`** (`exec.ts:98`, `proc.ts:126`, `_shared/run.ts:112`, `_util.ts:844`). `close` waits until every holder of the stdout/stderr pipes has exited.

### M1: dataset experiment (`experiments/run.ts`, `exp run`)

States: `Configured → Running(jobs) → Summarized → Persisted`. Each case-trial goes through `Queued → (Aborted | TaskRunning) → (TaskError | Grading) → Recorded`.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Configured | start | Running | trials ≥ 1 and grader ids unique | run.ts:97-111 |
| Queued | dequeued, signal aborted | Recorded (`error:"aborted"`, `pass:false`) | `signal.aborted` | run.ts:116-118 |
| Queued | dequeued | TaskRunning | none | run.ts:124 |
| TaskRunning | task throws, times out or is aborted | TaskError (no grades) | none | run.ts:135-141 |
| TaskRunning | task returns | Grading (all graders in parallel) | none | run.ts:142-159 |
| Grading | a grader throws | grade `{error}` | none | run.ts:155-157 |
| Grading | all graders done | Recorded, `pass = !error && every(result.pass)` | none | run.ts:165 |
| Running | all jobs recorded | Summarized → Persisted | **no "was aborted?" guard** | run.ts:176-194 |
| CLI | Persisted | prints `outcome:"completed"`, then exits 130 if aborted | none | exp.ts:77, main.ts:290 |

Invariants violated:
- "A persisted experiment is complete" (EXP-1).
- "A failed run means the agent failed" (EXP-1, EXP-6).

### M2: child process (`exec.ts`, `proc.ts`, `runHeadless`, `spawnAgent`)

States: `Spawned → Running → (Exited | TimedOut | Aborted | SpawnError) → Settled (group SIGKILLed)`.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Spawned | spawn `error` | Settled (127 / spawnError) | none | exec.ts:97, proc.ts:125 |
| Running | timer fires | TimedOut: group SIGKILL (spawnAgent sends SIGTERM, then SIGKILL 3 s later) | timeoutMs > 0 | exec.ts:67-73, proc.ts:74, _util.ts:796-803 |
| Running | abort signal | group SIGKILL | `proc.ts` only | proc.ts:75-76 |
| Running | **all stdio pipes closed** (`close`) | Settled; group SIGKILL "reaps grandchildren" | none | exec.ts:77-98, proc.ts:101-126 |
| Running | child exits but a grandchild holds stdout | **stays Running until the timeout** (forever if timeout is 0) | none | same as above (EXP-5) |
| Running | parent receives SIGTERM, or `process.exit` on 2nd SIGINT | **orphaned: group keeps running** | none | main.ts:272 (EXP-2, EXP-3) |

### M3: runner attempt (`runner/run.ts` `runTask`)

States: `Init → Materialized → SetUp → Overlaid(rebased start) → AgentRan → Diffed/TamperChecked → Verified → Finalized (rm work dir, putRun)`.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Init | mkdir + materialize | Materialized | throws → catch (`error`) | run.ts:81-83 |
| Materialized | setup command exits ≠ 0 or times out | Finalized (`error`) | none | run.ts:85-91 |
| SetUp | applyBundle, overlay, rebaseStart | Overlaid | none | run.ts:93-96 |
| Overlaid | adapter has no `run` | Finalized (`error`) | none | run.ts:98-101 |
| Overlaid | `adapter.run` resolves or throws | AgentRan (timeout → `error ??=`) | none | run.ts:108-123 |
| AgentRan | diffWorkdir | Diffed (+ tamper) | none | run.ts:126-134 |
| Diffed | write hidden files, run verifier | Verified, `pass = exit 0 && !timedOut` | verifier runs even after an agent error | run.ts:137-145 |
| any | `finally` | rmrf(root) unless `keep`; putRun exactly once | **skipped on process.exit** | run.ts:149-157 |

Retries and double-recording: none. A `RunResult` is written exactly once, from `finally` or from the `adapterFor`-throws catch (`experiment.ts:105-122`). No result is written before verification.

### M4: runner A/B experiment (`runner/experiment.ts`, `compare` CLI)

Jobs are `(task, attempt, bundle)`, interleaved (`experiment.ts:58-62`), run through `pool()` (`:65-76`). Each job is `Queued → runTask → Recorded → onProgress`. There is no experiment record, no cancel transition and no completeness marker. `compare --experiment <id>` re-analyses whatever runs exist (`compare.ts:31`).

### M5: tool-eval trial (`toolevals/experiment.ts` `runTrial`)

States: `Init → SandboxPrepared → TapStarted → DriverRan → TapsClosed → Traced → Checked → Scored → Cleaned → putRun`, then the CLI appends the trial to `trials.jsonl`.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Init | prepareSandbox throws (setup command or missing file) | catch → Scored(fail) | **`sbRoot` still undefined** | experiment.ts:143-144, sandbox.ts:77-104 |
| SandboxPrepared | start mcp/http tap | TapStarted (closer registered) | none | :149-168 |
| TapStarted | model or agent driver | DriverRan (timeout → `error`) | none | :170-211 |
| DriverRan | closers | TapsClosed | `finally` retries the closers | :212, :224 |
| TapsClosed | trace, tap, checks | Checked | none | :214-220 |
| Checked | `checksPass = all checks ran and passed` | Scored | none | :228-235 |
| Scored | rm sandbox | Cleaned | `sbRoot && !keep` | :244 |

### M6: task validation (`eval/validate.ts`, `eval validate`)

Pipeline: `noop → reference ×k → near-misses → impossible → pass-to-pass → leakage → status`. Each step gets a fresh temp dir via `prepare` (`:225`) and `cleanup` (`:240`). The status update is `archived` (sticky), else `validated` if `report.ok`, else `draft` (`:497-499`). There is no signal: the CLI's `finally` (`eval.ts:92-95`) is skipped on a hard exit (EXP-2).

### M7: judge call (`judge/judge.ts`, `judge/http.ts`)

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Start | cache hit | Verdict(cached) | none | judge.ts:165-171 |
| Calling | HTTP 408/409/425/429/5xx or network error | Backoff → Calling | attempt < retries (4) | http.ts:122-136 |
| Calling | not retryable, or retries exhausted | throws HttpError → grade `{error}` | none | http.ts:123-127 |
| Calling | abort | throws `signal.reason` | none | http.ts:95,107,136 |
| Parsing | unparseable reply | Calling with RETRY_NOTE | attempt ≤ parseRetries | judge.ts:174-188 |
| Parsing | parsed | cache.set → Verdict | none | judge.ts:196 |

Only successful verdicts are cached, so there is no poisoning.

### M8: grader result (`graders/external.ts`)

Command grader outcomes:
- Spawn error or timeout → **error**.
- Stdout parses as JSON → **that value is the grade, whatever the exit code or signal**.
- Otherwise exit 0 → pass; anything else (including SIGKILL from an abort) → **fail** (`external.ts:81-99`).

### Checked and not reachable

- **Results written before grading or verification finishes:** none (`run.ts:194`, `runner/run.ts:153`, `toolevals/experiment.ts:259`).
- **A retry that double-records a run:** none (see M3).
- **Resume re-running finished trials or skipping failed ones:** there is no resume.
- **Concurrent `exp run` on the same experiment id:** ids are always fresh ULIDs and the CLI has no `--id`. Clobbering is only possible through the library `opts.id`.

### Findings

| id | sev | title |
|---|---|---|
| EXP-1 | high | Ctrl-C during `exp run` stores the partial experiment as completed; aborted trials count as failures |
| EXP-2 | high | `compare`, `eval validate` and `toolevals run` ignore SIGINT; the 2nd Ctrl-C leaks agent process groups and work dirs |
| EXP-3 | medium | SIGTERM leaks every detached child and throws away all finished `exp run` trials |
| EXP-4 | medium | Command grader ignores exit code and signal when stdout parses; an aborted grade is a fail, not an error |
| EXP-5 | medium | A process that exits 0 but leaves a background child is reported as a timeout; with timeout 0 it never settles |
| EXP-6 | medium | Grader errors (judge outage) count as case failures and show up as regressions in `exp compare` |
| EXP-7 | low | A tool-eval trial whose setup fails leaks its sandbox dir |
| EXP-8 | low | The runner `compare` note says errored runs count as failures, but errored runs that passed count as passes |
## Install, config, update and serve

Scope: `packages/coding.sh` covering init, uninstall, config, doctor, update, status, gc, serve, collector, gateway, mcp, the hook and MCP writers under `src/adapters/**`, `src/update/**`, `src/server/*`, `src/otel/receiver.ts` and `src/sinks/*`. Every repro ran in a fresh temp `HOME` and `CODING_SH_HOME`. One repro called the real `codex` binary (0.166.0) with `CODEX_HOME` pointed at the temp dir. The scripts are in audit repro (install/) (`r1-symlink.ts` … `r8-mcp-pin.ts`, with `env.ts` setting up the sandbox).

### M1. Hook entry in one agent config file (per agent × scope)

States: **Absent** (no file, or no entries of ours), **Current** (our entries match exactly what we would write today), **Drifted** (ours, but the command, timeout or hook path differs), **Untracked** (ours, but our matcher can't recognize it), **Orphaned** (the file references a hook bin or CLI path that no longer exists or is stale).

Invariants: (I1) running init twice makes no change. (I2) Uninstall removes only our entries. (I3) An uninstall run right after install, with nothing touched in between, puts the original bytes back. (I4) A process crash during a write never leaves a half-written config.

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Absent | `init` | Current | plan has no error; consent given | init.ts:116,182 → install.ts:57-72 → files.ts:90-105 |
| Current | `init` | Current (no write) | specKey sets are equal | hooks.ts:149-154, 203-207; files.ts:159 |
| Drifted | `init` | Current | our old entries stripped, new ones appended after the user's | hooks.ts:155-163 |
| Current/Drifted | `uninstall` | Absent: exact restore | installs.json sha256 equals the current text, and what remains equals the original | installs.ts:147-166; install.ts:125-126 |
| Current/Drifted | `uninstall` | Absent: strip only | file edited since our write | install.ts:127-128 |
| any | write | same, written via tmp + `rename` | not fsynced; a symlink is **replaced** (INS-2) | files.ts:60-74; more/_util.ts:219-222 |
| Current | `CODING_SH_HOME` changes (Cursor, no marker) | Untracked | path no longer matches the recognizer | hooks.ts:47-55; cursor.ts:367 (INS-9) |
| Current | `coding.sh update` | Orphaned (stale hook.mjs) | nothing refreshes the bin | update.ts:137-162; hookbin.ts:28-43 (INS-6) |
| Current | stale ingest lock exists | auto-ingest off | `existsSync(lock)` | spool/kick.ts:25 (INS-5) |

Project scope uses different files (`.claude/settings.local.json`, `.cursor/hooks.json`, `.codex/hooks.json`, and so on). User and project scope are independent copies of M1. Nothing warns when both are installed, and there is no dedupe beyond the agent's own (INS-10).

### M2. MCP registration (user scope only; `--no-mcp` or `--scope project` skip it)

States: **Absent**, **OursTracked** (JSON key, or a TOML block with both markers), **ForeignOrOrphan** (an entry exists but its markers or record are gone), **Stale** (the launch spec points at a node or cli.mjs that has moved).

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Absent | init | OursTracked | restore = backup, or null if we created the file | mcp.ts:114-127 |
| OursTracked | init with a new spec | OursTracked (updated) | JSON is always set; TOML is upserted inside the block | mcp.ts:64-85 |
| OursTracked (TOML) | `codex mcp add X` | **ForeignOrOrphan** | Codex drops our BEGIN marker and moves END below X | toml-edit.ts:14-20 (INS-3) |
| ForeignOrOrphan | init | unchanged, never updated | `!hasTomlBlock && hasMcpServer` makes it look like the user's own entry | mcp.ts:81 |
| ForeignOrOrphan | uninstall | unchanged | `hasTomlBlock` is false | mcp.ts:98 |
| OursTracked | nvm switch, npx cache eviction, or update to another prefix | Stale | the spec pins `process.execPath` and argv[1] | launch.ts:32-34; init.ts:100 (INS-7) |
| OursTracked | uninstall | Absent | MCP is removed before hooks, so a shared file is restored exactly | uninstall.ts:15-18; mcp.ts:88-111 |

### M3. Own files: `~/.coding.sh/{bin/hook.mjs, bin/cli-path, config.toml, installs.json}`

| from | event | to | guard | file:line |
|---|---|---|---|---|
| none | init | written (bin first, so hooks never point at a missing file) | `planHookBin` reports a diff | init.ts:130,174-178 |
| written | `coding.sh update` (npm i -g) | **stale bin**, pointer possibly stale | no hook calls `writeHookBin` | update.ts:137-162 |
| any | doctor | reports "ok" | checks only `existsSync(hook)` | doctor.ts:111,140 |
| config present | `config set k v` | rewritten (atomic) | the probe load validates only types, so a write into the wrong table passes | config.ts(cli):62-92,136-157 (INS-1) |
| config absent | init | default written (`writeFileSync`, not atomic, new file only) | `!existsSync` | core/config.ts:415-420 |
| installs.json | any install or uninstall write | read-modify-write, renamed in | no cross-process lock (two concurrent inits can lose a record) | installs.ts:33-77 |

### M4. Update check (`~/.coding.sh/update.json`)

States: **Empty**, **Attempted** (`attemptedAt` set, child in flight), **Fresh** (`checkedAt`/`latest` under 24 h old), **Failed** (keeps the previous `latest` and adds `error`/`errorKind`), **Stale** (`now - (attemptedAt ?? checkedAt) ≥ 24h`, or the stamp is more than 60 s in the future).

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Stale/Empty | `notice()` after a TTY command | Attempted, detached child spawned | checks enabled; `isStale` | index.ts:148-165,191-217 |
| Attempted | child succeeds | Fresh (keeps `notified`) | — | refresh.ts:137-138,141-147 |
| Attempted | child fails | Failed (`attemptedAt` = now, so throttled for 24 h) | — | refresh.ts:139 |
| any | `coding.sh update` | Fresh or Failed | `force` ignores the throttle and opt-outs | update.ts:87-93; index.ts:126-135 |
| Fresh, latest > current | `notice()` | prints at most once per version per 24 h | `notified` | index.ts:201-210 |
| any | viewer or MCP `getUpdateStatus` | awaited `checkForUpdate` when stale | — | index.ts:262-267 |

No reachable invalid state was confirmed here. `attemptedAt` is written before the spawn, so commands don't pile up children. A failed write is swallowed, which only matters for a read-only home.

### M5. `serve` lifecycle

States: Opening → (Writer | Standby, retrying the lock every 5 s) → Listening → ShuttingDown (readyz 503, `server.close`, queue `closing`) → Draining (≤25 s) → Stopped (lock released, stores closed).

| from | event | to | guard | file:line |
|---|---|---|---|---|
| Opening | lock acquired | Writer (repair dirty sessions, start retention) | — | serve.ts:121-133 |
| Opening | lock busy | Standby (submit returns 503 with Retry-After 5) | — | serve.ts:137-153; queue.ts:114 |
| Opening | listen error | closed (lock released, index closed; blobs not closed) | — | serve.ts:292-306 |
| Listening | SIGTERM/SIGINT ×1 | ShuttingDown | idempotent promise | serve.ts:337-358; cli/serve.ts:79-97 |
| Draining | queue empties or deadline passes | Stopped; leftovers rejected with 503 so clients retry | a tick in flight past the deadline isn't awaited, and the dirty key repairs it next start | queue.ts:163-177,140-153 |
| Listening | second signal | process exit | — | cli/serve.ts:84 |

Invariant: a 2xx goes out only after `putEvents` and the session rebuild have committed (queue.ts:283-324). Nothing acked is lost. Requests still uploading when the drain starts get a 503 or a reset, never a false 2xx.

### M6. `collector` (local OTLP receiver)

Listening → close (`server.close` + `closeIdleConnections`, then await the serial write chain) → Closed. Writes are serialized through one promise chain. A store error answers 503, which OTLP exporters retry. receiver.ts:562-567,610-631.

### M7. Sink delivery (inside ingest)

Per sink: **Active** → (batch ack fails) → **BackingOff** (`sink:<name>#retryAt` = now + Retry-After, or 30 s for network errors, or 10 min for other 4xx) → Active again once that time has passed. Each sink has its own byte cursor per spool file, which moves only after an ack (ingest.ts:277-318). The read start is the minimum over the local cursor and all active sink cursors (ingest.ts:326-328). gc deletes a spool file only after every cursor has passed it (gc.ts:124-129). Delivery is at-least-once (a crash between the ack and `setCursor` re-sends) with deterministic span and event ids, in file order, never reordered.

There is a hidden extra state: **Auto-ingest disabled**. A stale `.ingest.lock` from a killed ingest makes the hook skip every background ingest (kick.ts:25), even though `acquireLock` would break it (lock.ts:65-74,95-103). Sinks then stall until someone runs a CLI command (INS-5).

### Confirmed invalid states

- **INS-1 (high): `config set` writes into the following `[[sinks]]` table.** The header regex skips `[[…]]`, so the sink's keys look like part of `[capture]`. Running `config set capture.mode full` on a config where `[capture]` has no `mode` flips `sinks[0].mode` from "metadata" to "full", and the command prints "Set capture.mode / full". Repro: r2.
- **INS-2 (medium): installing breaks symlinked agent configs.** A symlinked `~/.claude/settings.json` (stow-style dotfiles) becomes a regular file. The dotfiles target never gets the hooks, and uninstall leaves the regular file in place. Repro: r1.
- **INS-3 (medium): `codex mcp add` makes our Codex MCP block untrackable.** After it runs, `config.toml` has no BEGIN marker and the END marker sits below the user's table. `uninstall` then removes nothing, and `init` never updates the entry. Repro: r5, against the real codex 0.166.0.
- **INS-4 (medium): Gemini comments are lost and the two parsers disagree.** The Gemini hook writer parses JSONC and writes plain JSON, so comments are lost permanently (an edited file can't be restored exactly). The MCP writer on the same file uses strict JSON and refuses it, so the first init is partial. Repro: r3, r3b.
- **INS-5 (medium): a stale ingest lock disables hook-started ingest.** Repro: r4.
- **INS-6 (medium): `hook.mjs` stays old after `coding.sh update`.** doctor still reports it as healthy.
- **INS-7 (medium): the MCP entry pins paths that can disappear.** It records the nvm node path and the npx-cache cli path. Repro: r8.
- **INS-8 (medium): a "default"-project key can write into another project's sessions.** Repro: r7.
- **INS-9 (low): Cursor hooks duplicate across `CODING_SH_HOME` values,** and uninstall leaves the old ones. Repro: r6.
- **INS-10 (low, unconfirmed): user plus project scope may capture events twice.** It depends on whether the agent dedupes identical hook commands.
## Viewer, MCP and workflow store

I found 8 real defects in scope. Six were reproduced with scripts, and the two low-severity ones follow directly from the code. Five other suspected races turned out not to be bugs.

Audited against the working tree on 2026-11-06. I made no changes to the repo. Repro scripts are in audit repro (viewer/). Run them with `node <script>` from `packages/coding.sh`:

- `r2-offset-drift.ts` starts the real CLI viewer (`ui --no-open --port 0`) under a temp HOME and CODING_SH_HOME, then calls its HTTP API.
- `r-browser.ts` drives headless Chrome through the repo's own `test/viewer/browser.ts` harness, with a slowed `FakeIndex`.
- `r7-wf-experiment-lost-update.ts` calls the workflow library directly.

### M1. Client router (`src/viewer/ui/index.html`)

States: `sessions`, `session(id, eventId)`, `experiments`. Every route gets a new `navSeq` token. Async work checks `current(seq)` before it renders. `setView` runs the previous view's `cleanup`, which removes its keydown listener.

| from | event | to | guard / effect | file:line |
|---|---|---|---|---|
| any | `hashchange`, boot | route(parseHash) | `++navSeq`, clear live region | index.html:587-600, 1867 |
| any | `#/s/<id>[/<ev>]` | session.loading | `setView` cleans up the previous view | 595, 1197-1201 |
| any | `#/experiments` | experiments.loading | | 596, 1674-1677 |
| any | other | sessions | | 597, 688 |
| session.loading | fetches settle | session.ready / not-found / error | drops the result unless `current(seq)` | 1206-1223 |
| session.ready | j/k, click | same (selects a tab) | `history.replaceState`, so no hashchange | 1341-1358 |
| session.ready | "Load more events" | session.ready (+5000 events) | button disabled while loading; seq check | 1314-1338 |

Invariant (holds): a response from an old route never renders. Every await in `showSession`, `showSessions`, `showExperiments` and the deep-link loop (1237-1243) is followed by `current(seq)`. Listeners are registered only after the last await, so an early return leaks nothing.

### M2. Sessions list (`list` object, index.html:604-621)

The state is the tuple `{loaded, error, items, hasMore, hits, filters, q, expanded, children}`. The rendered state comes from `renderSessions` (720-757):

- `error` set → error panel
- `!loaded` → skeleton (the filter bar is not rendered)
- loaded, stats 0 → `captureEmpty`
- otherwise → filters plus `hitsList` or `sessionList`

| from | event | to | guard | file:line |
|---|---|---|---|---|
| unloaded or error | showSessions | loading → loaded / error | navSeq | 688-701 |
| loaded | showSessions (return from detail) | loaded (cached, **never refreshed**) | — | 692 |
| loaded | chip click | loading → loaded / error | navSeq only (no load sequence) | 818-833 |
| loaded | "Load more" | loaded, `items += page(offset = items.length)` | navSeq only; **does not set loading, so chips stay clickable** | 920-937, 668-675 |
| any | type in search (200 ms debounce) | hits / error | `searchSeq` (677-686) plus navSeq | 768-792 |
| error | "Try again" | loading → loaded / error | navSeq | 708-718, 734 |
| loaded | sub-toggle / ArrowRight | `expanded += id` (fetches children once) | navSeq | 943-970 |
| loaded-empty | 3 s poll finds a session, or "Check again" | `loaded=false` → route() | `panel.isConnected`, `document.hidden` | 1063-1084 |

Intended invariants and whether they hold:

1. **items match the filters.** Broken by "Load more" followed by a chip click (VWR-2).
2. **No duplicate rows.** Broken by offset drift during ingest (VWR-1) and by `expanded` in the "all" scope (VWR-4).
3. **error is cleared by a successful load.** Broken for search (VWR-3).
4. **hits respect the active filters.** Only the agent filter is applied (VWR-5).
5. **The empty-state poll stops when its panel leaves the page.** Holds: 0 polls in 7 s while on `#/experiments`, and a new session was picked up on return.

### M3. Server request handling (`src/viewer/server.ts`)

Stateless per request, except for auth.

Auth flow: `/?t=<tok>` → 302 that sets the `csh_t_<port>` cookie (155-163). After that, a cookie or Bearer token is required on `/` and `/api/*` (164, 177-181). A bad token gives 401, which the client shows as "Viewer locked" (525, 568). The Host check (147) and the Origin check on POSTs (524) guard every request. `hostSet` is empty until `listen` resolves, then it is filled synchronously (253-255), so no request can get in between.

Pagination is by offset on a moving `ORDER BY started_at DESC` (server.ts:600-619, store/sqlite.ts:547). Event pages use `ORDER BY ts, rowid` (sqlite.ts:482). That order is stable for appends, but not when an event arrives with an earlier `ts`.

Partial ingest: `ingest.ts:377` flushes events in 500-event batches before the checkpoint's `recompute` writes the session row (346-356). `workflows/import.ts:68-69` also writes events before sessions. `/api/search` reads `events_fts` with no sessions join (sqlite.ts:491-506).

### M4. MCP (`src/mcp`)

- **`McpServer`:** `legacyVersion` is set by `initialize`; `initialized` is set by `notifications/initialized` (protocol.ts:135, 193) but never gates anything. Modern requests are stateless.
- **stdio loop:** requests run serially on `chain` (294-312). `finish` drains the chain; `interrupt` resolves immediately and abandons the in-flight request (336-343).
- **Store:** `opened` is opened lazily, and `opened=undefined` after an open fails (59-65). `ingesting ??=` is a shared ingest, throttled by `lastIngest` (83-94). `close()` clears `opened` (107-119).
- **`resources/list`:** the cursor is a raw offset over the same moving order (resources.ts:18-34).

### M5. Workflow runs (`src/workflows`)

The run lifecycle is implicit: imported, or `driver-run` (experiment, replay) → stored (`putRun`: atomic run file, then an `index.jsonl` line where the last one wins) → scored (score lives only in `experiment.scores`) → replayed (a new run with `resumedFrom`, restat on the second pass).

| from | event | to | guard | file:line |
|---|---|---|---|---|
| none | import run dir | stored (id from journal, deterministic) | skipped when `signatureOf(id) === signature` | import.ts:55-83 |
| stored | re-import (changed or `--force`) | stored, keeping variant/experimentId/caseId/attempt/tags | read-modify-write on `getRun`, no lock | import.ts:72-77 |
| resumed | second import pass | restat against base | base must exist | import.ts:85-90 |
| none | experiment job | stored + `record.runIds += id`, `record.scores[id]` | in-memory record, full rewrite after each job | experiment.ts:117, 150-159 |
| stored | `workflows score` | `exp.scores[id] = x` | read-modify-write, no lock | cli/commands/workflows.ts:357-362 |
| stored | replay | new run, tags +replay, `resumedFrom` | | replay.ts:221-236 |

Invariant: record.runIds = {runs with this experimentId}, and record.scores includes every score written. Broken (VWR-6).

Importing the same run twice does **not** create duplicate runs. The id is deterministic, `lines()` keeps the last line per id, and `test/workflows/store-import.test.ts` covers the skip.

### Checked and ruled out

- **Stale session detail after fast navigation:** the navSeq guards hold.
- **Chip-then-chip filter race:** can't be reached, because the filter bar is replaced by the skeleton while a load runs.
- **Typed-search races:** handled by `searchSeq`.
- **Empty-state timer leak:** none, confirmed by repro (0 polls while away).
- **Duplicate runs from importing twice:** none (see M5).

### Findings

| id | sev | conf | summary |
|---|---|---|---|
| VWR-1 | medium | yes | "Load more" uses offset = rows shown. A session ingested meanwhile shifts the order, so a row is repeated. Repro: `["s10"]` duplicated. |
| VWR-2 | medium | yes | "Load more" in flight, then a chip click: the old page 2 is appended to the new filter's list. Repro: under "codex", 15 rows, 5 of them claude-code and 5 duplicates. |
| VWR-3 | medium | yes | One failed search leaves `list.error` set. Every later successful search still shows the error panel. |
| VWR-4 | low | yes | Subagents expanded in top-level scope, then switching to "all": the child row appears twice, with no way to collapse it. |
| VWR-5 | low | yes (code) | Search results apply only the agent filter. Flag, repo and scope chips show as pressed but have no effect. |
| VWR-6 | medium | yes | The workflow experiment record loses updates: a `workflows score` written during a run is overwritten, and `--concurrency>1` dropped a runId in 2 of 10 tries. |
| VWR-7 | low | yes (code) | Events are searchable before their session row exists, so a search hit can open "Session not found", and session stats lag behind the events. |
| VWR-8 | low | yes (same query as VWR-1) | The MCP `resources/list` offset cursor repeats or skips sessions during ingest. |

## Findings detail

### CAP-1: Ingest lock lets two holders in: isStale() is true on ENOENT and the stale lock is broken with an unconditional rmSync

- **Severity:** high; confirmed: yes; status: fixed (regression test added)
- **Impact:** Two ingesters (hook kick, ui 3s interval, MCP, manual ingest) run over the same spool range at once: every sink gets duplicate batches, last-writer-wins cursors can move backwards (more re-sends), and the holder never notices it lost the lock. Happens under normal contention, not just after crashes.
- **Evidence:** src/core/lock.ts:65-71 (statSync ENOENT -> return true), lock.ts:102-104 (rmSync(path) then retry; deletes a lock a third process just O_EXCL-created); no fencing after acquire, lock.ts:109-127; cursors last-writer-wins at src/store/sqlite.ts:559-561. Repros: audit repro (capture/)r1-lock-race.ts -> 'round 0: 3 of 8 processes hold the lock at once ... BUG: up to 3 concurrent holders'; audit repro (capture/)r1b-lock-contention.ts (no stale lock) -> '240 acquisitions, 2 found another holder inside the critical section'; impact audit repro (capture/)r1c-double-holder-impact.ts -> '20 captured events -> sink received 40'
- **Fix:** (1) isStale must return false when the file is gone; the caller just retries tryCreate. (2) Break a stale lock atomically: renameSync(path, path+'.stale.'+pid+rand), re-stat the renamed file and only proceed if its ino/content matches what was judged stale (otherwise link it back). (3) Put a random nonce in the lock body; release() and a new lock.assertHeld() compare the nonce, not the pid; ingest calls assertHeld() before every setCursor/sink write and aborts with LockLostError if it was stolen (fencing for the sleep/stall case).
- **Regression test:** test/core/lock.test.ts: spawn 6 child processes that loop acquire→mkdir(critical marker)→3ms→rmdir→release 40 times, assert zero overlaps; and 8 processes racing on one dead-pid lock with waitMs 0, assert exactly one acquires. Unit test: a lock whose nonce changed makes assertHeld() throw and ingest commits no cursor.

### CAP-2: A leftover lock file (dead holder) disables every hook-triggered background ingest

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** After an ingest is SIGKILLed, crashes, is SIGTERM/SIGHUP'd (e.g. closing the terminal running `coding.sh ui`) or gets a double Ctrl-C (process.exit(130) skips finally), no Stop/SessionEnd ever kicks an ingest again. Sessions and sink delivery stall until the user runs a foreground read that breaks the lock; headless or sink-only setups stop exporting.
- **Evidence:** src/spool/kick.ts:25 `if (existsSync(p.ingestLock)) return undefined` (no staleness check); src/cli/main.ts:272 process.exit(130) on second SIGINT; no SIGTERM/SIGHUP handler; ingest.ts:151-155 release only in finally. Repro audit repro (capture/)r2-kick-stale-lock.ts -> 'isStale(lock) = true' then 'dead-holder lock -> 0/50 Stop events spawned an ingest'
- **Fix:** In kickIngest replace existsSync with isStale(p.ingestLock) from core/lock.ts (node:fs/node:os only, fine on the hot path), or always spawn and let the waitMs:0 child decide. Also register held locks in a module set and rmSync them synchronously in process.on('exit') (this covers process.exit(130)), and handle SIGTERM/SIGHUP in the CLI by aborting and releasing.
- **Regression test:** test/capture/kick.test.ts: write a lock with a dead pid and a day-old ts, assert kickIngest('Stop') spawns; with a live-pid fresh lock assert it still skips. CLI test: start `ingest` with a slow fake adapter, send SIGTERM, assert .ingest.lock is gone.

### CAP-3: Lost wakeup: a Stop captured while an ingest holds the lock is not ingested by anyone

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** Each hook call writes a new per-pid file. A running ingest only sees the file list it took at its start, and the new Stop's kick is skipped because the lock exists. The session's last turn stays out of the index and sinks until some unrelated later trigger; if that is more than 10 min later the session also gets no endSnapshot (END_SNAPSHOT_MAX_AGE_MS), so `eval new` has no reference patch.
- **Evidence:** src/core/ingest.ts:320 single listSpoolFiles() snapshot per run, no re-scan; src/spool/kick.ts:25 skip when the lock exists; ingest.ts:261 10-min endSnapshot cutoff. Repro audit repro (capture/)r3-lost-wakeup.ts -> 'kick for session B: skipped (lock exists)', 'cursor of B's file: 0', 'session B indexed: false'
- **Fix:** Pending-marker protocol: the hook touches spool/.ingest.pending before checking the lock. The holder clears the marker before its pass and, after release(), re-acquires (waitMs 0) and runs again if the marker exists (bounded loop). The ordering (hook: write→touch→check lock; holder: release→check marker) closes the window.
- **Regression test:** test/core/ingest.test.ts: fake adapter stalls the first line, a new pid file plus kickIngest is written mid-run, then assert that after ingest() resolves (with the re-run loop) the new file's cursor equals its size and the session exists.

### CAP-4: gc deletes spool files but keeps their cursors (and runs without the ingest lock); a file recreated at the same path is read from a stale offset

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** With [retention] keepSpoolDays = 0 (allowed, min 0; privacy-minded users set it), a pid reused the same UTC day by a later hook (common with per-call pid files and macOS pid wrap), or the long-lived `coding.sh run` wrapper still appending, writes to a path whose old cursor survives. Ingest starts mid-line and drops the new event(s). Sink cursors are not reset by the 'cursor past end' guard either, so a sink can skip recreated content entirely.
- **Evidence:** src/core/gc.ts:125-143 unlinks the file, never clears index cursors (local or sink:*), takes no lock; src/core/ingest.ts:321-325 resets only local; ingest.ts:282 sink filter offset>=from. Repro audit repro (capture/)r4-gc-stale-cursor.ts -> 'gc deleted spool files: 1 | cursor still: 186', then 'ingest #2 lines: 0 errors: ["invalid JSON: Unexpected non-whitespace character after JSON at position 3"]', 'session 'new' indexed: false'
- **Fix:** gc's spool phase acquires the ingest lock (waitMs 0; skip the spool phase when busy), re-stats each file under the lock, and after unlinking resets the local and all sink:<name>:<source> cursors (add IndexStore.deleteCursor, or setCursor(...,0)). In ingest, when local > size also reset sink cursors > size. Optionally store file identity (ino/birthtime) next to the cursor and reset on mismatch.
- **Regression test:** test/core/gc.test.ts: keepSpoolDays=0, ingest one line, gc, append a longer line at the same path, ingest; assert the new session is indexed and no error. Plus: a sink cursor > size is reset when the file is recreated.

### CAP-5: Raw spill side file orphaned when the spool append fails or the hook dies between the two writes; gc can never delete it

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** Payloads over 256 KB (up to 64 MB of prompts or tool output, possibly secrets) stay under spool/<agent>/raw/ forever after an ENOSPC/EIO/quota error or a hook SIGKILL (agent hook timeout is 10 s) between the raw write and the append. This breaks the documented keepSpoolDays retention.
- **Evidence:** src/spool/write.ts:98-103 raw written first, :107 append second, no cleanup on failure; src/core/gc.ts:131-135 deletes only raw files named by lines of a fully-read spool file (rawFilesOf). Repro audit repro (capture/)r5-orphan-raw.ts -> 'append failed with: EISDIR | raw side files on disk: [...]', 'gc removed raw files: 0 | still on disk after gc (30 days old): 1'
- **Fix:** In appendSpool wrap the append in try/catch and unlinkSync(rawFile) before rethrowing. In gc, also sweep <agent>/raw/*.json older than keepSpoolDays that no remaining spool line references (build the referenced set while scanning).
- **Regression test:** test/capture/hook.test.ts: force an append failure (spool path is a directory) with a >256 KB payload, assert no raw file remains. test/core/gc.test.ts: an unreferenced raw file older than keepSpoolDays is deleted and a referenced one is kept.

### CAP-6: Torn final line (partial write) is never consumed or gc'd, and fuses with the next line appended to the same path

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** After a partial write (ENOSPC/EIO), the file's cursor parks before the fragment forever: every ingest re-opens it, gc never removes it (cursor < size), and if the path is appended again (pid reuse the same day) the fragment and the next good event both become one invalid-JSON line and are dropped.
- **Evidence:** src/core/spool-read.ts:110-112 a trailing line without newline is left for 'the next run' with no age bound; src/core/gc.ts:130 keeps files with cursor < size; write.ts:107 appends with no leading separator. Repro audit repro (capture/)r6-torn-tail.ts -> 'cursor: 186 of size 226 | gc deleted: 0', then 'ingest after reuse: lines 0 errors ["invalid JSON: Expected ',' or '}'..."]', 'session s2 indexed: false'
- **Fix:** Writer: open with O_APPEND, fstat, and if size>0 and the last byte is not '\n' write a leading '\n' (blank lines are already skipped), so a fragment can only cost itself. Reader: when the trailing partial line is older than e.g. 1 h (file mtime) report it, advance the cursor to EOF so gc can proceed.
- **Regression test:** test/core/spool-read.test.ts: file = good line + 40-byte fragment with mtime 2 h old; assert ingest reports one error and cursor == size; then append a good line and assert it is ingested.

### CAP-7: Spool files are ingested in pid-string order, not time order, so tool.end can precede its tool.start and lose its duration

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** PreToolUse and PostToolUse are separate hook processes, so separate files. When the end's pid sorts first as a string (digit rollover 9999→10000, or pid wraparound at 99999 on macOS), toolDurationFiller marks the session loaded, finds no start, and stores the tool.end without durationMs. The start ingested moments later never back-fills it, so slow-tool stats and detectors silently miss those calls for agents that don't send duration_ms.
- **Evidence:** src/core/spool-read.ts:65 names.sort() (lexicographic, <day>.<pid>.jsonl); src/core/ingest.ts:450-458 lookup once per session then skip; putEvents is insert-once. Repro audit repro (capture/)r7-pid-order.ts -> 'start pid 9998, end pid 9999: durationMs = 1234', 'start pid 9999, end pid 10000: durationMs = undefined', 'start pid 99990, end pid 112: durationMs = undefined'
- **Fix:** Sort each agent's files by (UTC day, mtimeMs, source) instead of name (each hook file is written once, so mtime ≈ event time). Make the filler tolerant: keep tool.ends without a start in a per-run pending map and fill them when the matching start arrives before the checkpoint flush.
- **Regression test:** test/core/ingest.test.ts: tool.start in fake/<day>.9999.jsonl and tool.end in fake/<day>.10000.jsonl (and the 99990/112 pair); assert the tool.end gets durationMs = end.ts − start.ts.

### EXP-1: Ctrl-C during exp run persists the partial experiment as a normal completed result; aborted/killed trials are stored as failures

- **Severity:** high; confirmed: yes; status: fixed (regression test added)
- **Impact:** An interrupted experiment becomes indistinguishable from a real one: exp list shows it, `--name` resolves to it (newest wins), and exp compare against it reports regressions/'worse' for an unchanged agent. JSON output even says outcome:'completed' before the CLI exits 130.
- **Evidence:** main.ts:268-273 aborts the controller; experiments/run.ts:116-118 turns every queued job into {error:'aborted',pass:false}; the in-flight task is SIGKILLed via proc.ts:75-76, giving a TaskError; run.ts:176-194 then summarizes and putExperiment()s with no aborted check; exp.ts:77 prints outcome 'completed'. Repro r1-exp-sigint.mjs: v1 passes 6/6; v2 (same agent, one SIGINT at 1.5s) exits 130 and is stored with runs:6, passed:2, errors:4; `exp compare v1 v2` gives verdict 'worse', 4 regressions, diff -0.67.
- **Fix:** If signal.aborted when the pool drains, do not putExperiment (or persist it with status:'cancelled' and only completed runs, and make compare/resolveExperiment refuse cancelled experiments unless forced). Don't record never-started jobs as runs. Emit outcome:'cancelled'.
- **Regression test:** cli test: start `exp run` with a 400ms/case command task and concurrency 1, send SIGINT after ~1s, assert exit 130, that `exp list --json` has no completed experiment for that name (or it is marked cancelled), and that `exp compare v1 <name>` refuses.

### EXP-2: compare (runner), eval validate and toolevals run ignore the first SIGINT; the second hard-exits, leaking detached agent process groups and runs/<id>/work dirs

- **Severity:** high; confirmed: yes; status: fixed (regression test added)
- **Impact:** Ctrl-C does nothing for up to 30 min per run, so users press it twice. process.exit(130) then skips every finally: agents in their own process groups keep running (API spend, CPU) after the CLI is gone; full repo copies plus isolated HOME overlays stay under runs/; eval validate's mkdtemp workRoot stays in tmp; no RunResult is stored for in-flight runs, so `compare --experiment <id>` silently analyses a partial, unbalanced experiment (there is no experiment record or expected-total to check against).
- **Evidence:** compare.ts:51-61, eval.ts:75-83 and toolevals.ts:375-392 pass no signal; RunTaskOpts (runner/run.ts:20-42), RunExperimentOpts (runner/experiment.ts:25-46), validateTask and runToolExperiment accept none. main.ts:272 calls process.exit(130) on the 2nd SIGINT. Children are spawned detached (_util.ts:781, exec.ts:57), so the terminal's SIGINT never reaches them. Repro r3-runner-sigint.mjs (same handler as main.ts around the runner call compare.ts makes, using the wrapper adapter): after the 1st SIGINT the child is still running 2s later; after the 2nd it exits 130, two runs/<id>/work dirs remain, and both agent pids are still alive.
- **Fix:** Thread an AbortSignal through runExperiment → runTask → adapter.run/spawnAgent/sh (kill the group on abort), validateTask and runToolExperiment; stop scheduling new jobs once aborted. Track live child pgids in a registry and SIGKILL them in a process 'exit' handler so the 2nd-SIGINT path also cleans up. Record an experiment row (status + expected job count) so partial experiments are detectable.
- **Regression test:** runner test: runExperiment with a wrapper agent that sleeps 30s and an AbortSignal aborted after 300ms; assert it resolves within ~1s, the agent pid is dead, runsDir is empty, and results are marked cancelled. CLI test: spawn `compare --yes` with a sleeping wrapper bundle, send SIGINT once, assert exit within 2s and no surviving agent pid.

### EXP-3: SIGTERM (no handler) orphans every detached child and discards all completed exp run trials

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** kill, CI cancellation, a closed tmux pane or a systemd stop leaves agent, task and verifier process groups running indefinitely. For exp run all finished work is lost because the result is only written at the end and there is no resume.
- **Evidence:** No process.on('SIGTERM') anywhere in src/cli (only serve.ts handles signals). Children are detached (proc.ts:52-61). ExperimentResult is written only at run.ts:194. Repro r1-exp-sigint.mjs (R2 part): SIGTERM to `exp run` 1.5s in leaves the task child pid alive, and no v3 experiment is stored.
- **Fix:** Handle SIGTERM like SIGINT (abort, then kill the registered child groups on exit). Persist CaseRuns incrementally (append-only, as toolevals does with trials.jsonl) together with a status, so an interrupted run is recoverable or at least visible.
- **Regression test:** cli test: spawn `exp run` with a 20s task that writes its pid, send SIGTERM, assert the task pid is gone within 1s of the CLI exiting.

### EXP-4: Command grader treats any parseable stdout as the grade even when the grader crashed, exited non-zero or was killed; an aborted grade is recorded as a FAIL rather than an error

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** A grader that prints a debug value (`1`, `true`, `{"pass":true}`) and then crashes, OOMs or is SIGKILLed records a pass, inflating pass rates. Conversely a grader killed by Ctrl-C or OOM with no stdout records a genuine failure instead of an unknown grade.
- **Evidence:** external.ts:82 only treats spawnError/timedOut as errors; :84-96 return coerceGrade(parsed) without checking r.exitCode or r.signal; :98-99 make a signal kill a fail. Repro r4-grader-exit.mjs: 'echo 1; exit 3' → {score:1,pass:true}; 'echo true; kill -9 $$' → pass:true; '{"pass":true}; exit 1' → pass:true; a grader aborted via its signal → {pass:false, reason:'killed by SIGKILL'}.
- **Fix:** Treat r.signal !== null (and an aborted signal) as a GraderError. Accept a stdout grade only when exitCode === 0, or document an explicit opt-in (e.g. `stdoutGradeOnFailure: true`); otherwise a non-zero exit with JSON should be an error.
- **Regression test:** graders test: commandGrader('/bin/sh -c "echo 1; exit 3"') rejects (or fails with an error); 'echo true; kill -9 $$' rejects; an aborted signal rejects with GraderError.

### EXP-5: Processes settle on 'close', so a command that exits 0 but leaves a background child holding stdout is reported as a timeout after the full timeout (and never settles when timeout is 0)

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** A verifier or setup that starts a server or watcher in the background (`npm start & ...; exit 0`) turns every passing run into 'verifier timed out' (pass=false) after the 10-min verifier / 15-min setup default; the same applies to agents (30 min), toolevals checks and command tasks and graders. With timeoutMs:0 (allowed for command tasks and graders) the experiment hangs forever. The 'reap grandchildren' kill in finish() never gets a chance to run.
- **Evidence:** exec.ts:98, proc.ts:126, _shared/run.ts:112 and _util.ts:844 all finish only on 'close'; runner/run.ts:141-144 turns timedOut into pass=false. Repro r5-exec-bg.mjs: sh('sleep 30 & echo tests passed; exit 0', 2000ms) → {exitCode:null, timedOut:true, 2004ms}, so runTask pass=false; runProcess gives the same; with timeoutMs:0 it is still pending after 2s although the shell exited immediately.
- **Fix:** Listen for 'exit'; on exit, SIGKILL the process group (that closes the inherited pipes), then resolve on 'close' with a short grace cap. Report the exit code from 'exit', not timedOut.
- **Regression test:** exec test: sh('sleep 30 & exit 0', {timeoutMs: 5000}) resolves in < 1s with exitCode 0 and timedOut false, and the sleep pid is dead; the same for runProcess with timeoutMs 0.

### EXP-6: Grader errors (e.g. LLM judge HTTP 529 after retries) make the case-trial a failure, so infrastructure outages show up as regressions in exp compare

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** A partial judge outage during experiment B produces 'worse' verdicts and lists regressions for identical outputs. summary.errors counts only task errors, so the run does not look broken; the CLI exit code stays 0.
- **Evidence:** experiments/run.ts:155-157 records {error}; :165 sets pass = grades.every(g => g.result?.pass === true), so a grade error means fail; summarizeRuns :218 counts only run.error; compare.ts uses caseRates(r.pass). Repro r7-grader-error.mjs: identical task, the grader throws on 6/12 cases → B passed 6/12, errors 0, grader errors 6; compareExperiments(A,B) gives verdict 'worse', 6 regressions, diff -0.50.
- **Fix:** Model a grade as pass/fail/unknown: a run with any grader error gets pass undefined (or the experiment is marked degraded), is excluded from paired stats and is counted in summary.errors; compare warns or refuses when either side has grader errors.
- **Regression test:** experiments test: run two experiments with the same outputs where B's grader throws on half the cases; assert compareExperiments does not return 'worse' and that the excluded/errored count is reported.

### EXP-7: A tool-eval trial whose sandbox setup fails leaks its sandbox dir even without --keep

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** Every failing-setup trial leaves <toolevals>/<texp>/<trialId>/{work,home,bin,checkbin,hidden,tap.jsonl} behind (hidden/ holds answer files), growing ~/.coding.sh/toolevals across runs.
- **Evidence:** toolevals/experiment.ts:143-144 assigns sbRoot only after prepareSandbox resolves; sandbox.ts:77 creates the dirs before :80-104 can throw; cleanup at :244 is guarded by sbRoot. Repro r6-toolevals-leak.mjs: setup 'echo secret > leaked.txt; exit 3' gives a trial error, and the trial dir with work/leaked.txt remains.
- **Fix:** Compute the trial dir (resolve(expDir, trialId)) before calling prepareSandbox and always rm it unless keep; or have prepareSandbox rm its own dir on failure.
- **Regression test:** toolevals test: runTrial with a failing setup command and keep=false; assert readdirSync(expDir) is empty.

### EXP-8: The runner compare note claims errored runs count as failures, but an errored run (agent timeout, crash, diff failure) that passes the verifier counts as a pass

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** Readers discount errored runs that are actually included as passes; a candidate whose agent times out after fixing the bug gets full credit while the report says otherwise.
- **Evidence:** runner/run.ts:123,136-145 keep pass=true after an agent error; experiment.ts:261 counts r.pass and :270 counts errors separately; :343 says 'they count as failures'. Repro r7-grader-error.mjs (R8 part): a candidate run {pass:true, error:'agent timed out'} → passes 1, errors 1, note 'they count as failures'.
- **Fix:** Report 'N run(s) recorded an error; M of them still passed the verifier and count as passes' (or add a strict mode that fails errored runs).
- **Regression test:** runner experiment test: compare() over a passing errored run asserts the note mentions that errored runs that passed are counted as passes.

### INS-1: `config set <table>.<key>` edits or inserts the key inside a following [[sinks]] table, silently flipping a remote sink to full capture

- **Severity:** high; confirmed: yes; status: fixed
- **Impact:** `coding.sh config set capture.mode full` (or `metadata`) on a config whose [capture] lacks `mode` rewrites sinks[0].mode instead. A metadata-only remote sink starts receiving prompts, code and tool output, the local capture mode is unchanged, and the command prints success. Missing [retention] keys get inserted into the sink table the same way.
- **Evidence:** src/cli/commands/config.ts:59 header regex `^\s*\[([^\][]+)\]` does not match `[[sinks]]`, so `current` stays on the previous table; lines 77-83 match `mode = ` inside the sink block; lines 86-88 insert after lastInTable, which includes sink lines. The probe at 136-146 only type-checks (sink mode full/metadata is valid; unknown sink keys are ignored, core/config.ts:270-301). Repro r2-config-set.ts: file ends with `mode = "full"` under [[sinks]]; loadConfig gives capture.mode=full, sinks[0].mode=full.
- **Fix:** Treat any `[[...]]` or `[...]` line as a table boundary (reuse toml-edit headerName). Better: after the write, assert that loadConfig(after) differs from loadConfig(before) only at the target key path, and refuse otherwise.
- **Regression test:** setTomlKey('[capture]\nredact=["secrets"]\n\n[[sinks]]\nkind="otlp"\nendpoint="http://x"\nmode="metadata"\n','capture','mode','"full"') must leave sinks[0].mode == 'metadata' and set capture.mode == 'full'; same for retention.toolOutputDays.

### INS-2: atomicWrite/applyWrites replace a symlinked agent config with a regular file (dotfiles detached permanently)

- **Severity:** medium; confirmed: yes; status: fixed
- **Impact:** Users who symlink ~/.claude/settings.json, ~/.codex/config.toml, ~/.gemini/settings.json and the like into a dotfiles repo get the link replaced by a copy. The repo never sees the change, later edits diverge, and uninstall (even the exact restore) writes a regular file, so the link is never restored.
- **Evidence:** src/adapters/_shared/files.ts:70-73 writes `${path}.codingsh-tmp-pid`, then `rename(tmp, path)`, which replaces the directory entry; stat at :65 follows the link only for the mode. Same in src/adapters/more/_util.ts:219-222 and installs/mcp writers. Repro r1-symlink.ts: before isSymlink=true, after install isSymlink=false, target lacks hooks, after uninstall still not a symlink.
- **Fix:** In atomicWrite, `realpath` the target first (when lstat says it's a symlink) and write the tmp file next to the resolved path, then rename onto it. Apply the same in applyWrites, or route it through atomicWrite.
- **Regression test:** Create HOME/.claude/settings.json as a symlink to HOME/dotfiles/s.json; install then uninstall; assert lstat(...).isSymbolicLink() stays true and dotfiles/s.json holds the hooks after install and the original bytes after uninstall.

### INS-3: After `codex mcp add`, the coding.sh MCP block in Codex config.toml loses its BEGIN marker: uninstall leaves our server, init never updates it

- **Severity:** medium; confirmed: yes; status: fixed
- **Impact:** Any `codex mcp add/remove` after `coding.sh init` re-serializes [mcp_servers]: our BEGIN comment is dropped and the END marker moves below the user's table. `coding.sh uninstall` finds no block and leaves [mcp_servers.coding-sh]. Codex then keeps launching a coding.sh path after removal, logging an error every session. `init` treats the entry as user-owned and never refreshes a stale path (INS-7).
- **Evidence:** src/adapters/_shared/mcp.ts:81 (`!hasTomlBlock && hasMcpServer` → return undefined), :98 (uninstall needs hasTomlBlock); toml-edit.ts:14-20 needs both markers. Repro r5-codex-block.ts with real codex 0.166.0 (sandboxed CODEX_HOME): after `codex mcp add my-db`, the file has no `# >>> coding.sh:mcp-server`, `# <<< coding.sh:mcp-server` sits after [mcp_servers.my-db], and uninstallMcp returns [] with the entry still present.
- **Fix:** Identify ownership by content, not comments: our entry is [mcp_servers.coding-sh] whose args end in `mcp` and whose command/cli matches mcpLaunchSpec or the installs.json record. Remove or update that table structurally (toml-edit by header range), and clean up orphan markers. Also never let removeTomlBlock span a foreign table header.
- **Regression test:** Seed config.toml with our block, then simulate Codex's rewrite (drop BEGIN, append `[mcp_servers.my-db]` before END); uninstallMcp must remove only [mcp_servers.coding-sh] and keep my-db; installMcp with a new spec must update it.

### INS-4: Gemini settings.json: hook install parses JSONC but writes plain JSON (comments lost for good); the MCP writer on the same file rejects JSONC (partial first init)

- **Severity:** medium; confirmed: yes; status: fixed
- **Impact:** The user's comments in ~/.gemini/settings.json vanish on init. If the agent or user edits the file afterwards, uninstall can't do an exact restore, so the comments are gone for good (only a backup under ~/.coding.sh/backups keeps them). On a commented file the first init writes the hooks but fails the MCP registration, because the strict parser refuses the JSONC; a second init succeeds only because the first one stripped the comments.
- **Evidence:** src/adapters/more/_util.ts:146-159 (parseJsonc + toJson); gemini-cli.ts:350-355; MCP uses planJsonEdit → files.ts:127-137 (JSON.parse). Repro r3: 'comments survive install? false', and after an edit plus uninstall, 'comments restored? false'. r3b: the MCP plan on JSONC throws 'cannot parse … refusing to modify it' while the hooks plan returns 1 change.
- **Fix:** Use one JSONC-aware, comment-preserving editor for both (e.g. jsonc-parser modify/applyEdits) so only the hooks/mcpServers subtrees change. At minimum, use parseJsonc in the MCP path and refuse to rewrite files containing comments unless the user consents.
- **Regression test:** Write settings.json with // comments and a trailing comma; install hooks + MCP in one init; assert both succeed and every comment line is still present; edit an unrelated key; uninstall; assert the comments are still present.

### INS-5: A stale ingest lock disables every hook-started background ingest (sinks and auto-ingest stall indefinitely)

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** If an ingest is killed (kill -9, sleep/power loss, OOM), `.ingest.lock` stays. Every Stop/SessionEnd hook then skips the background ingest, so remote sinks get nothing until the user happens to run a CLI command whose acquireLock breaks the stale lock.
- **Evidence:** src/spool/kick.ts:25 `if (existsSync(p.ingestLock)) return undefined;` with no staleness check, while core/lock.ts:65-74,95-103 would treat that lock as stale. Repro r4-stale-lock-kick.ts: lock with a dead pid, 6 h old → isStale=true, kickIngest returned undefined, spawned=0.
- **Fix:** In kickIngest use `existsSync(lock) && !isStale(lock)` (the child already takes the lock without waiting and exits if it's busy).
- **Regression test:** Write a lock with pid 999999 and mtime 1 h ago; kickIngest('Stop', env, fakeSpawn) must spawn once; with a fresh live lock (own pid, now) it must not.

### INS-6: `coding.sh update` never refreshes ~/.coding.sh/bin/hook.mjs or cli-path; doctor reports the stale hook as healthy

- **Severity:** medium; confirmed: yes; status: fixed
- **Impact:** After an update every agent keeps running the old hook bundle (hook fixes, new spool fields, kick logic never ship) next to a newer CLI that ingests its output. If the update installs to a different prefix, cli-path still names the old CLI, so background ingests run the old version. Nothing tells the user to re-run init.
- **Evidence:** planHookBin/writeHookBin are called only from init (src/cli/commands/init.ts:130,174); src/cli/commands/update.ts:137-162 ends after npm install; doctor.ts:111,140 checks only existsSync(p.hook).
- **Fix:** After a successful update, spawn the new CLI to run the hook-bin refresh (`<new cli> init --refresh-bin` or a hidden `hook sync`). Have doctor compare the hook.mjs content to hookSource() and cli-path to runningCli(), and warn `run coding.sh init`. Optionally the CLI could refresh the bin lazily when it detects a mismatch.
- **Regression test:** Write an old hook.mjs in a temp CODING_SH_HOME; run runUpdate with an install stub that succeeds; assert hook.mjs equals hookSource() afterwards (or that doctor --json reports hook.stale=true).

### INS-7: MCP registration pins process.execPath and the cli.mjs that ran init (nvm-versioned node, npx cache): breaks silently on node switch, cache eviction or prefix change

- **Severity:** medium; confirmed: yes; status: fixed
- **Impact:** `npx coding.sh init` or any nvm user registers `~/.nvm/versions/node/vX/bin/node ~/.npm/_npx/<hash>/…/cli.mjs mcp` in every agent. After `nvm uninstall`, npx cache eviction or an update to another prefix, every agent's coding-sh MCP server fails to start. doctor doesn't check it, and hooks (which use `node` on PATH) keep working, which hides the problem.
- **Evidence:** src/mcp/launch.ts:15-24,32-34; init.ts:100. Repro r8-mcp-pin.ts output: {"command":"/Users/…/.nvm/versions/node/v22.19.0/bin/node","args":["~/.npm/_npx/9f1c/node_modules/coding.sh/dist/cli.mjs","mcp"]}. hookbin.ts:2-4 states the stable-path goal, but MCP doesn't use the stable bin.
- **Fix:** Register a stable launcher: a small `~/.coding.sh/bin/mcp.mjs` (copied like hook.mjs) that reads bin/cli-path, run with `node` from PATH. Or use `coding.sh mcp` when the binary is on PATH and the cli path is under an npx cache. Have doctor verify each registered MCP command/args exist.
- **Regression test:** mcpLaunchSpec(runningCli('<tmp>/.npm/_npx/x/node_modules/coding.sh/dist/cli.mjs')) must not contain '_npx' or a versioned node path; doctor --json must flag an MCP entry whose args[0] does not exist.

### INS-8: A default-project ingest key can write into any other project's sessions by sending sessionId `<project>/<id>`

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** On a multi-project `coding.sh serve`, a client holding a default-project ingest key (native /v1/ingest or OTLP conversation id) can append arbitrary events into another tenant's sessions. Those events then show to that project's scoped read keys. This breaks the partitioning invariant documented in project.ts.
- **Evidence:** src/server/project.ts:14-18 returns the id unchanged for 'default', and 'already-prefixed id is kept'; queue.ts:272 applies scopeEvents to both native and OTLP; native.ts:44 allows '/' in sessionId; sessions.ts:256-257 takes the project from the first event that has one. Repro r7-project-escape.ts: alpha sid and intruder sid are both 'alpha/chat-1'; session project=alpha with events ['alpha:…','default:injected by default-project key'].
- **Fix:** Reject (or escape) session ids from the default project that start with `<known-project-id>/`, or that match /^[a-z0-9][a-z0-9-]{0,62}\// at all, and remove the 'already-prefixed' idempotency for non-matching projects. Alternatively always prefix default-project ids that contain '/'.
- **Regression test:** scopeEvents([{sessionId:'alpha/x'}],'default') must not yield sessionId 'alpha/x'; an end-to-end serve test posts 'alpha/chat-1' with a default key and asserts the alpha read key sees no foreign event.

### INS-9: Cursor hooks (no marker) installed under one CODING_SH_HOME are not recognized under another: re-init duplicates every hook, uninstall leaves the old ones

- **Severity:** low; confirmed: yes; status: fixed
- **Impact:** Running init with CODING_SH_HOME set (a documented override for tests/CI/evals) edits the real ~/.cursor/hooks.json. A later normal init adds a second copy of every hook, so each event spools twice with distinct ids. `uninstall` removes only the current home's entries, and once the temp home is deleted the leftovers fail on every Cursor event.
- **Evidence:** cursor.ts:367 marker:false; hooks.ts:47-55 recognizes only paths ending in `.coding.sh/bin/hook.mjs` or the current paths(env).hook. Repro r6-cursor-home.ts: after 2 inits, sessionStart has 2 commands; after uninstall, the cs-eval one remains.
- **Fix:** Recognize our command by shape (`node "<…>/bin/hook.mjs" cursor <Event>` with a sibling cli-path, or any path in installs.json history), or record every hook path ever installed in installs.json and pass it as knownHookPaths.
- **Regression test:** Install Cursor hooks with CODING_SH_HOME=A, then with B; assert each event has exactly one entry; uninstall under B; assert hooks.json has no hook.mjs entries.

### INS-10: User-scope and project-scope installs coexist with no warning or dedupe, which may double-capture every event

- **Severity:** low; confirmed: no; status: fixed
- **Impact:** For agents that run both user and project hooks without deduping identical commands (likely Cursor, Codex layers), each event is spooled twice. Event ids derive from spool offset, so the index stores duplicates and turn/tool statistics double. Claude Code dedupes identical commands, so it's unaffected.
- **Evidence:** init.ts:94,116 plans only the requested scope and never checks the other; ids from core/ids.ts:22 eventId(agent, sessionId, source, offset); spool/hook.ts has no dedupe. The agent-side double execution was not demonstrated.
- **Fix:** In init, detect our hooks in the other scope for the same agent and warn, or skip unless --force. Optionally dedupe in the hook by (agent, event, payload hash, ±1 s).
- **Regression test:** Install user scope, then project scope for Cursor; assert init prints a warning, or exits non-zero without --force.

### SES-1: Hook + transcript copies of one Claude session double-count turns (and prompts in metadata mode / reversed order / redaction)

- **Severity:** high; confirmed: yes; status: fixed (regression test added)
- **Impact:** stats.turns inflated for every hooked Claude session that is also backfilled (ingest --backfill), and automatically on every CLI read for T3-run Claude sessions (t3code tail runs ClaudeTranscriptConverter each read). The same pattern (position-keyed hook turn.end vs transcript turn.end) applies to gemini-cli, droid, copilot-cli and goose. Duplicate session.start rows inflate stats.events; duplicate user.message rows split MCP turn views.
- **Evidence:** src/adapters/claude-code.ts:203 emits an unkeyed turn.end (id = spool position) while src/adapters/_shared/claude-transcript.ts:332,346 key turn.end by [uuid] or [turnId,'end'], so they never collide; src/core/ingest.ts:571-581,688 dedupes only user/assistant messages, compares pre-redaction text (688) to stored post-redaction/metadata text (620-623), and only in the backfill direction; src/core/sessions.ts:189-191,219 counts every turn.end. Repro audit repro (sessions/)r1-hook-then-backfill.ts: hook ingest gives turns=1; after backfill turns=3 for 2 real prompts, with turn.end rows at 10:00:09.850 (hook) and 10:00:09.900 (transcript) for the same turn, and session.start 1->2. r1b-variants.ts metadata: user.message 1->3 (dupDropped=0); backfill-then-ingest order: user.message rows [transcript:'Add a sum…', hook:'Add a sum…', transcript:'Thanks!'].
- **Fix:** Give the hook Stop turn.end the transcript's natural key: compute the turn key from the Stop window's last prompt (promptId ?? uuid), and key transcript turn.end (turn_duration and synthesized alike) as [turnKey,'end']. Key hook SessionStart ['start'] like the transcript and like Codex. Alternatively, partition in buildSession: when a session has live (non-backfill) turn.end or user.message rows, ignore backfill rows of that kind. Compute messageKey after finishEvent, and also dedupe in spool ingest against existing backfill rows.
- **Regression test:** test/core/ingest.test.ts: ingest test/fixtures/adapters/claude-code/hooks.spool.jsonl, then backfill with CLAUDE_CONFIG_DIR = the fixture config; assert session.stats.turns === 2 and exactly one turn.end per turn. Repeat with capture.mode='metadata' and with backfill-before-ingest, asserting user.message count === 2.

### SES-2: Backfill of a live Claude transcript writes a stale synthesized EOF turn.end; the real end is added later (double turn, wrong duration)

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** Any backfill (or T3 tail, which runs on every read) that sees an open turn leaves a permanent extra turn.end with a truncated durationMs. If the turn closes via the next prompt, the synthesized key collides and first-wins keeps the stale ts/duration.
- **Evidence:** src/adapters/_shared/claude-transcript.ts:382-384 finish() calls endTurn() with no idle guard; :346 keys it [turnId,'end'] with ts=lastTs; :332 the later turn_duration uses key [uuid]. Repro r2-backfill-growing-transcript.ts: backfill #1 (turn open) turns=1 [synth 1000ms]; after appending the tool_result and turn_duration, backfill #2 gives turns=2 [synth 1000ms, real 61100ms]; expected 1 turn of about 61100ms.
- **Fix:** Only synthesize an end-of-file turn.end when the transcript is idle (Date.now()-lastTs > endIfIdleMs), the same guard as the idle session.end, and key turn_duration turn.end as [turnId,'end'] so a real end and a synthesized end share one id. Same for the more/* tail turn.end (gemini-cli.ts:306-308 and similar).
- **Regression test:** Backfill a transcript ending mid-turn (prompt + tool_use, timestamps now-5min), append tool_result + turn_duration, bump mtime, backfill again; assert one turn.end with durationMs equal to turn_duration.

### SES-3: endedAt is never invalidated by later activity: resumed/continued sessions report ended; Codex endedAt frozen at the first SessionEnd

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** claude --resume / codex resume (same session id), or a backfill/T3 idle guess followed by more activity, leaves the session running=false with its duration frozen while it is active. For Codex (and Claude subagent idle ends) a later real end has the same id and is dropped, so endedAt stays wrong forever.
- **Evidence:** src/core/sessions.ts:205-207,251 take the latest session.end with no check for later events; src/mcp/data.ts:70-72 then reports not running; src/adapters/codex.ts:687 keys SessionEnd ['end'] (also :555 idle, src/adapters/claude-code.ts:393 subagent idle end key ['end'], src/adapters/t3code.ts:328). Repro r3-resume-after-end.ts: claude-code resumed & active: endedAt=04:25 lastEvent=05:21 running=false dur=3min; codex same, and after the resumed run exits codex endedAt stays 04:25 (expected 05:22) with session.end rows=1.
- **Fix:** In buildSession, ignore a session.end whose ts is earlier than the eventEnd of a later captured (non-enrichment) event, beyond a small slack, i.e. treat the session as reopened. Key Codex SessionEnd by line position (unkeyed) or ['end', line.ts], and key backfill idle subagent ends by their last ts.
- **Regression test:** Spool SessionStart, prompt, Stop, SessionEnd(T1), then resume SessionStart and prompt at T1+50min; assert endedAt undefined and isRunning true. For codex, add a second SessionEnd at T2 and assert endedAt === T2.

### SES-4: T3 Code v1 (and opencode) session usage-summary keyed ['usage-summary']: first token snapshot wins forever

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** Token totals for T3 v1 threads freeze at the first value ingested (t3code tail runs on every CLI read, usually early in the thread), so cost and token reports undercount badly. OpenCode sessions without per-message tokens behave the same on repeated backfills.
- **Evidence:** src/adapters/t3code.ts:327 emits the notification with key ['usage-summary'] and usage = running totals (:574-583, 'latest snapshot wins' in the reader); INSERT OR IGNORE in src/store/sqlite.ts:447 and memory.ts:96 drops later snapshots; src/adapters/opencode.ts:403-406 has the same shape. Repro r4-t3-usage-summary-frozen.ts: after the 1st tail usage {in:300,out:100,cacheRead:500}; after a context-window update of 90k/50k/7k and a 2nd tail, still {in:300,out:100,cacheRead:500}; expected {in:40000,cacheRead:50000,out:7000}.
- **Fix:** Treat usage-summary as a snapshot: key it by the snapshot's activity id or ts, and have buildSession use only the latest usage-summary per session instead of summing; or emit deltas between snapshots with distinct keys.
- **Regression test:** Build a v1 state.sqlite with one context-window.updated, backfill t3code, insert a larger snapshot, bump mtime, backfill again; assert stats.usage equals the latest snapshot.

### SES-5: Codex backfill emits subagent.end for still-running child threads; never corrected

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** The parent timeline shows the subagent ended early with ok undefined. Because the id is fixed ([childId]), neither the real completion from a later backfill nor the live SubagentStop (same id) can replace it. Happens on every read for untrusted-hook Codex users (tailWhenUnhooked) and for T3-run Codex.
- **Evidence:** src/adapters/codex.ts:545-550 finish() emits subagent.end unconditionally when parent && full && edges!==false, ts=lastTs, ok=lastOk; same key as hook SubagentStop :682. Repro r5-codex-premature-subagent-end.ts: child mid-run gives subagent.end@10:00:07.900 ok=undefined; after the full rollout (task_complete @08.500) it is still subagent.end@10:00:07.900 ok=undefined.
- **Fix:** Emit subagent.end in finish() only when the child's last turn closed (task_complete/turn_aborted seen after the last task_started) or the rollout is idle beyond ROLLOUT_IDLE_MS.
- **Regression test:** Backfill the first 7 lines of the 0193bbbb fixture rollout; assert no subagent.end in parent 0193aaaa. Then the full file; assert one subagent.end with ts 10:00:08.500 and ok=true.

### SES-6: Stop-hook continuation (stop_hook_active) counts one prompt as multiple turns

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** Users with any blocking Stop hook (common 'run tests before stopping' setups) get inflated stats.turns; the hook path disagrees with the transcript path, which counts one turn per prompt.
- **Evidence:** src/adapters/claude-code.ts:193-204 emits an unkeyed turn.end per Stop, including stop_hook_active=true; src/core/sessions.ts:189-191 counts all turn.end rows. Repro r6-stop-hook-and-toolcalls.ts: one prompt + Stop + Stop(stop_hook_active) gives turns=2 (expected 1).
- **Fix:** Do not count turn.end rows with payload.stopHookActive===true as new turns (keep the latest one as the turn's end ts), or key a Stop turn.end by its window's prompt so continuations collapse onto one turn id.
- **Regression test:** normalizeClaudeLine on UserPromptSubmit, Stop(false), Stop(true); assert buildSession(...).stats.turns === 1.

### SES-7: toolCalls = max(starts, ends) undercounts when one call has only a start and another only an end

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** Sessions with a lost PostToolUse (interrupt or crash) plus a lost PreToolUse (hook failure or spool parse error) report too few tool calls; the two counts are never unioned by toolUseId.
- **Evidence:** src/core/sessions.ts:192-198,221. Repro r6-stop-hook-and-toolcalls.ts: PreToolUse toolu_A (no post) + PostToolUse toolu_B (no pre) gives toolCalls=1 (expected 2).
- **Fix:** Count the distinct toolUseIds over tool.start and tool.end, plus id-less events, instead of max(starts, ends).
- **Regression test:** buildSession over [tool.start A, tool.end B]; assert stats.toolCalls === 2, and that [tool.start A, tool.end A] still gives 1.

### STO-1: Retention corrupts sqlite FTS when a deleted session has a message with empty text

- **Severity:** high; confirmed: yes; status: fixed (regression test added)
- **Impact:** deleteBefore sends an FTS5 'delete' for rows whose generated text is '' but which putEvents never indexed. If the whole old session is empty-text messages, deleteBefore throws SQLITE_CORRUPT (267) and rolls back on every hourly pass, so retention for that project silently stops forever. If the session mixes empty and non-empty messages, deleteBefore commits and every later search() on the DB throws 'database disk image is malformed'. Empty text arrives from native /v1/ingest clients, the Claude Code hook (str(raw.prompt) ?? "") and t3code messages. The memory store has no such failure, and the conformance suite does not cover it.
- **Evidence:** putEvents indexes only when searchableText(e) !== undefined, which is false for text "" (sqlite.ts:468-469, common.ts:73). The generated column yields '' (not NULL) for a text-typed empty payload.text (sqlite.ts:242-246). deleteBefore deletes from FTS WHERE text IS NOT NULL (sqlite.ts:822). r3 prints: control ok; mixed -> deleteBefore ok, then search THROWS 'database disk image is malformed'; allEmpty -> deleteBefore THROWS every time.
- **Fix:** Make insert and delete agree. Add migration v5 that redefines events.text with NULLIF(json_extract(payload,'$.text'),'') (drop and re-add the generated column as v3 did) and runs 'rebuild'. Until then, also filter text <> '' in the ftsDelete statement.
- **Regression test:** sqlite test: put assistant.message {text:''} (one session all-empty, one mixed) in an old session plus a recent indexed message; deleteBefore(cutoff) must not throw, search('tokeni') must still return 1, and INSERT INTO events_fts(events_fts,rank) VALUES('integrity-check',1) must pass. Add the same case to runIndexStoreConformance.

### STO-2: Retention deletes live sessions: cutoff uses coalesce(ended_at, started_at), not last activity

- **Severity:** high; confirmed: yes; status: fixed (regression test added)
- **Impact:** A resumed session (endedAt = the earlier run's session.end) or one that never sent session.end (endedAt unset, so started_at is used) is deleted mid-flight, including events written minutes ago, and is then rebuilt from only the events that arrive afterwards. The 'keep N days' promise breaks for active work.
- **Evidence:** sqlite.ts:815 and memory.ts:79 select by coalesce(ended_at, started_at). buildSession sets endedAt only from session.end, or last activity for OTel conversation and transcript sessions (core/sessions.ts:205-206,250-251). r1 with retention 1 day: a resumed session (endedAt 71 h old, last event 5 min old) and a never-ended session (started 2 d ago, last event 1 min ago) are both deleted: {sessions:2, events:7}.
- **Fix:** Expire on last activity: WHERE (SELECT MAX(ts + coalesce(duration_ms,0)) FROM events WHERE session_id = s.id) < ?, or keep a last_event_at column maintained by putEvents. Mirror it in MemoryIndexStore.deleteBefore and state the rule in the IndexStore contract.
- **Regression test:** conformance: a session with startedAt and endedAt older than the cutoff but one event newer than the cutoff survives deleteBefore. Retention test with the r1 resumed-session fixture built through rebuildSessions.

### STO-3: gc sweeps blobs still held by EvalTask.validation.impossible.variant.hiddenFiles and toolevals TrialResult.tapBlob

- **Severity:** medium; confirmed: yes; status: fixed (store side + tapBlob write side)
- **Impact:** About 24 h after creation (1 h under serve's sweep), the stored impossible-variant hidden test files and every toolevals trial tap log are deleted from the main blob store. `toolevals show <trial>` then silently shows an empty tap, and tasks keep refs to missing blobs.
- **Evidence:** validate.ts:405 and toolevals/experiment.ts:238 put into the main store (cli toolevals.ts:384 passes ctx.blobs). taskBlobs (common.ts:133-138) and sqlite referencedBlobs (sqlite.ts:753-759) cover only verifier.hiddenFiles, referencePatch, nearMissPatches, bundle files and run diffBlob. tapBlob is stored only in trials.jsonl. r2: gc deleted 2 of 3; verifierHiddenKept true, impossibleVariantHiddenKept false, tapBlobKept false.
- **Fix:** Add $.validation.impossible.variant.hiddenFiles to taskBlobs and the sqlite UNION. Persist tapBlob on the RunResult the trial already writes (putRun) and include it in runBlobs and the sqlite union. Better: drive both stores from one ref-extractor list in common.ts.
- **Regression test:** gc test: a task with validation.impossible.variant.hiddenFiles and a run with tapBlob; gc at now + 2 days keeps both blobs. Conformance referencedBlobs includes both.

### STO-4: FsBlobStore: no fsync on put, a torn blob is never healed by re-put, and get() returns 0 bytes silently

- **Severity:** medium; confirmed: yes; status: fixed (regression test added)
- **Impact:** After power loss the rename can be durable before the data, while sqlite (WAL, synchronous=NORMAL) keeps the referencing row. Re-ingesting the same content is a dedupe hit that only touches mtime, so the blob stays torn forever. get() does not verify the sha256, and Node's zstdDecompressSync returns an empty buffer for a truncated frame, so readers (viewer, eval hidden files, patches) get empty content with no error. Crashed writes also leave .tmp files that list() and gc never collect.
- **Evidence:** fs-blobs.ts:44-45 has no fh.sync and no dir fsync (recompress at :148-155 does sync). touchIfExists at :38,57-66. get at :77-79 never hashes. List regex at :107 skips .tmp. r4/r4b: after zero-length or half truncation and a re-put, size is still 0 and get() returns 0 bytes (expected 3400 and 8000), with no error.
- **Fix:** In put: write via a filehandle, fsync, rename, fsync the dir. In get: verify sha256(decompressed) === ref and throw or treat as missing on mismatch. In put's dedupe path: if the existing file is empty or fails verification, overwrite it. Have gc remove *.tmp older than minAge.
- **Regression test:** blob-store test: truncate the stored file, put the same content again, then get() returns the full bytes. Truncate without re-put: get() throws or returns undefined, never an empty buffer. gc removes an old orphan .tmp.

### STO-5: gc stat→delete is not atomic with a concurrent ingest dedupe hit, leaving an event that references a deleted blob

- **Severity:** low; confirmed: yes; status: fixed (gc lock + rename-recheck delete; tiny crash window remains)
- **Impact:** CLI `coding.sh gc` holds no lock shared with ingest (the hook-kicked background ingest). If an ingest re-captures the content of an old unreferenced blob between gc's stat and unlink, its utimes refresh comes too late, it commits an event referencing the blob, and gc deletes it. The window is narrow but real.
- **Evidence:** gc.ts:110 stat, :112 age check, :116 delete. core/context.ts:62-65 calls gc without acquiring <spool>/.ingest.lock (ingest takes it at ingest.ts:147-149). r6 (deterministic interleaving through a stat hook): gc deleted 1, the committed event references the ref, blob exists false.
- **Fix:** Have CLI gc acquire the ingest lock for mark+sweep (serve already uses the exclusive lane). Alternatively, sweep by renaming to a trash name, re-checking mtime and the index, then unlinking.
- **Regression test:** gc test with a BlobStore whose stat() yields to an ingest put+putEvents of the same content; after gc the referenced blob must still exist (or gc must have waited on the ingest lock).

### STO-6: FileEvalStore file mode: putDataset is 3 unlocked writes, so history drifts permanently on crash or concurrency

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** Only backends without the dataset methods use file mode (sqlite and memory bypass it). A crash after the version file but before the history append leaves a version that getDataset finds but listDatasetVersions and listDatasets omit, forever, because retries see the file and skip the append. Two concurrent puts of the same version both append history and both report created:true. One torn history line makes listDatasets throw for every dataset.
- **Evidence:** datasets/store.ts:115 read, :123 write version, :126 appendFile, :129 latest, with no lock. :152-155 JSON.parse with no tolerance. writeFileAtomic :31-35 has no fsync. r5: (a) created [true,true], 2 history rows; (b) retry created false, history 0, versions 0; (c) listDatasets throws 'Unterminated string in JSON'.
- **Fix:** Take acquireLock(<datasets>/<id>/.lock) around putDataset. Make the history append idempotent (append when the version is missing from history, not only when the file is new), or derive the version list from versions/*.json. Skip an unparsable trailing history line. fsync in writeFileAtomic.
- **Regression test:** file-mode tests: Promise.all of two identical puts gives exactly 1 history row and one created:true. A pre-existing version file with no history gets its history row after the next put. A torn trailing line still lists.

### STO-7: memory vs sqlite IndexStore differ for the same calls: getBundle tie-break, listExperiments limit 0, dataset version order

- **Severity:** low; confirmed: yes; status: fixed (regression test added)
- **Impact:** memory.ts is presented as the reference implementation, yet getBundle(name) with equal createdAt returns a different bundle (eval runs pick a different harness). listExperiments({limit:0}) returns all rows vs none. listDatasetVersions follows insertion order vs created_at order. Plugin authors get two different behaviours and the conformance suite catches none of them.
- **Evidence:** memory.ts:184 + byCreatedDesc :367 (id ASC) vs sqlite.ts:597 (id DESC). memory.ts:270 (falsy limit means all) vs sqlite.ts:731-732 (LIMIT 0). memory.ts:245 vs sqlite.ts:699. r7: memory b-aaa/2/v-new,v-old vs sqlite b-zzz/0/v-old,v-new.
- **Fix:** Choose one contract per method (e.g. newest createdAt then id DESC; limit<=0 means no limit; versions in insertion order by rowid), apply it to both stores, and add conformance cases.
- **Regression test:** conformance: two bundles with the same name and createdAt; listExperiments({limit:0}); putDataset with non-monotonic opts.now — all assert one specified answer.

### STO-8: Writer-lock lease: a same-host standby can break a live holder after a 2-minute heartbeat gap, and the holder never re-checks

- **Severity:** low; confirmed: no; status: fixed (writer fence + standby; regression tests)
- **Impact:** A synchronous node:sqlite call that blocks the event loop past staleMs (for example the first retention deleteBefore over a large DB, run as one tx) stops the heartbeat. A standby breaks the lock even though the holder pid is alive, so two serve writers then run ticks, retention and gc, and race on kv serve:dirty, where one replica's clear wipes the other's crash-repair list.
- **Evidence:** lock.ts:66-75 (mtime age wins over a live pid), heartbeat :108-115 (setInterval, blocked by sync work). sqlite.ts:783-811 and serve.ts:120-131 never revoke setWritable on loss. r8: after backdating the lock mtime 130 s, a child pid acquires it while the parent still holds its WriterLock. The real >2 min stall was not reproduced.
- **Fix:** Check lock ownership (readHolder pid/host === self) before each tick and exclusive job, and setWritable(false) when it is lost. Or move the lease into the DB as a kv row with an epoch/fencing token that is compared inside putEvents. Chunk deleteBefore into bounded transactions so the loop yields.
- **Regression test:** serve test: the writer acquires, the lock file is replaced by another pid, and the next submit returns 503 standby while no tick writes.

### VWR-1: Sessions 'Load more' offset pagination repeats rows when sessions are ingested between pages

- **Severity:** medium; confirmed: yes; status: fixed (regression tests in test/viewer)
- **Impact:** `coding.sh ui` ingests every 3 s and the client caches the list (showSessions never refreshes when loaded), so any session that lands after page 1 shifts ORDER BY started_at DESC and page 2 repeats the boundary row(s). A gc or delete shifts the other way and silently skips rows. Duplicate ids also confuse aria ids and the active-row index.
- **Evidence:** index.html:669 offset = list.items.length; 671 concat; server.ts:600-619 offset paging; store/sqlite.ts:547 ORDER BY started_at DESC, id LIMIT ? OFFSET ?; ui.ts setInterval autoIngest 3000. Repro r2-offset-drift.ts against the real CLI viewer: {page1:50,page2:11,shown:61,unique:60,duplicates:["s10"],newShown:false}.
- **Fix:** Keyset pagination: return nextCursor=(started_at,id) of the last row and query WHERE (started_at,id) < cursor. Until then, dedupe by id on append in loadSessions.
- **Regression test:** server.test.ts: list limit=50, upsert a newer session, fetch the next page with the returned cursor, and assert no id overlap and that the union equals the pre-insert set. ui-browser: click Load more after inserting a session and assert unique row titles.

### VWR-2: 'Load more' response is appended to a different filter's list (no load sequencing)

- **Severity:** medium; confirmed: yes; status: fixed (regression tests in test/viewer)
- **Impact:** Load more does not enter the loading state, so the chips stay clickable. A chip click starts loadSessions(false). When it resolves first, the stale load-more page (old filter, offset 50) is concatenated onto it and overwrites hasMore. The user sees rows that violate the pressed filter, plus duplicates.
- **Evidence:** index.html:923-936 Load more (navSeq-only guard); 818-833 chip handler; 668-675 loadSessions mutates list.items/hasMore/loaded unconditionally with no request token. Repro r-browser.ts loadMoreThenFilter: pressedChip 'codex', 15 rows = CX-0..4, CC-0..4, CX-0..4 (5 claude-code rows, 5 duplicates).
- **Fix:** Add a listSeq (or AbortController) incremented on every filter, refresh or showSessions load. loadSessions captures it and discards its result when stale. Load more also records the filter key and drops its page if the filters changed.
- **Regression test:** ui-browser: delay listSessions for offset=50, click Load more, then click the codex chip; assert every row's agent is codex and the titles are unique.

### VWR-3: A failed search leaves list.error set, so later successful searches still render the error panel

- **Severity:** medium; confirmed: yes; status: fixed (regression tests in test/viewer)
- **Impact:** Live search gets stuck on 'Something went wrong' after any search error (q > 500 chars returns 400, or a transient 5xx), even after the query is fixed and returns hits. Only the 'Try again' button or navigation clears it.
- **Evidence:** index.html:777-780 catch sets list.error; success path 773-776 never clears it; renderSessions 733 prefers list.error. The input has no maxlength, while server.ts:434 rejects > 500. Repro r-browser.ts searchErrorSticky: firstError 'q is too long'; after typing 'hello' (which matches), errorPanelShown=true and hitsShown=0.
- **Fix:** In search(), set list.error = null after a successful runSearch (changed !== false). Also add maxlength=500 to the input.
- **Regression test:** ui-browser: type 501 chars and wait for [role=alert]; type a matching query; assert no [role=alert] and .hit-snippet count > 0.

### VWR-4: Expanded subagents persist into the flat 'Include subagents' scope, duplicating child rows

- **Severity:** low; confirmed: yes; status: fixed (regression tests in test/viewer)
- **Impact:** After switching scope, the child shows both nested under its parent and as its own row. In the 'all' scope the sub-toggle and ArrowLeft collapse are disabled, so the duplicate can't be removed without switching back.
- **Evidence:** index.html:628-639 visibleRows walks list.expanded regardless of scope; chip handler 818-833 does not clear expanded/children (refreshSessions 711-712 does); 885 and 1045 disable toggling outside topLevelOnly(). Repro r-browser.ts expandedThenScopeAll: rows [CHILD, PARENT, CHILD], toggleButtons 0.
- **Fix:** Walk expanded only when topLevelOnly() in visibleRows, or clear list.expanded on scope change.
- **Regression test:** ui-browser: expand PARENT, click 'Include subagents', and assert CHILD appears exactly once.

### VWR-5: Search results ignore the flag, repo and scope filters while their chips show as pressed

- **Severity:** low; confirmed: yes; status: fixed (regression tests in test/viewer)
- **Impact:** With a flag or repo chip pressed, hits come from every session, so filter state and results disagree. A chip click re-runs the search with identical results.
- **Evidence:** index.html:681 runSearch sends only {q, agent}; server.ts:429-439 /api/search accepts only agent and project; store/sqlite.ts:491-506.
- **Fix:** Pass flag, repo and scope to /api/search and filter (join sessions in SQL, or post-filter by session). Otherwise hide or disable the non-agent chips while hits are shown.
- **Regression test:** server.test.ts: /api/search?q=x&flag=f returns only hits from sessions with that flag. ui-browser: a pressed flag chip narrows hits.

### VWR-6: Workflow experiment record loses writes (score during a run; concurrent job rewrites)

- **Severity:** medium; confirmed: yes; status: fixed (append-only runs log; regression tests)
- **Impact:** runWorkflowExperiment holds the record in memory and rewrites the whole file after every job. A `workflows score` issued mid-experiment is erased by the next job's write. With --concurrency > 1, writeAtomic renames can land out of order, so an older snapshot without the final runId or score stays on disk. `workflows compare` iterates exp.runIds and exp.scores, so runs or scores silently drop out of the verdict, while listRuns({experimentId}) still shows them.
- **Evidence:** experiment.ts:117, 150-159 (record.scores/runIds mutated, putExperiment per job); store.ts:49-53, 158 (tmp + rename, no lock or version); cli/commands/workflows.ts:357-362 score read-modify-write; 529-540 compare reads the record. Repro r7-wf-experiment-lost-update.ts: scoreAfterCliWrite 0.9 → scoreAfterExperimentFinished null; concurrency 8 over 40 jobs left runIdsOnDisk 39 vs runsInStore 40 in 2 of 10 tries.
- **Fix:** Serialize putExperiment per id (promise chain) and re-read and merge on write (union runIds, merge scores), or store scores and membership as appended per-run lines. Compare should take membership from listRuns({experimentId}) rather than record.runIds.
- **Regression test:** workflows test: a driver blocks job 2; write a score to job 1 via getExperiment/putExperiment; release; assert the score persists. Run concurrency 8 over 40 jobs 20 times and assert record.runIds.length === 40.

### VWR-7: Partially ingested sessions: events are visible and searchable before the session row exists or is recomputed

- **Severity:** low; confirmed: yes; status: fixed (regression tests in test/viewer)
- **Impact:** During an ingest window (every 3 s in `ui`, or a hook-triggered ingest), /api/search returns hits whose session has no row yet; clicking one shows 'Session not found'. /api/sessions/:id/events can return more events than session.stats reports. The state is transient but user-visible on new sessions.
- **Evidence:** core/ingest.ts:377 flush every 500 events vs recompute at checkpoint 346-356 (session row written in recomputeSession, 523-543); workflows/import.ts:68-69 writes events before sessions; store/sqlite.ts:491-506 search has no sessions join; index.html:1218 maps 404 to 'Session not found'. The ordering is unambiguous; the timing window was not reproduced.
- **Fix:** Upsert the session row (or a stub) in the same transaction as each events batch, or have the search join sessions. In the client, treat a 404 reached from a search hit as 'still importing' and retry once.
- **Regression test:** ingest test with checkpointEvents > PUT_BATCH: after the first flush, assert every session id seen in search hits has a session row.

### VWR-8: MCP resources/list offset cursor repeats or skips sessions during concurrent ingest

- **Severity:** low; confirmed: yes; status: fixed (keyset cursor; regression tests)
- **Impact:** store() ingests before every read (throttled to 2 s), so a client paging resources/list sees the order shift between pages: a new session repeats an entry, a deleted one skips an entry.
- **Evidence:** mcp/resources.ts:18-34 nextCursor = String(offset + PAGE) over listSessions({parentSessionId:null}) with the same ORDER BY as store/sqlite.ts:547; mcp/server.ts:83-94 ingests before each read. The same drift is reproduced over HTTP by r2-offset-drift.ts.
- **Fix:** Use an opaque keyset cursor (started_at,id) encoded as base64.
- **Regression test:** mcp test: resources/list page 1, upsert a newer session, list with nextCursor, and assert no uri overlap.

