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
| Layout shift on a phone, Evals | 0.168 | 0.004 |
| Home screenshot on a desktop screen | 119.8 kB | 57.4 kB |
| Link preview images (13 files) | 545 kB | 382 kB |

The byte counts in this table were measured with the lab server at brotli quality 11. It now
uses quality 4, as production does (see "How we measure"), so the same pages read about 20% more
HTML and script than this table. The Evals layout shift is the median of the 9 pairs on main in
run 42721228885; the first run after the change measured 0.081.

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

## Font swap and image sizes

A second pass, measured with 11 pairs against the build before it. The fallback fonts now match
Geist closely enough that almost no line rewraps when the real font arrives: Arial at 103.4%,
plus a bold face of its own. The values were tuned on all 119 pages at phone width. Outside
103.3% to 103.5%, some pages rewrap again.

The home screenshots also say how wide their slot is, so a desktop screen picks the smaller file.

| What | Before | After | Change [95% interval] |
|---|---|---|---|
| Layout shift on a slow phone, /docs/cli | 0.208 | 0.0003 | -0.208 [-0.208, -0.208] |
| Layout shift on a slow phone, Quickstart | 0.009 | 0.0002 | -0.0088, the same in every pair |
| Layout shift on a slow phone, home | 0.0037 | 0.0029 | -0.0008 [-0.001, -0.001] |
| Layout shift on a slow phone, changelog | 0.0002 | 0 | -0.0002, the same in 9 of 11 pairs |
| Home screenshots on a desktop screen | 60.1 kB | 58.5 kB | -1,612 B, the same in every pair |

What it cost:

- HTML at brotli quality 4: the docs sidebar script and the code block script add 192 B on
  Quickstart, 234 B on /docs/cli and 129 B on Evals. Home is 6 B larger and the changelog 278 B
  smaller.
- Load times on a slow phone and on the desktop did not change for home, Evals, /docs/cli and
  the changelog: every interval includes zero.
- Desktop first paint on Quickstart is the one number to watch. Four runs read +5.8 ms
  [+1.4, +29], +4.1 ms [-21, +19], +7.8 ms [+2.5, +14] and -4.9 ms [-15, +9.4].
- The last two runs pooled read +6.0 ms [-1.5, +9.4], under the 130 ms budget.
- Removing the code block script does not change that number: -0.2 ms [-6.3, +9.5].

A fade at the bottom of the docs sidebar was tried and left out. Its mask made desktop first paint
on Evals 16.8 ms [3.2, 25.6] slower. Without it, Evals is -3.4 ms [-18, +5.5] against the build
before.

## How we measure

- **Pages:** home, /docs/quickstart, /docs/evals, /changelog and /docs/cli.
- **Profiles:** desktop with no throttling, and the slow phone above.
- **Each run:** Lighthouse loads every page in a fresh Chrome with an empty cache. A local server
  serves the build over HTTP/2 with brotli at quality 4, the level production sends: the home
  page's HTML is 25,796 B in the lab and 25,776 B from coding.sh. Production sends Chrome zstd,
  which is about 6% larger, so the lab still reads a little low.
- **Pairs:** the old build and the new one run in 11 interleaved pairs after one warm-up. Half the
  pairs run the old build first.
- **When a change counts:** the 95% bootstrap interval of the median paired difference excludes
  zero, and a sign test agrees after correcting for the number of metrics.

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

[.github/workflows/site-perf.yml](https://github.com/jackulau/coding.sh/blob/main/.github/workflows/site-perf.yml) builds the base and
head commits and runs 9 pairs. It runs when a change can reach the five measured pages: the
site's layouts, components, styles, assets and config, those pages themselves, and `scripts/perf`.
It fails when a gated metric gets worse by an amount that matters,
or when a page goes over its budget in
[scripts/perf/budgets.json](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/budgets.json). The budgets sit about 10%
above what the current build measures. Layout shift is budgeted at 0.02 on every page, and each
page has its own blocking-time budget on the slow phone. The rules are in
[scripts/perf/gate.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/gate.mjs), with tests in `scripts/perf/test`.

| Where | What runs |
|---|---|
| Pull requests | GitHub's hosted runners. Load-time budgets are skipped: they only hold on our own machine. |
| Pushes to main | The one desk runner labelled `perf`, so two perf runs never overlap. Deploys run beside it. |
| Pull requests and deploys | `npm run perf:budget` in apps/site checks page weight, inline CSS and script, fonts, scripts and images in the build. CI runs it on every pull request, and the Site workflow runs it again before a deploy. |

The desk runs other jobs, so each sample records `cpu_busy`, the share of CPU in use while the
page loaded. A load-time budget counts only samples at 0.5 or less (`--quiet-cpu`). When fewer
than half the pairs were quiet, the run warns and skips that budget.

### When a gated metric fails

The gated metrics are mobile LCP, mobile layout shift, mobile startup requests, and the script,
font and stylesheet bytes. One fails when both hold:

- **It is significant.** The test in "When a change counts" above calls it worse.
- **It is big enough to matter.** The median paired difference is at least the metric's minimum
  effect, in the table below.

| Metric | Minimum effect |
|---|---|
| Load time | 3% of the old median or 20 ms, whichever is larger: 49 ms on the home page's mobile LCP (about 1.65 s), 27 ms on a docs page (about 0.9 s) |
| Layout shift | 3% or 0.01 |
| Bytes and request counts | None: a fixed build gives the same number every run, so one added byte of script fails |

Nine quiet pairs can find a shift much smaller than anyone would notice. A version bump that
changed no page once failed on a 15 ms (0.9%) slower home LCP, with a 95% interval of 8 to 39 ms.
That now passes as too small to count. A 10% slower LCP is 165 ms on the home page and still fails.

### When a budget fails

A budget is checked against the low end of the 95% bootstrap interval of the head build's median
(over the quiet samples, for a load time), so it fails only when the samples show the page is over.

| Samples, budget 130 ms | Result |
|---|---|
| Median 130.5 ms, samples from 112 to 150 ms | Noise: passes |
| Samples from 150 to 170 ms | Fails |
| Bytes and request counts, one byte over | Fails: the interval has no width |

The interval follows each run's noise: narrow on a quiet machine, wider on a busy one instead of
failing at random. That is why it is used over a fixed margin.

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
| Field data from real visitors | Skipped. The build ships no analytics script. Cloudflare's edge can add its Web Analytics beacon when that is on for the zone, and the deploy prints a warning when the live home page has one. |

## Store ingest

Two changes to the SQLite index speed ingest, with no change to what is stored. Each was
confirmed in an in-process A/B, where machine load cancels out.

| Change | What it does | Measured |
|---|---|---|
| A bigger page cache | Each index connection sets `PRAGMA cache_size = -16000` (16 MB, up from the ~2 MB default) and `PRAGMA temp_store = MEMORY`. Nothing changes on disk. | The per-session events read: 10.51 ms median against 11.38 ms, 95% interval of the difference [0.82, 0.90] ms, about 7.6% faster |
| Fewer facet probes | Ingest skips the `kind`/`tool`/`mcp` facet tuples it already issued in a batch. The facet table is byte-for-byte identical (a test checks it). | A facet-heavy 30k-event batch: 1.51 ms median against 18.63 ms, 95% interval of the difference [17.07, 17.15] ms. A 20k-event session issues 360 facet rows instead of 39,880 probes |

A paired wall-clock ingest of a 50k-event corpus (6 pairs) on the busy desk put the candidate at
66.0 s against 76.2 s for origin/main, but the 95% interval, [-86.5, +569.5] ev/s, straddles zero:
**inconclusive**, not a result.
[scripts/dogfood/bench.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/dogfood/bench.mjs) runs the paired ingest. To re-run it
(baseline is origin/main built into its own dist):

```sh
DESK_DIR=coding-sh-perf .claude/bin/desk run \
  "node scripts/dogfood/bench.mjs ingest --baseline /root/dist-baseline --pairs 8"
```

### Small blobs in a pack

The two changes above left ingest at about 1,700 events/s and the store at 5.5 MB per 1,000
events, against budgets of 5,000 and 2. Both had one cause: every hook line's raw payload is a
blob, so the 100k-event corpus wrote 100,000 blob files. Each takes a whole 4 KiB disk block, and
the file work, not parsing or the index, was most of the ingest time.

A blob that compresses to under 4 KiB is now a row of `blobs/pack.db`, a SQLite file. Larger blobs
stay files. Reads look in the pack, then for a file, so an older store reads as it did, and
`gc --compact` moves its small blob files into the pack.

Paired on the desk (`bench.mjs ingest store --baseline`, 8 interleaved pairs, a 100k-event corpus,
32 cores, load average 7 at the start, falling to 2 by the end):

| | origin/main | pack | |
| --- | --- | --- | --- |
| Ingest | 1,688 events/s (59.4 s) | 6,195 events/s (16.2 s) | +4,507 events/s, 95% CI [4,443, 4,618] |
| Store size | 5.51 MB / 1k events | 1.72 MB / 1k events | same bytes every run |
| Index | 142.6 MB | 142.6 MB | unchanged |
| Blobs | 409.6 MB in 100,000 files | 30.2 MB in one file | |

A write that cannot get the pack's lock within 500 ms writes its blobs as files instead. A rerun
with that fallback gave 6,131 against 1,696 events/s, +4,435, 95% CI [4,400, 4,498], with the same
store sizes.

The store is now mostly the index (1.43 MB per 1,000 events). The largest part left there is
`search_extra`, which copies each `tool.end` output for full-text search (22.6 MB of the 142.6).

## OTLP collector

`coding.sh collector` stores concurrent OTLP requests together:

- **Group commit.** Requests that arrive while a write runs wait for it, then the next write stores
  them all in one SQLite transaction. Each request still gets its own answer, and a request whose spans fail to map fails alone.
- **Blob batch.** The blobs a group writes (large payloads) go through the blob store's batch API
  and are flushed once, before the events that point at them are stored.
- **No raw span blobs by default.** The collector used to keep every source span as a blob on its
  event, one blob write per span. That is now opt-in: `coding.sh collector --keep-raw`.
  `coding.sh serve` still keeps them, as before.
- **Sessions from the events in hand.** A new session is built from the events the request just
  stored instead of reading them back. A test checks the two builds are equal.

[scripts/dogfood/bench.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/dogfood/bench.mjs) `collector` starts the built
collector in a temp home and runs 8 clients, each posting 61-span OTLP/JSON requests one at a
time. It reports spans/s, request latency percentiles, peak RSS and CPU time per 1,000 spans.
`--sessions request` (the default) makes each request a session; `--sessions client` makes each
client one session that grows by 61 spans a request.

```sh
DESK_DIR=coding-sh-otel .claude/bin/desk run "node scripts/dogfood/bench.mjs collector --seconds 8"
```

On the desk, interleaved 8-second runs of the commit before this change and this change, on
Nov 8, 2026, with the desk's load average between 10 and 55 (other jobs):

| | Before | After |
| --- | --- | --- |
| spans/s, a session per request | 1,437 to 3,075 | 5,585 to 6,865 |
| request p95 | 283 to 613 ms | 125 to 155 ms |
| request p50 | 143 to 307 ms | 62 to 77 ms |
| peak RSS | 159 to 219 MB | 178 to 183 MB |
| CPU per 1,000 spans | 360 to 719 ms | 156 to 195 ms |
| spans/s, one long session per client | 1,106 | 1,158 |

The targets are 5,000 spans/s, a p95 under 100 ms and 200 MB of RSS. Throughput and RSS meet
them; the p95 does not. A request that arrives during a write waits for that write and then its
own, so the p95 is about twice the p50.

Long sessions are not faster. Every write rebuilds each session it touched from all its events,
so a request costs more as its session grows, and peak RSS in that mode reached about 250 MB in
both builds.

## Hook

Agents run the hook on every tool call, so its cost adds to every step. Outside Windows the hook
is `hook.sh`, a POSIX sh script that writes the spool line without starting node, which alone
costs about 25 ms on the desk. `node scripts/dogfood/bench.mjs hook` times it against `/bin/true`,
200 interleaved calls each (`perf.hookSh`, `perf.hookShP95`; budget 3 ms and 5 ms).

On Debian and Ubuntu `/bin/sh` is dash, and the hook runs itself again under bash 5. bash in
POSIX mode reads a pipe or socket one byte per `read(2)`, about 1 ms per KB, and half of
160 real Claude Code PostToolUse hook lines were over 2.5 KB. The hook now turns POSIX mode off
around one `read -N 262144`, which reads in blocks.

Desk, WSL Ubuntu, bash 5.3, Node 24, Nov 9, 2026. Difference over `/bin/true`, median / p95, 100
interleaved calls per row. Node agents (Claude Code, Gemini CLI) give the hook a socket; Codex
gives a pipe.

| Payload | Before | After |
| --- | --- | --- |
| socket, 0.6 KB | +2.3 / +3.2 ms | +1.6 / +2.2 ms |
| socket, 2 KB | +8.2 / +9.5 ms | +2.0 / +2.3 ms |
| socket, 6 KB | +8.4 / +10.0 ms | +2.3 / +2.6 ms |
| socket, 12 KB | +8.8 / +13.2 ms | +2.8 / +2.7 ms |
| pipe, 2 KB | +6.1 / +6.8 ms | +1.2 / +1.0 ms |
| pipe, 12 KB | +7.4 / +11.1 ms | +1.9 / +1.5 ms |

`bench.mjs hook` on the same machine: `perf.hookShP95` 2.78 ms for a 600-byte payload and
`perf.hookSh2kbP95` 2.75 ms for 2 KB (8.47 ms before). The node hook, `hook.mjs`, still costs
about 8.5 ms more than `node -e ""`; Windows and the cases `hook.sh` hands on pay that.

## Long sessions

[scripts/perf/longrun.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/longrun.mjs) generates a synthetic 12-hour Claude Code
session: about 42,000 events, 26 compactions, 16 subagents, resumes and a day boundary. It
ingests it, then times `show`, `sessions`, `search`, the viewer API, MCP reads and a live hook
ingest on top of it. Run it on the desk:

```sh
DESK_DIR=wt-longrun .claude/bin/desk run "node scripts/perf/longrun.mjs --budgets scripts/perf/longrun-budgets.json"
```

It prints one JSON object of numbers and exits 1 when a number goes over its budget in
[scripts/perf/longrun-budgets.json](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/longrun-budgets.json). The budgets are about twice the numbers below.
`test/cli/longrun.test.ts` runs a quarter-size session in the unit tests and fails when ingest
stops scaling linearly or derail detection gets slow.

Before is origin/main on Nov 7, 2026 and after is this change, both on the desk with the same
fixture. The spool row is the median of 3 interleaved runs, and the live row the median of 10
ingests of 4 hook lines each.

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
stats, flags and derail detectors about 15 minutes behind its newest event, and folds in only what
came after. Out of 0.46 s, folding takes about 0.08 s; the rest is starting Node and loading the
CLI. Phases are stored with the session at ingest, so `show` and the viewer never rescan events.

The spool row is mostly disk time, and the desk's disk swings it from 34 s to 128 s between runs
of the same build.

In Chrome, with all 30,155 steps loaded, the timeline scrolls with a p95 of 11 ms per jump and
9 ms per wheel step. No task during the background load ran longer than 0.1 s.
