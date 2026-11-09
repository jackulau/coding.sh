# Site speed

On a slow phone, coding.sh pages are ready half a second sooner, and the home page's main image
shows about 0.15 s sooner. Docs pages jump much less while the fonts load. The look, the motion
and the content are the same.

We measure the site with coding.sh itself, the same way we'd ask you to measure an agent change.

## Before and after

A slow phone here means Slow 4G (150 ms round trip, 1.6 Mbps) on a 4x slower CPU.

| What | Before | After |
|---|---|---|
| Page ready on a slow phone (DOMContentLoaded, all 4 pages) | 1.84 s | 1.34 s |
| Home main image on a slow phone (LCP) | 1.79-1.81 s | 1.63-1.66 s |
| Fonts downloaded per page | 52.4 kB | 26.5 kB |
| Script per page | 6.0-8.5 kB | 4.7-6.8 kB |
| Requests before the page loads (home, docs) | 10-11, 7 | 7-8, 5 |
| Layout shift on a phone, Quickstart | 0.128 | 0.009 |
| Layout shift on a phone, Evals | 0.168 | 0.081 |
| Home screenshot on a desktop screen | 119.8 kB | 57.4 kB |
| Link preview images (13 files) | 545 kB | 382 kB |

What it cost:

- Each page's HTML grew by 1.2-1.9 kB (compressed), because small scripts and font fallback
  rules now sit in the page. On the changelog that delays first paint on a slow phone by about
  11 ms.
- The Evals page gained about 13 ms of blocking time on a slow phone. It stays well under 50 ms.
- Desktop load times didn't move. They were already about 0.1-0.17 s.

## What we changed

- **Smaller fonts.** Each font is split in two. The common letters load first and the rare ones
  load only on a page that uses them. Nothing renders in a different font.
- **Fallback fonts that match.** Until the real font arrives, the stand-in has the same size
  and spacing, so text doesn't move when it swaps.
- **Fewer script files.** Small page scripts are part of the page now, and one copy handler
  serves every copy button. A page no longer waits for extra files before it's ready.
- **Right-sized screenshot.** Desktop screens at normal pixel density get a 960 px image, not
  the 2x one.
- **Smaller link previews.** The images re-encode without losing a pixel.

## How we measure

- **Pages:** home, /docs/quickstart, /docs/evals and /changelog.
- **Profiles:** desktop with no throttling, and the slow phone above.
- **Each run:** Lighthouse loads every page in a fresh Chrome with an empty cache. A local server
  serves the build over HTTP/2 with brotli, like production.
- **Pairs:** the old build and the new one run in 11 interleaved pairs after one warm-up. Half the
  pairs run the old build first.
- **When a change counts:** the 95% bootstrap interval of the median paired difference must
  exclude zero, and a sign test must agree after correcting for the number of metrics. A byte
  count that is the same in every run is exact.

[scripts/perf/lighthouse.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/lighthouse.mjs) takes one sample and prints numbers.
`coding.sh exp metrics` repeats it and does the statistics. To run it on your own site, build
the old and new versions into two folders, then:

```sh
npm install --save-dev coding.sh lighthouse
curl -fsSLO https://raw.githubusercontent.com/jackulau/coding.sh/main/scripts/perf/lighthouse.mjs
curl -fsSLO https://raw.githubusercontent.com/jackulau/coding.sh/main/scripts/perf/serve.mjs
npx coding.sh exp metrics \
  --arm old='node lighthouse.mjs --dir old-dist --page / --page /pricing' \
  --arm new='node lighthouse.mjs --dir dist --page / --page /pricing' \
  --pairs 11 --warmup 1
```

Pass any paths with `--page`. A run of 11 pairs takes about 50 minutes for 4 pages. In this repo,
`node scripts/perf/ab.mjs --base <old dist> --cand apps/site/dist` does the same for our pages.
See [Experiments](https://coding.sh/docs/experiments#metrics) for the metric A/B itself.

## Budgets in CI

[.github/workflows/site-perf.yml](https://github.com/jackulau/coding.sh/blob/main/.github/workflows/site-perf.yml) builds the base and head
commits and runs 9 pairs. It fails when a gated metric gets worse, or when a page goes over its
budget in [scripts/perf/budgets.json](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/budgets.json). The budgets sit about 10%
above the numbers above. Pull requests run on GitHub's hosted runners and skip the load-time
budgets, which only hold on our own machine. Our machine runs other jobs too, so each sample also
records `cpu_busy`, the share of the machine's CPU in use while that page loaded. A load-time
budget counts only the samples where it was 0.5 or less (`--quiet-cpu`). When fewer than half the
pairs were quiet, the run says so in a warning and skips that budget. The deploy also checks page weight, fonts, scripts
and images in the build (`npm run perf:budget` in apps/site).

## What we took from X's rewrite

X rebuilt its web app in 2026 and published how they measured it. We used their method on a much
smaller site.

| X practice | Here |
|---|---|
| Fewer startup files | Done: no page script pulls shared chunks any more. |
| Stylesheet first, nothing waits on scripts | Done: CSS was already inline, and now no script file holds the page back. |
| WebP images at the right size | Done: we already served WebP, and added the 960 px file. |
| 11 interleaved pairs, 95% bootstrap interval, costs listed next to gains | Done: this page. |
| Lighthouse on every pull request, with budgets | Done: site-perf.yml. |
| A metric for the first real content, not first paint | Done: the home page marks when the viewer screenshot paints. |
| Content in the first response | Already true: the site is static HTML. |
| Preload on hover or focus | Already true: Astro's router prefetches links on hover. |
| SVG sprite for repeated icons | Skipped: few icons repeat, and brotli compresses the repeats well. |
| Streaming server rendering, data in the page, worker threads | Skipped: the site has no server. These apply to `coding.sh ui`. |
| Field data from real visitors | Skipped: the site has no analytics, by choice. |

## Store ingest

Two changes to the SQLite index speed ingest, with no change to what is stored:

- **A bigger page cache.** Each index connection sets `PRAGMA cache_size = -16000` (16 MB, up from
  the ~2 MB default) and `PRAGMA temp_store = MEMORY`. Both are bounded RAM that is freed when the
  connection closes and change nothing on disk or in the file's locking, so read-only connections
  and Windows are unaffected. A few thousand events spill the default cache, so ingest and the
  reads that fold a session stop re-decoding pages this keeps resident.
- **Fewer facet probes.** A session repeats the same handful of `kind`/`tool`/`mcp` facet values
  across hundreds of events. Each repeat was an `INSERT OR IGNORE` that no-ops on
  `session_facets`' primary key but still probes the b-tree. Ingest now skips the tuples it has
  already issued in a batch; the facet table is byte-for-byte identical (a test asserts it equals a
  full rebuild).

Measured with [scripts/dogfood/bench.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/dogfood/bench.mjs),
which ingests a byte-identical synthetic corpus through the candidate and the origin/main build in
interleaved pairs and reports a 95% bootstrap interval on the median events/s difference. On the
desk, which runs other jobs (an unpaired ingest there swings 2-3x between runs), the pairing is
what carries signal, not the absolute throughput:

A paired ingest of a 50k-event corpus (6 pairs) on the desk put the candidate at a 66.0 s
median against 76.2 s for origin/main, about +15% throughput — but the desk was busy and the
95% interval on the per-second difference, [-86.5, +569.5] ev/s, straddles zero, so the
wall-clock run is **inconclusive**, not a result. Each change was instead confirmed in
isolation, where machine load cancels out:

- **Facet probes.** An in-process A/B that inserts the same facet-heavy 30k-event batch with and
  without the in-batch skip (120 pairs, identical schema) ran the candidate in a 1.51 ms median
  against 18.63 ms, a +17.12 ms difference with a 95% interval of [17.07, 17.15] ms — the facet
  inserts a busy session repeats cost roughly 12x less. The reduction is deterministic: a 20k-event
  session issues 360 facet rows instead of 39,880 `INSERT OR IGNORE` probes, about 110x fewer, and
  the stored table is identical either way.
- **Page cache.** An in-process A/B that opens two read-only connections differing only in the
  cache pragmas and times the real per-session read `SELECT * FROM events WHERE session_id = ?
  ORDER BY ts, rowid` (40 sessions x 200 iterations, interleaved) read in a 10.51 ms median against
  11.38 ms, a +0.87 ms difference with a 95% interval of [0.82, 0.90] ms — about 7.6% faster reads
  once a session no longer fits the default cache.

To re-run the loop (baseline is origin/main built into its own dist):

```sh
DESK_DIR=coding-sh-perf .claude/bin/desk run \
  "node scripts/dogfood/bench.mjs ingest --baseline /root/dist-baseline --pairs 8"
```

### Small blobs in a pack

The two changes above left ingest at about 1,700 events/s and the store at 5.5 MB per 1,000
events, against budgets of 5,000 and 2. A profile of the 100k-event benchmark corpus showed both
had one cause: every hook line's raw payload is a blob, so the corpus wrote 100,000 blob files.
Each compresses to about 200 bytes but takes a whole 4 KiB disk block, so 410 MB of the 552 MB
store was blob files that held about 20 MB. Each also cost a temp file, a rename and directory
fsyncs, and that file work, not parsing or the index, was most of the ingest time.

A blob that compresses to under 4 KiB is now a row of `blobs/pack.db`, a SQLite file (WAL,
`synchronous=FULL`, `fullfsync` on macOS, so a put that returns is on disk as a file was). An
ingest checkpoint writes its rows in one transaction, and a write that cannot get the pack's lock
within 500 ms writes its blobs as files instead. Larger blobs stay files. Reads look in the
pack, then for a file, so a store written before reads as it did; `gc --compact` moves its small
blob files into the pack, and `purge` and `gc --compact` rewrite the pack (VACUUM) so a deleted
row leaves no bytes behind. Nothing else about what is stored changes: the same blobs, refs and
index rows.

Paired on the desk (`bench.mjs ingest store --baseline`, 8 interleaved pairs, a 100k-event corpus,
32 cores, load average 7 at the start, falling to 2 by the end):

| | origin/main | pack | |
| --- | --- | --- | --- |
| Ingest | 1,688 events/s (59.4 s) | 6,195 events/s (16.2 s) | +4,507 events/s, 95% CI [4,443, 4,618] |
| Store size | 5.51 MB / 1k events | 1.72 MB / 1k events | same bytes every run |
| Index | 142.6 MB | 142.6 MB | unchanged |
| Blobs | 409.6 MB in 100,000 files | 30.2 MB in one file | |

An earlier run on a quieter desk (load 0.3 to 1.4), before a one-line change to how the pack keeps
a row's mtime, gave +4,525 events/s, 95% CI [4,487, 4,579], and the same store sizes. A rerun after
the pack's lock wait became 500 ms with a file fallback gave 6,131 against 1,696 events/s, +4,435,
95% CI [4,400, 4,498], with the same store sizes and no fallback files (one ingest writes alone).

The store is now mostly the index (1.43 MB per 1,000 events). The largest part left there is
`search_extra`, which copies each `tool.end` output for full-text search (22.6 MB of the 142.6).
The other costs the profile showed are small next to the file work: a new zstd context per blob
(about 1 s per 100k blobs) and the index's commit.

## Long sessions

[scripts/perf/longrun.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/longrun.mjs) generates a synthetic 12-hour Claude Code session with no
real data in it: about 42,000 events in the main session, 26 compactions, 16 subagents, resumes
and a day boundary. It ingests the session from transcripts and from hook spool files, then times
`show`, `show --all`, `sessions`, `sessions --flag`, `search`, the viewer API, MCP reads and a live
hook ingest on top of the full session. Run it on the desk:

```sh
DESK_DIR=wt-longrun .claude/bin/desk run "node scripts/perf/longrun.mjs --budgets scripts/perf/longrun-budgets.json"
```

It prints one JSON object of numbers and exits 1 when a number goes over its budget in
[scripts/perf/longrun-budgets.json](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/longrun-budgets.json). The budgets are about twice the numbers below.
`test/cli/longrun.test.ts` runs a quarter-size session in the unit tests and fails when ingest
stops scaling linearly or derail detection gets slow.

Before is origin/main on Nov 7, 2026 and after is this change, both on the desk with the same
fixture. The desk runs other jobs, so ingest varies 2 to 3 times between runs: the spool row is
the median of 3 interleaved runs, and the live row the median of 10 ingests of 4 hook lines each.

| Step | Before | After |
| --- | --- | --- |
| Spool ingest, 30,000 events | 68.4 s | 63.2 s |
| Live hook ingest on the full session, p50 | 1.01 s | 0.46 s |
| `show` | 0.30 s, 174 lines | 0.33 s, 92 lines: one per phase |
| `show --all` | none | 1.64 s, 30,223 lines |
| `show --json` | 0.30 s | 0.31 s |
| `sessions --flag looping` | none | 0.34 s |
| `search` | 0.29 to 0.31 s | 0.31 s |
| Viewer: first 5,000 events | 0.14 s | 0.16 s |
| Viewer: the whole session | 6 clicks on "Load the next 5,000 events" | loads on its own: 3 requests, 0.84 s |
| Viewer: phases and derails (`/outline`) | none | 4 ms |
| MCP `session_get`, last turns | the first 20,000 events only | the last 20,000 events, 0.33 s |

A live ingest no longer rebuilds the session from all its events. Ingest saves the session's
stats, flags and derail detectors with the session, about 15 minutes behind its newest event, and
folds in only what came after. Out of 0.46 s, folding takes about 0.08 s; the rest is starting
Node and loading the CLI. In three runs interleaved with two of the commit before this change,
that commit took 1.16 s per live ingest. The spool row is mostly disk time, and the desk's disk swings it from 34 s
to 128 s between runs of the same build.
Phases are stored with the session at ingest, so `show` and the viewer never rescan the events.

In Chrome, with all 30,155 steps loaded, the timeline scrolls with a p95 of 11 ms per jump and
9 ms per wheel step. No task during the background load ran longer than 0.1 s.
