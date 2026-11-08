# coding.sh architecture

coding.sh is an open-source, local-first lab for agent harnesses. The same code also runs as a
server for API apps in production ([Production mode](#production-mode-codingsh-serve)):

```
capture ──▶ spool ──▶ ingest ──▶ store (index + blobs) ──▶ viewer / evals / compare
   ▲                                                           │
   └──────────── runner (replays tasks under a harness) ◀──────┘
```

Status: implemented, pre-1.0. This page started as the design draft. The capture, ingest, store,
viewer and eval sections describe what ships in `packages/coding.sh`; where the code differs from the
draft (for example the exact `IndexStore` methods), the code in `src/core/types.ts` wins. Production
mode, where the same code runs as a server for API apps, is described under
[Production mode](#production-mode-codingsh-serve) and in full in [`docs/PRODUCTION.md`](../PRODUCTION.md).
Agent-specific details live in [`docs/ADAPTERS.md`](../ADAPTERS.md).

## Principles

1. **Never slow the agent down.** A hook appends one line to a local file and exits. It does no network
   calls, runs no daemon, and parses nothing. A daemon would also be killed by the Codex sandbox.
2. **Repo state is first-class.** Every session is anchored to a snapshot of the working tree taken
   before the agent acts. Evals replay from that snapshot, never from the agent's final state.
3. **One open format.** Every agent is normalized into `coding.sh/trace` events. The format is
   OpenTelemetry-aligned and exportable, with no lock-in.
4. **Storage is an interface.** Local SQLite and files are the defaults. Any backend can implement the
   interface.
5. **Grades must be trustworthy.** Deterministic verifiers are preferred and are themselves validated.
   LLM judges are calibrated against human labels before their scores count.
6. **Privacy by default.** Nothing leaves the machine unless a sink is configured. Redaction runs
   before anything is written. A metadata-only mode exists for remote sinks.

## Packages (npm workspaces)

The draft split the core into many packages. It shipped as one package with zero runtime
dependencies; the parts below are folders under `packages/coding.sh/src`.

| Package or folder | Role |
|---|---|
| `packages/coding.sh` | The `coding.sh` CLI (npm). Zero runtime deps, Node 22.15+. |
| `src/schema` | `coding.sh/trace` v0 types |
| `src/spool` | The hook entrypoint: appends stdin to the spool |
| `src/core` | Ingest, normalization, sessions, redaction, repo snapshots, config, storage interfaces |
| `src/store` | Store factory by URL scheme, `sqlite://`, `file://` and `memory://` stores, the conformance suite |
| `src/adapters` | One module per agent: detect, install, normalize, backfill, run |
| `src/otel` | OTLP/HTTP receiver: protobuf and JSON decode, gen_ai / OpenInference / AI SDK mapping |
| `src/server` | `coding.sh serve`: auth, projects, the write queue, metrics, retention, native ingest |
| `src/sinks` | Built-in `otlp` and `http` sinks |
| `src/viewer`, `src/mcp` | The web viewer (`ui`, and `serve`) and the MCP server |
| `src/datasets`, `src/eval`, `src/experiments`, `src/graders`, `src/judge` | Evals, experiments and judges |
| `packages/store-postgres` | `coding.sh-store-postgres`: index and blob store for `postgres://` (depends on `pg`) |
| `packages/blob-s3` | `coding.sh-store-s3`: blob store for `s3://` (S3, R2, MinIO), SigV4 with no SDK |
| `packages/sdk` | `@codingdotsh/sdk`: TypeScript SDK for API apps |
| `packages/sdk-python` | `coding-sh`: Python SDK for API apps |
| `apps/site` | coding.sh website (Astro) |

Drivers with dependencies live in their own packages (`coding.sh-store-<scheme>`,
`coding.sh-sink-<kind>`), so the core install stays dependency-free. None of these packages are on npm
or PyPI yet.

## Capture

### Spool (the hot path)

- The hook command is `~/.coding.sh/bin/csh-hook <agent> <event>`, a plain Node script with no
  imports beyond `node:fs`. Its startup time is the only cost the agent sees.
- It reads stdin and wraps it as `{"v":0,"agent":…,"event":…,"ts":…,"pid":…,"cwd":…,"raw":<stdin>}`.
- It appends that line to `~/.coding.sh/spool/<agent>/<yyyy-mm-dd>.<pid>.jsonl` with one `appendFileSync`
  using `O_APPEND`, which is atomic for writes smaller than `PIPE_BUF`. Large payloads get their own
  file per event.
- It always exits 0. A failure is written to `~/.coding.sh/spool/errors.log`. A capture bug must never
  break the agent.
- On a session-start or prompt event, the hook records the repo root, HEAD commit and branch as the
  line's `git` field. It reads them from `.git` files (`HEAD`, loose refs, `packed-refs`, the
  `gitdir:` and `commondir` files of worktrees and submodules) and never runs git; this takes well
  under a millisecond. A ref it can't read exactly (a reftable repo, a corrupt `HEAD`) leaves the
  field out. `CODING_SH_NO_GIT_HEAD=1` turns it off. Ingest copies it into the `session.start`
  payload as `git.commit` and `git.branch`, and the session's start commit comes from there before
  the reflog. Snapshots run at ingest; see below.

### Repo snapshots

- A shadow repository lives at `~/.coding.sh/repos/<sha256(realpath)>.git`, set up as an alternate of
  the user's object store so objects aren't duplicated.
- Snapshot = `GIT_INDEX_FILE=<tmp> git add -A` + `write-tree` + `commit-tree -p HEAD`, written to the
  shadow repo. This captures staged, unstaged and untracked (non-ignored) files. The user's refs, index
  and stash are never touched.
- Snapshots are taken at session start, at each turn end, and at session end. Agents without hooks get
  the same through `coding.sh run -- <cmd>`.
- Large-repo guard: if the tree is over N files or the snapshot takes more than 2s, fall back to
  HEAD plus a diff of tracked files only, and mark the snapshot `partial`.

### Ingest

- Runs lazily when any CLI command or the viewer starts, plus an optional `coding.sh watch`.
- Reads spool files from the last checkpointed byte offset (stored in the index) and calls the
  adapter's `normalize`. Redaction runs, then a batch write goes to every configured sink.
- At-least-once delivery. Events have deterministic ids (`sha256(agent, session, raw-line)`), so a
  replayed write is a no-op.
- Spool files are deleted once every sink acknowledges them, or kept for N days with `keepSpool`.

## Storage

Two stores with different shapes:

| | Index | Blobs |
|---|---|---|
| Holds | sessions, turns, events, evals, runs, harness bundles, labels | transcripts, tool results, file contents, diffs, raw API bodies |
| Shape | small rows, queried and filtered | large, immutable, write-once |
| Key | ids | `sha256` of uncompressed content |
| Default | SQLite (`node:sqlite`, WAL, FTS5) | `~/.coding.sh/blobs/ab/cd/<sha256>.zst` |

### Interfaces

```ts
interface IndexStore {
  putEvents(batch: AgentEvent[]): Promise<void>;          // idempotent on event.id
  upsertSession(s: SessionRow): Promise<void>;
  query<T>(q: Query): AsyncIterable<T>;                   // typed query DSL, not raw SQL
  search(text: string, opts?: SearchOpts): AsyncIterable<EventHit>;
  getCursor(source: string): Promise<number>;
  setCursor(source: string, offset: number): Promise<void>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

interface BlobStore {
  put(data: Uint8Array | ReadableStream, meta?: BlobMeta): Promise<BlobRef>; // dedupes by hash
  get(ref: BlobRef): Promise<ReadableStream>;
  has(refs: BlobRef[]): Promise<boolean[]>;               // batch existence check before upload
  delete?(ref: BlobRef): Promise<void>;                   // GC only
}

interface Sink {                                          // write-only mirror (OTLP, HTTP, …)
  name: string;
  mode: "full" | "metadata";
  write(batch: AgentEvent[], blobs: BlobResolver): Promise<Ack>;
}
```

- Config lives in `~/.coding.sh/config.toml`, overridable per repo in `.coding.sh/config.toml`.
  Stores are chosen by URL scheme (`sqlite://`, `postgres://`, `file://`, `s3://`). Third-party stores
  are npm packages that export a factory for a new scheme.
- Writes fan out: one primary `IndexStore` and `BlobStore` serve reads, plus N write-only `Sink`s.
  Each sink keeps its own cursor and retries with backoff, so an offline remote never blocks local
  capture.

### Efficiency

- Events hold structured fields in columns (`session_id`, `kind`, `ts`, `tool`, `status`, `cost`, …)
  with a small JSON `payload`. Anything over 4 KB becomes a blob ref. This keeps the index small
  enough to scan.
- Blobs are content-addressed, so a file read 50 times, or the same CLAUDE.md in 1,000 sessions, is
  stored once. They are compressed with zstd (`node:zlib`) at level 3 for writes and level 19 for
  `coding.sh gc --compact`.
- Raw spool lines are not kept after normalization. The adapter's raw payload is kept as a blob for
  re-normalization when the schema version changes.
- `coding.sh gc`: mark-and-sweep of unreferenced blobs, plus retention rules (for example, drop
  file-read blobs older than 90 days while keeping diffs and eval tasks).
- SQLite settings: `journal_mode=WAL`, `synchronous=NORMAL`, batched transactions of about 500
  events, prepared statements, FTS5 over prompt and assistant text only.

## Production mode (`coding.sh serve`)

The same core runs as a long-lived server for API apps and agents in production. The full contract,
including routes, env vars, auth and limits, is [`docs/PRODUCTION.md`](../PRODUCTION.md). Deploy
recipes are in [`docs/production/`](../production/README.md).

```
 API apps ──SDK (TS / Python)──▶ POST /v1/ingest ─┐
 OTel apps, AI SDK, Gateway ──▶ POST /v1/traces    ├─▶ bounded queue ─▶ writer ─▶ IndexStore (sqlite | postgres)
                                POST /v1/logs     ─┘   429 when full    1 tx/tick   BlobStore  (file | postgres | s3)
 people ─▶ /  /api/*  (viewer)     ops ─▶ /healthz /readyz /metrics      CLI + MCP ─▶ same store URL
```

- **One process, one port.** `coding.sh serve` (default port 4318) takes OTLP/HTTP and native SDK
  batches, and serves the viewer, its API and Prometheus metrics. It is configured by a store URL:
  `CODING_SH_STORE_URL` (`sqlite://` or `postgres://`) and optionally `CODING_SH_BLOB_URL`
  (`file://`, `postgres://` or `s3://`). With a Postgres index, blobs default to the same database.
- **Same code path as local mode.** Requests go through the `src/otel` decoders and mappers and the
  same redaction and `buildSession` used by hooks and the collector. Local mode (`ui`, `collector`,
  hooks, `~/.coding.sh`) is unchanged.
- **Ack after commit.** A request gets 200 only after its events are committed. A full queue answers
  429 with `Retry-After`. Event ids are deterministic or client-supplied and `putEvents` is
  idempotent, so retries never duplicate.
- **One writer.** The writing replica holds `IndexStore.acquireWriterLock` (a session advisory lock on
  Postgres, a lock file next to the SQLite database). `/readyz` stays 503 until it has the lock. Read-only replicas run
  `--role viewer`.
- **Projects and keys.** Ingest keys (`csh_ik_…`) decide the project, and read keys (`csh_rk_…`) or
  basic auth open the viewer. Session ids are stored as `<project>/<sessionId>`. Serve refuses a
  public bind without keys unless `--insecure` is set.
- **Same tools on top.** `sessions`, `show`, `search`, `mcp`, `dataset` and `exp` take `--store`
  (or `CODING_SH_STORE_URL`) and work on the production database.

## Trace format (`coding.sh/trace` v0)

```ts
type AgentEvent = {
  id: string;                 // deterministic sha256
  v: 0;
  sessionId: string;
  turnId?: string;
  parentId?: string;          // subagents, nested tools
  ts: number;                 // ms epoch
  agent: string;              // "claude-code" | "codex" | "opencode" | …
  agentVersion?: string;
  model?: string;
  kind:
    | "session.start" | "session.end"
    | "user.message" | "assistant.message"
    | "tool.start" | "tool.end"
    | "context.compact" | "turn.end"
    | "subagent.start" | "subagent.end"
    | "file.change" | "test.result";
  repo?: { root: string; head: string; snapshot?: string };
  payload: Record<string, unknown>;
  blobs?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; cacheRead?: number; costUsd?: number };
};
```

The OTel export maps a session to `invoke_agent`, a model call to `chat`, a tool to `execute_tool`,
and uses `gen_ai.*` attributes. GenAI semconv is still "Development" status, so the mapping is pinned
to a semconv version.

## Evals

- **Task** = pre-agent snapshot ref + instruction + setup commands + env + verifier + metadata
  (source session, created by, tags). Stored in the index, with files as blobs. Exportable to
  Harbor task format.
- **Verifier validation:** before a task is saved, all of these must hold:
  1. The no-op attempt fails.
  2. The reference solution passes k/k.
  3. Generated near-misses fail.
  4. No leakage: no future commits, no final diff, and tests are hidden from the agent.

  Tasks that fail validation are kept as drafts.
- **Graders:** deterministic first (tests, typecheck, lint, file assertions). LLM judges are optional,
  and each judge is versioned (prompt + model + rubric hash).
- **Judge calibration:** humans label sessions in the viewer. Each judge version reports agreement
  and Cohen's κ against those labels on a held-out split it was not tuned on. One rule applies
  everywhere (`src/judge/calibrate.ts`; `src/eval/judge.ts` delegates to it): κ ≥ 0.6 on at least
  20 held-out cases with both a human label and a verdict. κ measured on a split in `tunedOn` is
  reported as in-sample, never as calibrated. Below threshold, its scores are flagged in every report.

## Runner and harness lab

- **Harness bundle:** `harness.toml` + overlay files (CLAUDE.md, AGENTS.md, skills, hooks, MCP config,
  CLI flags, model, env), plus Claude Code plugins for claude-code (stored whole, loaded with
  `--plugin-dir` from the run's home). Its content hash is its identity. `coding.sh harness snapshot`
  captures the current setup.
- **Run:**
  1. Create a git worktree from the task snapshot in `~/.coding.sh/runs/<id>`.
  2. Apply the bundle overlay. Where the agent supports it, use an isolated config dir, never the
     user's global config.
  3. Run the adapter's headless command with a timeout and `CODING_SH_RUN_ID`.
  4. Capture through the normal hooks, then run the verifier.
  5. Record pass/fail, cost, tokens, turns and wall time.
- **Compare:** paired by task, k runs per arm. Reports pass rate with a Wilson interval, a paired
  bootstrap CI on the difference, cost/turn/time deltas, and the first trace step where the two arms
  diverge.
- **Isolation:** local worktrees first. A Docker runner comes later through the same `Runner` interface.

## Adapter contract

```ts
interface Adapter {
  id: string;                                   // "claude-code"
  detect(): Promise<{ installed: boolean; version?: string; configDir?: string }>;
  install(opts: InstallOpts): Promise<Change[]>;  // returns exact file edits, supports --dry-run
  uninstall(): Promise<Change[]>;
  normalize(raw: SpoolLine): AgentEvent[];      // pure, fixture-tested
  backfill?(since?: Date): AsyncIterable<AgentEvent>;  // import local transcripts
  run?(task: RunSpec): Promise<RunResult>;      // headless driver
  overlay?(bundle: HarnessBundle, dir: string): Promise<RunEnv>;
}
```

`install` never rewrites user config wholesale. It merges, keeps a backup, and is idempotent.
`coding.sh doctor` checks every detected agent: hooks present, last heartbeat, and spool writable.

### Conformance suite

Each adapter ships recorded fixtures (raw hook payloads and transcripts) for each supported agent
version, plus golden normalized events. CI runs `normalize` against the fixtures, and a nightly job
installs the latest version of each agent and runs a scripted session. That way, format drift is
caught before users hit it.
