# Viewer design: sessions, query, benches

Status: design, 2026-11-06. Build order: V-1…V-13 in tasks/research-queue.md, "Round 2 additions (viewer)".
Scope: `coding.sh ui` (packages/coding.sh/src/viewer). The site sample (apps/site Viewer.astro) mirrors it.

**Decisions**

1. **One query language** (viewer bar, `sessions --where`, MCP `search`/`facets`), run at two levels: sessions, or
   events/spans across sessions. Facets, saved views and Explore are all just that string.
2. **Turn-first session page**: turn rail · span tree of the selected turn · inspector. Waterfall is a per-turn toggle,
   never a session-wide chart. Quiet tool runs fold; failures never fold.
3. **Nothing loads a whole session**: a `turns` outline drives the page, rows come per turn as ~120 B summaries,
   payloads and blobs load on selection.
4. **Benches: verdict first, regressions next.** The viewer never computes stats; it renders the `Verdict` document
   `bench compare --json` prints, including the identical one-line string.
5. **Queries never wait on ingest**: ingest moves to a worker with its own writer; reads use a read-only WAL connection.

Real store (~/.coding.sh, opened immutable): 3,647 sessions (1,360 subagent children), 1.37M events. Largest: one
Codex session, 154,773 events, 117 prompts, 47 turns, 59,387 tool calls, 227 compactions; 51 sessions > 5k events.
`repo_root` NULL on all sessions (X-4), `cwd` on 3,147 (706 dirs); `costUsd` NULL everywhere (C-1); `endedAt` NULL on
3,593. Flags: compaction 426, no-verification 299, premature-completion 22, repeated-tool-failure 15. turnId on
96–100% of claude-code/codex events, 0% of antigravity/cursor. No `runs` or `experiments` rows yet.

## 1. Patterns we take

| pattern | seen in | we use it for |
|---|---|---|
| Tree ⇄ timeline toggle over the same rows and metrics | Langfuse https://langfuse.com/changelog/2025-03-19-new-trace-view.md | Tree / Waterfall modes (§6) |
| "Transcript" default that hides wrapper spans; subagents as collapsed cards; virtualized tree; drag-to-zoom timeline | Laminar https://laminar.sh/docs/platform/viewing-traces | span model, wrapper handling, virtual list |
| Aggregated graph folds repeated calls into one node with a counter | Langfuse https://langfuse.com/docs/observability/features/agent-graphs | quiet-run folding (`Read×830`) |
| One scrollable log of the whole trace, Cmd+F across it | Langfuse https://langfuse.com/changelog/2025-11-05-langfuse-for-agents.md | Chat mode + server-side find |
| Table peek: side preview, J/K between rows | Langfuse https://langfuse.com/changelog/2025-03-21-table-peek-view.md, Phoenix https://arize.com/docs/phoenix/release-notes/10.2025/10.13.2025-view-traces-in-compare-experiments | inspector, j/k everywhere |
| Less-style transcript keys, `{`/`}` between prompts, render only visible messages, "Conversation compacted" stop row | Claude Code https://code.claude.com/docs/en/fullscreen.md, https://code.claude.com/docs/en/interactive-mode.md | key map, compaction divider, virtualization |
| `/` opens a WHERE-style query with autocomplete; span-count histogram above the list marks the shown range | Logfire https://pydantic.dev/docs/logfire/observe/live/ | query bar, Explore brushing |
| Baseline + green/red deltas for score, cost, latency per row | Langfuse https://langfuse.com/docs/evaluation/experiments/compare-experiments, Braintrust https://www.braintrust.dev/docs/evaluate/compare-experiments | verdict table columns |
| Sort by regressions, filter regressed/improved, header counts of better/worse | Braintrust (above), LangSmith https://docs.langchain.com/langsmith/compare-experiment-results | regressions-first, status chips |
| Display modes Failures / Errors / **Different**; filter state in the URL | promptfoo https://www.promptfoo.dev/docs/usage/web-ui/ | status chips, URL state |
| "Diff only" toggle, warnings on mismatched datasets/scorers | Weave https://docs.coreweave.com/weave/guides/evaluation/compare_evals | instrument warnings above the table |
| Score filter + sort to group one sample across epochs; HTTP range reads of logs | Inspect https://inspect.aisi.org.uk/log-viewer.html | attempt dots, blob range loads |
| Judge labels cite clickable spots in the transcript | Docent https://docs.transluce.org/legacy/search-and-clustering.md | every verdict/flag links to an eventId |

Gap we fill: none of these documents CIs or p-values; they show raw deltas. We show the paired stats we already
compute, in plain words, with the method on hover. We also keep instrument errors apart from agent failures.

## 2. Information architecture

Nav: **Sessions · Explore · Benches · Queues**, then ⌘K, ingest pill, update pill. Hash routes; all state is in the
URL, so every link is shareable locally.

| route | page |
|---|---|
| `#/sessions?q=…&view=…&sort=…&cols=…` | session list + facets + saved views (default) |
| `#/events?q=…` | event/span results across sessions (same query, event level) |
| `#/s/:id[/:eventId]?turn=&mode=tree\|waterfall\|files\|chat` | session detail |
| `#/s/:id/vs/:otherId` | side-by-side trajectories (any two sessions) |
| `#/explore?q=…&measure=…&by=…&per=day` | metrics: time series, brush, breakdown |
| `#/benches`, `#/benches/:bench`, `#/runs/:run` | bench list, run history, one run's tasks |
| `#/verdict/:a..:b`, `#/verdict/:r1,:r2,:r3` | verdict; matrix |
| `#/queues[/:id]` | annotation queues (C-9) |

⌘K palette: session id/title, saved views, commands ("copy eval command", "compare with…"). `g s/e/b/q` switch
sections; `?` lists keys.

## 3. Query language and filter model

```
query   := clause ( [ "OR" ] clause )*      # adjacent = AND; uppercase OR; ( ) groups
clause  := [ "-" ] ( key op value | "has:" field | "is:" state | text )
op      := ":" | ">" | ">=" | "<" | "<="     # key:a..b is an inclusive range
value   := word | "quoted" | a,b,c          # comma = OR within a key; * = prefix glob
text    := word | "phrase"                   # bare words → FTS5 over prompts, replies, tool I/O
```

- `agent:codex model:claude-sonnet-5-5 project:rodev status:failed flag:premature-completion cost>0.5 duration>10m since:7d "migration"`
- `kind:tool tool:Bash ok:false since:24h`: event level, every failed Bash call
- `-agent:antigravity has:compaction turns>=20 (flag:no-verification OR tests.failed>0)`

Time: `since:7d`, `until:2026-11-01`, `at:2026-11-01..2026-11-03` (units `s m h d w`). `sort:-cost` and `limit:`
are keys, so a saved view is one string. Keys are an allowlist; values are bound parameters; an unknown key fails
with the closest match.

| level | keys |
|---|---|
| session | `agent model project dir branch status flag label.<criterion> score.<name> tag run bench task parent is:root is:child is:running since until duration turns tools tool.errors tokens cost cache.hit subagents compactions tests.failed` |
| event | `kind tool ok mcp subagent.type file event.duration ttft tokens.in tokens.out event.cost error.class` + text |
| has: | `subagents compaction tests diff error label blob` |

- `status` is derived at upsert: `failed` = detector flag, failed tests, "fail" label or errored; `passed` = passing
  tests or "pass" label; else `running` / `unknown`.
- `project` = repo basename, else `cwd` basename (today always cwd). `duration` = `(endedAt ?? lastEventTs) − startedAt`.
- `tools` and `tool:` count leaf calls; Codex code-mode wrappers count once (RT-1).

**Two levels, one string.** The result tab picks the level. Sessions tab: event clauses become `EXISTS(events…)`
("sessions with a failed Bash call"). Events tab: session clauses become a join filter; rows are spans (tool call,
llm.call, subagent, error, compaction) with session title, turn, duration and clipped arg/error. Enter opens
`#/s/:id/:eventId` centered; `n`/`N` steps to the next match inside the session.

**Autocomplete.** `GET /api/facets?q=<query minus the edited term>&key=tool&prefix=Ba&level=session` → top 20
`{value, count}`. A key's own clause is excluded when counting it (multi-select semantics). Keys come from the table,
values from the index. Typed terms become chips; Backspace on empty input edits the last chip; Tab completes.

**One implementation.** `src/query`: `parse(q) → AST` (errors carry `{offset, reason, next}`), `compile(ast, level) →
{sql, params}` for sqlite, `matches(ast, row)` scan fallback for other stores and tests. It also owns the key docs
used by `--help --json` and the MCP `where` description, so a new key appears on all surfaces at once.

## 4. Session list

```
coding.sh   Sessions  Explore  Benches  Queues                          ⌘K   ● ingesting 12 files
┌─────────────────┬──────────────────────────────────────────────────────────────────────────────┐
│ VIEWS           │ [agent:codex ×] [status:failed ×] since:7d migration▏         Sessions│Events │
│ Failures 24h  14│ 214 sessions · 3.1M tokens · 41 flagged             sort: started ▾  cols ▾  │
│ Most expensive  │──────────────────────────────────────────────────────────────────────────────│
│ Slowest tools   │ ● TITLE                        AGENT·MODEL     PROJECT  TURNS TOOLS  TOK  DUR  │
│ Subagent-heavy  │ ✗ Fix flaky orders retry test  codex·sol       rodev      12  412·3 1.2M 41m │
│ + save view     │ ✗ Port auth to new SDK  ⚑prem  claude·opus     api         4   88·0 310k  9m │
│ AGENT           │ ● Add retry with backoff       claude·opus     api         2   31·0  90k  4m │
│ ☑ codex   1,488 │   └ 3 subagents · explorer×2 worker                                          │
│ ☐ claude  1,659 │ …                                                              (virtualized) │
│ FLAG            │──────────────────────────────────────────────────────────────────────────────│
│ ☐ compaction 426│ j/k move · Enter open · x select · / query · f facets · v views · c compare  │
└─────────────────┴──────────────────────────────────────────────────────────────────────────────┘
```

**Facets**: agent, model, project, dir, branch, status, flag, tool, mcp, subagent.type, run/bench, label.*, score.*,
tag, has:*. Top 8 values with counts plus "more…" (searchable). Click toggles, ⌥-click excludes (`-key:v`). Every
toggle edits the query string; bar and sidebar are two views of one state. `f` focuses the sidebar, Space toggles.

**Columns** (default): status dot (✗ failed, ✓ passed, ● unknown, pulsing = running) · title (first prompt, inline
flag chips, detector on hover) · agent·model · project · turns · tools `calls·errors` · tokens · cost (hidden while
all NULL) · duration · started (relative, absolute on hover). Opt-in: branch, subagents, compactions, cache hit,
llm p95, ttft p50, run, labels. Tabular right-aligned numbers, compact units, one 32 px line per row.

Children are hidden by default (`is:root`); a parent shows a quiet `└ N subagents · types` line that expands inline.
`x` multi-selects; with two selected, `c` opens `#/s/a/vs/b`.

**Saved views** `{name, q, sort, cols, level}` live in kv (`view:<slug>`), addressable as `?view=slug`. Shipped
defaults (read-only, duplicable):

| view | query |
|---|---|
| Failures last 24h | `status:failed since:24h is:root` |
| Most expensive | `since:7d sort:-cost` (falls back to `sort:-tokens` while cost is NULL) |
| Slowest tools | Events: `kind:tool since:7d sort:-event.duration` |
| Subagent-heavy | `subagents>=5 sort:-subagents` |
| Compacted | `has:compaction sort:-compactions` |
| Instrument errors | `flag:instrument-error` (X-19/20/21), kept apart from agent failures |
| Bench sessions | `run:*` (organic: `-run:*`) |

## 5. Explore (metrics)

Supersedes the C-6 UI; keeps C-6's `computeMetrics` as the engine.

```
Explore  [agent:codex ×] since:30d▏               measure [p95 llm ▾]  by [model ▾]  per [day ▾]
┌ sessions ─────────────────────────────┐┌ failure rate ──────────┐┌ p95 llm latency ───────┐
│ ▁▂▅▇▃▂▁▁▃▅▇█▅▃▂▁   ├──brush──┤        ││  ▁▁▂▁▃▁▁▂▅▂            ││  ▃▃▄▃▅▃▃▃▆▃            │
└───────────────────────────────────────┘└────────────────────────┘└────────────────────────┘
┌ tokens in/out/cache ──────────────────┐┌ tool error rate ───────┐┌ cost per session ──────┐
BY MODEL        SESSIONS  FAIL%  P50 LLM  P95 LLM  TTFT  TOKENS  CACHE HIT  TOOL ERR%  COST
gpt-6.1-sol        1,317   12%     3.1s     14s   0.9s   410M       88%       2.1%     —    →
claude-opus-5-5    1,473    9%     4.0s     19s   1.2s   380M       91%       1.4%     —    →
```

- Six fixed small multiples in plain SVG. `by` splits each into ≤6 series plus "other".
- Dragging on any panel writes `since:`/`until:` into the shared bar, so panels, table and Sessions refilter. Esc clears.
- Table rows link to `#/sessions?q=<q> model:<v>`; a cell opens the matching events (e.g. that model's tool errors).
- Group by agent, model, project, tool, mcp, subagent.type, flag, day/week (tool and mcp group at event level).

## 6. Session detail

```
← Sessions / codex · 01a10d37   Fix flaky orders retry test            ⌘K   [c] compare  [e] eval
rodev · gpt-6.1-sol · 47 turns · 59,387 tools (412 ✗) · 6h12m · 31.1M tok · ⚑ compaction ×227
┌─ TURNS ─── ✗14 ┬─ T12 "now run the migration again" · 18m · 2,140 tools · 3 ✗ ─┬─ INSPECTOR ─────────┐
│▁▃▅█▂▁▁▇▁▂▁▃ map │ [Tree] Waterfall  Files 6  Chat          / find in session    │ Bash  ✗ exit 2  1.8s│
│ T1 set up    2m │ ▸ model  gpt-6.1-sol  "I'll check the…"  41k→312  2.1s        │ $ npm run migrate   │
│ T2 retry   9m ✗ │ ▾ exec  code cell ✗  3 calls                      4.0s        │ ── output 182 KB ── │
│ T3 tests  31m   │   ├ Bash  npm test                    ✓           1.2s        │ Error: relation "us…│
│  ┄ compacted ┄  │   └ Bash  npm run migrate             ✗ exit 2    1.8s        │ … 4,211 lines       │
│▶T12 migrate 18m✗│ ┄┄ context compacted · auto · 182k → 31k ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │ [more] [all] [raw]  │
│ T13 fix up  6m  │ ▸ subagent  explorer  "find migration files"  41 ev  52s ✓  ↗ │ Input Output Raw    │
│ …               │ ▸ 1,204 quiet calls  Read×830 Bash×301 Grep×73       [expand] │ Usage  Context      │
│                 │ ▸ model  "Fixed. The migration now…"  88k→1.1k  6.4s          │ ↳ turn 12 · #431    │
└─────────────────┴───────────────────────────────────────────────────────────────┴─────────────────────┘
 ]/[ next/prev failure · j/k step · J/K turn · Enter expand · w waterfall · / find · y copy link · ? keys
```

`✗14` opens the failure jump list, grouped by kind (tool error, failed test, error event, detector anchor).

**Turn/span model** (`src/viewer/model.ts`, shared with `coding.sh show`): `Session → Turn[] → Node[]`.

- **Turn** = a `turnId`; without one (antigravity, cursor), user.message to next user.message. Synthetic prompts
  (RT-3) render dim and do not start a turn. A turn row: prompt, duration, tools, errors, files, tokens, compactions.
- **Nodes:**

| node | from | renders |
|---|---|---|
| `model` | `llm.call` merged with the adjacent `assistant.message` it produced | text preview, tokens in→out, TTFT, duration, stop reason |
| `tool` | `tool.start`/`tool.end` paired by `toolUseId` | name, primary arg, ok/exit code, duration |
| `wrapper` | Codex code-mode `exec` (`payload.wrapper`, RT-1); children via `parentId` | auto-expanded when an inner call failed |
| `subagent` | `subagent.start…end` by `subagentId` | collapsed card; inline children, or lazy child outline + "open ↗" via `childSessionId` |
| `compaction` | `context.compact` | full-width divider: trigger, tokensBefore → after |
| `file` / `test` | `file.change` / `test.result` | badge on the producing tool node, else own row |
| `error` / `notification` | same kinds | red row / quiet row |

- **Quiet folding**: ≥6 consecutive successful tool nodes in a turn fold into one row with per-tool counts. Failures,
  edits and test runs split a fold, so they are always visible.
- **Waterfall (`w`)**: same rows plus a time track scaled to the *selected turn*; model rows shade TTFT; parallel
  calls overlap. Session scale lives in the **minimap**: one strip of turn segments shaded by error density, with
  compaction ticks; click or drag jumps.
- **Files**: the turn's `file.change` list with +/−; diffs from blobs, or snapshot diff at turn boundaries when
  `repo.snapshot` exists. `F` = all files in the session with the turns that touched them.
- **Chat**: prompts and replies only, for reading.

**Long outputs.** The inspector first shows the clipped payload (< 4 KB). Full blobs load via
`/api/blobs/:ref?range=0-65535`, "more" in 64 KB steps to 2 MB, then "raw" (sandboxed text/plain tab, as today).
More than 2k lines → virtualized line list with gutter; ANSI stripped; JSON pretty on demand; diffs colored; base64
images (RT-6) as a size placeholder, never inline.

**Keyboard**

| key | action | key | action |
|---|---|---|---|
| `j` `k` | next / prev row | `J` `K` (`}` `{`) | next / prev turn |
| `]` `[` | next / prev failure | `Enter` `→` `←` | expand · collapse |
| `o` | open subagent child | `t` `w` `F` `m` | tree · waterfall · files · chat |
| `/` | find in session | `n` `N` | next / prev match |
| `i` | focus inspector | `1`–`4` | inspector tabs |
| `y` / `Y` | copy row link / row JSON | `e` | copy `coding.sh eval new <id>` |
| `p` `f` | label pass / fail | `c` / `Esc` | compare with… / close or back |

Every key has a visible control. One roving-tabindex ARIA tree; a polite live region announces turn and row.

**Performance for 5k–150k events**

- `GET /api/sessions/:id/outline` reads the `turns` table (kept at ingest): turn summaries, failure anchors,
  compaction marks, minimap buckets. ~10 KB for the 154k-event session; < 30 ms.
- `GET /api/sessions/:id/rows?turn=12&after=<ts,id>&limit=2000` → `RowSummary {id, kind, ts, dur, parentId, label,
  ok, tokens, cost, foldKey}` (~120 B). `/events/:eventId` on selection, blobs on inspector open.
- Fixed 28 px rows, viewport + 40 overscan (< 150 DOM rows); the tree is a flat array, expand/collapse splices it.
- Find = FTS restricted to `session_id` on the server; ids map to turns, so matches in unloaded turns count.
- Prefetch ±1 turn on idle; LRU of 20 turns. Budget: header+outline < 300 ms, turn switch < 100 ms, < 150 MB.

## 7. Benches

Nouns from docs/design/bench-cli.md: **bench** (tasks + grading), **run** (one setup over a bench), **verdict** (B vs A),
**matrix** (≥3 runs). "Experiment", "bundle" and "arm" stay internal.

```
Benches                                                      [bench:* since:30d ×]▏
BENCH           TASKS  RUNS  LAST VERDICT                                        UPDATED
my-failures        24     6  better +21 pp · 0 regressions · cost −7%            2h ago
coding-sh-cli      18     3  not enough data · needs ~60 tasks to see 10 pp      1d ago
── my-failures ─────────────────────────────────────────────────────────────────────────
RUN      SETUP                          PASS        Δ PREV    COST   P95    WHEN
r_8c1    claude-code · AGENTS.md v3     20/24 83%   +21 pp ✓  $1.71  38s    2h   [verdict]
r_77a    claude-code · baseline         15/24 62%   −4 pp     $1.84  41s    1d
         pass rate over runs ▁▃▂▅▇   (auto delta vs previous run and notes: X-12)
```

**Verdict page**

```
my-failures · baseline r_77a → candidate r_8c1 · 24 tasks · k=3                 [m] matrix  [s] swap
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ BETTER  +21 pp   candidate solved 20/24, baseline 15/24                                      │
│ Likely real: plausible range +8 to +33 pp. Chance this is noise: 0.4%.                       │
│ 0 regressions · 5 improved · 1 flaky · cost −7% ($1.84 → $1.71) · p95 41s → 38s              │
│ ⚠ 1 attempt edited tests (tamper) · 2 attempts errored (excluded, not counted as fails)      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
[Regressed 0] [Improved 5] [Flaky 1] [Errored 2] [Same 16]                 q: tag:auth▏
  TASK                       BASELINE    CANDIDATE   Δ      COST          P95 TIME     TOKENS
✗ orders-retry-backoff       ●●● 3/3     ○○○ 0/3     −100   $.08→$.11 ↑   38s→71s ↑    90k→140k
✓ migrate-users-table        ○○○ 0/3     ●●● 3/3     +100   $.12→$.09     52s→44s      …
~ flaky-ws-reconnect         ●●○ 2/3     ●○○ 1/3      −33   …
· parse-config               ●●● 3/3     ●●● 3/3        0   …                         (dim)
```

- Verdict word first: `better`, `worse`, `no change`, `inconclusive`, `not enough data`. Plain-words line under it;
  hovering a number names the method (paired bootstrap CI, McNemar exact p, Holm for matrices, MDE).
- Instrument problems (X-19/20/21: errored attempts, ungraded cases, verifier drift, tamper) are warnings above the
  table, never folded into pass rates.
- Order: regressed, improved, flaky, errored, unpaired, then same (dimmed); within a group by |Δ|, then cost Δ.
- One dot per attempt (● pass ○ fail ◌ errored); a dot opens that attempt's session. Enter on a row opens the
  trajectory compare for the first differing pair. Cost/time/token arrows only when the change exceeds 10%.
- Underpowered: one line ("needs ~60 tasks to see a 10 pp change") and the rows still show.

**Matrix (≥3 runs)**

```
                 baseline     +AGENTS v3    opus         codex·sol
                 15/24 62%    20/24 +21pp✓  18/24 +12pp  14/24 −4pp     ✓ = Holm-adjusted CI excludes 0
orders-retry     ●●●          ○○○ ▼         ●●●          ●●○
migrate-users    ○○○          ●●● ▲         ●●○ ▲        ○○○
```

Columns are runs (first = baseline, headers show Δ vs baseline); rows sort by disagreement across columns. `←→`
picks two columns, Enter opens their verdict; a cell opens its attempts.

**Trajectory compare `#/s/:a/vs/:b`**

```
baseline · attempt 1 · ✓ 38s $0.08            │ candidate · attempt 1 · ✗ 71s $0.11
T1  Read   src/orders/client.ts               │ T1  Read   src/orders/client.ts
    Edit   client.ts  +12 −3                  │     Edit   client.ts  +40 −2               ≠
    Bash   npm test   ✓ 12 passed             │ ▶   Bash   npm test   ✗ 2 failed            first divergence
                                              │     Edit   test/orders.test.ts  ⚠ tamper
──────── final patch: 1 file +12 −3 ──────────┼──────── final patch: 2 files +52 −2 ─────────
```

Steps align by LCS over signatures (tool + normalized primary arg); first divergence marked, `d` jumps to the next;
panes scroll in sync per aligned block; final patches (`RunResult.diffBlob`) side by side. Works for any two
sessions; X-1 next-turn replay reuses it (original vs replayed continuation).

## 8. One data model, one set of names

| concept | CLI | viewer | HTTP | MCP | JSON |
|---|---|---|---|---|---|
| query | `sessions --where q`, `events --where q` | query bar | `POST /api/query {q, level, sort, cursor}` | `search {where, level}` | `SessionRow`, `EventRow` |
| facets | `sessions facets --where q` | sidebar, autocomplete | `GET /api/facets` | `facets` | `FacetCount[]` |
| session | `show <id>` | `#/s/:id` | `/api/sessions/:id/outline\|rows` | `session_get` | `Session`, `Outline`, `RowSummary` |
| metrics | `stats --measure --by` | `#/explore` | `GET /api/metrics` | `metrics` (subsumes `usage`, `latency`) | `MetricSeries` |
| run | `bench run`, `bench show <run>` | `#/runs/:id` | `/api/runs/:id` | `bench_run_get` | `BenchRun` |
| verdict | `bench compare a b` | `#/verdict/a..b` | `/api/verdict?a&b` | `bench_compare` (alias `experiment_compare`) | `Verdict` |

`src/experiments/verdict.ts` owns it: `buildVerdict(a: BenchRun, b: BenchRun)`. `BenchRun` adapts both stored shapes,
`RunResult[]` (task × bundle × attempt; one attempt → one `CaseRun`) and `ExperimentResult` (case × trial), and the
math is the existing `compareExperiments` + `pairedPower` + Holm (R2-3) + tamper reports. Shape: `{verdict, line, a,
b, delta:{pp, lo, hi, p}, tasks: TaskDelta[], cost, latency, tokens, power, warnings[]}`; `TaskDelta.status` ∈
`regressed improved flaky errored same-pass same-fail unpaired`, with attempt `sessionId`s per side. `line` =
`verdictLine(v)`, the exact CLI string; a golden test asserts CLI stdout, `/api/verdict` and MCP carry it
byte-identical. Status words and order live in `verdict.ts`; the viewer only renders them.

## 9. Performance on the real store

Measured on the real index (1.88 GB, immutable read-only):

| query | today | cause |
|---|---|---|
| session facet with `json_extract(stats)`, 3,647 rows | 10 ms | small table; fine |
| FTS `migration` | 10 ms | fine |
| `kind='tool.end' AND ok=0 GROUP BY tool` | 2.1 s cold, 0.42 s warm | `events_kind`, then a row lookup per event |
| MCP-server facet via `json_extract(payload)` | 3.2 s | payload parse over 465k rows |
| `llm.call` with `inputTokens > 100k` | 2.0 s | `json_extract(usage)` scan |

Target: every facet/autocomplete call < 100 ms warm, < 300 ms cold.

1. **sessions**: promote `model, project, branch, last_ts, duration_ms, turns, tool_calls, tool_errors, tokens_in,
   tokens_out, cache_read, cost_usd, subagents, compactions, status` to columns (migration + backfill from `stats`).
   Index `(status, started_at)`, `(project, started_at)`; at 3.6k rows indexes serve sort keys only.
2. **session_facets(key, value, session_id)**, `WITHOUT ROWID`, PK in that order: flags, tools and MCP servers used,
   subagent types, models, labels, tags, has:*; rewritten on upsert. Counts: `WHERE key=? AND session_id IN
   temp_match GROUP BY value` (~5 ms). Replaces `json_each(flags)` (store/sqlite.ts:453).
3. **events**: generated stored columns `mcp_server, tokens_in, cost_usd, is_error`; covering
   `events_facet(kind, tool, ok, ts, session_id)` and `events_dur(kind, duration_ms)`. Event-level queries are always
   bounded (Events tab defaults to `since:7d`, or a session set), keyset-paged on `(ts DESC, id)`; counts > 10k show
   `10k+` instead of an exact `count(*)`.
4. **turns(session_id, idx, turn_id, started_at, ended_at, prompt, events, tools, tool_errors, llm_calls, tokens_in,
   tokens_out, files, compactions, first_error_id)**, maintained by buildSession, backfilled for existing sessions.
5. **CI guard**: `EXPLAIN QUERY PLAN` for every event-level key; fail on `SCAN events`.

**Ingest must not block queries (landed, V-1).** `ui` used to await `autoIngest` before listening (the 21 s blank
start), then re-ingested every 3 s on the synchronous `DatabaseSync` that served requests. Now it listens first and
ingests every 3 s in a `worker_threads` worker (cli/ingest-worker.ts) with its own connection, so the request thread
only reads and WAL lets those reads run during the worker's writes. `GET /api/ingest` → `{ingesting, filesPending,
lastIngestAt}` drives the "Indexing N files…" pill. CLI reads (`status`, `sessions`, `search`) ingest within a
1.5 s budget (`ingest({deadline})` stops at the next checkpoint, cursors on what was stored), answer from the store,
start a background `ingest`, and print `N files not yet ingested` to stderr; `--fresh` waits.

**Indexed filter keys (landed, V-2).** Migration v8 adds `events.mcp` (a tool call's MCP server, from `payload.server`) and replaces `events_kind`/`events_tool` with `events_kind_ts(kind, ts, session_id)`,
`events_tool_ok(tool, ok, ts, session_id)`, `events_ok(ok, ts, session_id)`, `events_mcp(mcp, ts, session_id)` and
`events_ts(ts)`. `session_facets(key, value, session_id)` (`WITHOUT ROWID`) holds each session's tools, MCP servers
and kinds, written with its events and backfilled by the migration, so event-key facets count sessions without
touching `events`. A session-level event clause is one non-correlated `s.id IN (SELECT e.session_id …)`; the Events
API pages on `(ts DESC, rowid DESC)` and counts up to 10k on the first page only. Session columns were not
promoted: session-key queries already answer in ~4 ms at 3.6k sessions. `test/query/where.test.ts` fails on
`SCAN e` for any indexed key. Measured on the desk against a synthetic 3.3 GB store (3,600 sessions, 1.4M events),
warm median of five:

| query | v7 | v8 |
|---|---|---|
| migration (once) | | 53 s, 3,326 → 3,446 MB |
| sessions `tool:Bash ok:false` | 25,793 ms | 4.9 ms |
| sessions `tool:Bash ok:false since:7d sort:-tools` | 118,554 ms | 4.5 ms |
| sessions `kind:context.compact -flag:compaction` | 9,969 ms | 0.8 ms |
| facets `tool,mcp,kind` | 8,537 ms (54 s cold) | 31 ms |
| facets `tool` where `ok:false` | 7,570 ms | 36 ms |
| facets `tool,mcp` where `agent:codex since:7d` | 148 ms | 1.6 ms |
| facets `agent,model,repo,flag` | 16.7 ms | 18.6 ms |
| events `tool:Bash ok:false since:7d` | | 2 ms |
| events `kind:tool.end event.duration>15s agent:codex` | | 3.4 ms |
| events `error:timed` | | 38 ms |
| events `retry flaky` (text) | | 260 ms |
| search `migration` where `tool:Bash` | 957 ms | 1,050 ms |

Text and `error:` read payloads and stay the slow keys; pair them with an indexed key. Turns (item 4) are left to V-7.

## 10. Gaps against the current code

Paths under packages/coding.sh/src.

| area | gap | where |
|---|---|---|
| list API | no top-level default or `childCount` (item 16); filters only agent/flag/repo; search is a separate path filtered only by agent | viewer/server.ts:419–440, core/types.ts:36 |
| data holes | Repo filter never renders (repo_root NULL); cost always blank; duration blank for 3,593 sessions | ui/index.html:740–770, 1092–1135 |
| events API | offset paging, 5k default / 20k max, full payloads; the 154k session shows "first 5,000" | server.ts:296–304, ui/index.html:1077 |
| timeline | `buildTimeline` is flat: ignores parentId/subagentId, no `llm.call` in KIND_LABEL, turns only as a separator; no waterfall, folding, minimap, failure jump, find | ui/index.html:934–1090 |
| render | one DOM button per step (no virtualization); blobs up to 2 MB into one `<pre>` | ui/index.html:1030–1045, 1216–1250 |
| keys | only j/k, Home/End, Esc, `/` | ui/index.html:861–889, 1081–1088 |
| experiments | pass bars per bundle; no verdict, CI, paired table or attempt-session links (`RunResult.sessionId` unused); `ExperimentResult` not shown at all | ui/index.html:1317–1395, server.ts:350–360 |
| store | stats/flags as JSON; single-column `events_kind`; no facet, turn or metric tables | store/sqlite.ts:83–118, 453 |
| CLI | `sessions`: `--agent --repo --since --subagents`; `search`: text + `--agent`; no `--where`, facets, events | cli/registry.ts:136–165 |
| MCP | `search` takes `query` + `agent` only; no `facets`/`where`; `experiment_compare` naming ≠ bench | mcp/tools.ts:284–305, 494 |
| ingest | blocking first ingest; ingest shares the request connection | cli/commands/ui.ts:14–29 |
| marketing | the site sample already shows a nested waterfall with TTFT the real viewer can't | apps/site/src/components/Viewer.astro:158–215 |

## 11. Build order

Full entries (Verified, Changes, Acceptance, Tests) are in tasks/research-queue.md. Run `node --no-warnings --test
test/viewer test/query test/store && npm run check` for each.

1. **V-1. Non-blocking ingest + read connection — src/viewer, src/cli — S.** Accept: `ui` serves `/` in < 1 s with 5k
   pending spool files; queries answer during ingest. Test: worker ingest fixture; request latency during ingest.
2. **V-2. Facet columns, session_facets, turns, event indexes — src/store — M.** Accept: §9 queries < 100 ms warm on
   a 1M-event fixture; backfill idempotent. Test: migration + backfill golden; EXPLAIN guard.
3. **V-3. Query language core — src/query — M.** Accept: grammar in §3 incl. negation, OR, ranges, relative time;
   sqlite compile == scan fallback on fixtures. Test: parser table tests, fuzzed round-trip, SQL-injection cases.
4. **V-4. `--where` / facets on CLI and MCP — src/cli, src/mcp — S.** Accept: same string gives the same ids on CLI,
   MCP and HTTP. Test: cross-surface golden.
5. **V-5. Session list v2 — src/viewer — M.** Query bar + autocomplete, facets sidebar, columns, `is:root` +
   childCount (absorbs item 16 UI), saved views. Accept: keyboard-only filter → open → back keeps state in URL.
   Test: API bounds, UI smoke at 1280 and 390 px.
6. **V-6. Events tab — src/viewer — S.** Accept: `kind:tool tool:Bash ok:false` lists spans, Enter lands on the event.
   Test: jump-to-event e2e.
7. **V-7. Outline + rows API + shared span model — src/viewer — M.** Accept: 154k-event fixture outline < 30 ms;
   wrapper/subagent/compaction nodes as §6. Test: model.ts unit tests on claude-code, codex code-mode, antigravity fixtures.
8. **V-8. Session detail v2 UI — src/viewer — L.** Turn rail, tree, waterfall, inspector, folding, minimap, failure
   jump, find, key map, virtual list, range blobs. Accept: §6 budgets on the 154k fixture. Test: UI smoke + perf trace.
9. **V-9. Files tab — src/viewer — S.** Accept: per-turn and per-session file lists with diffs. Test: fixture with snapshot.
10. **V-10. Explore — src/viewer — M** (depends on C-6 engine). Accept: brush rewrites the query; table links
    reconcile with list counts. Test: metrics golden, UI smoke.
11. **V-11. Verdict model — src/experiments — M.** Accept: one `Verdict` from both `RunResult` and `ExperimentResult`;
    identical `line` on CLI/HTTP/MCP. Test: golden fixtures, status ordering.
12. **V-12. Benches, run, verdict, matrix UI — src/viewer — M.** Accept: regressions first; dot → attempt session.
    Test: fixture with regressions, flaky, errored, tamper.
13. **V-13. Trajectory compare — src/viewer — M.** Accept: first divergence marked on a known pair. Test: LCS unit
    tests, UI smoke.
