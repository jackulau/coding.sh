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

## Translated front pages

The front page is also served at /de, /es, /fr, /ja, /ko, /pt-br and /zh. This is what it cost
the English home page, measured with 30 interleaved pairs against the build before it on a phone
viewport with a 4x slower CPU. Regular 3G is 300 ms latency and 750 kbps. Slow 3G is 2,000 ms
latency and 400 kbps. These profiles are not in the Lighthouse runner below: a one-off script set
them through the DevTools protocol, which adds the latency once per request, and served the
builds with the same server. The machine was busy during the run; pairing controls for that, but
the absolute times may read a little high.

| What | Before | After | Change [95% interval] |
|---|---|---|---|
| HTML, compressed | 29,090 B | 29,734 B | +644 B, the same in every pair |
| Fonts | 26,672 B | 26,672 B | 0 B |
| First paint, Regular 3G | 572 ms | 568 ms | 0 ms [-4, +4] |
| Main content (LCP), Regular 3G | 572 ms | 568 ms | 0 ms [-4, +4] |
| First paint, Slow 3G | 2,248 ms | 2,252 ms | +8 ms [+2, +10] |
| Main content (LCP), Slow 3G | 2,348 ms | 2,384 ms | +36 ms [+32, +40] |
| Page ready (DOMContentLoaded), Slow 3G | 4,433 ms | 4,457 ms | +25 ms [+3, +31] |

The HTML grew by the hreflang links in the head and the language switcher in the footer. The
fonts did not grow. The switcher's names Español, Français and Português use ñ, ç and ê, which
are not in the common-letter font files, so the switcher is drawn in the system font. Drawn in
Geist, it would make every page fetch the rare-letter files as well.

The German, Spanish, French and Portuguese pages need accented letters above the fold, so they
preload the rare-letter files too (`preloadRest` in `apps/site/src/i18n/locales.mjs`). That is
about 21 kB more font. On /de, first paint is the same as the English page; the page is ready
about 130 ms later on Regular 3G and 240 ms later on Slow 3G. `npm run perf:budget` checks the
translated pages against their own HTML budget, and checks the preloaded fonts per page.

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

On Windows, run `npx -p coding.sh codingsh` where the block says `npx coding.sh`. Pass any paths
with `--page`. A run of 11 pairs takes about 50 minutes for 4 pages. In this repo,
`node scripts/perf/ab.mjs --base <old dist> --cand apps/site/dist` does the same for our pages.
See [Experiments](https://coding.sh/docs/experiments#metrics) for the metric A/B itself.

## Budgets in CI

[.github/workflows/site-perf.yml](https://github.com/jackulau/coding.sh/blob/main/.github/workflows/site-perf.yml) builds the base and
head commits and runs 9 pairs. On a push to `main` it runs when the change touches the site's
layouts, components, styles, assets or config, the five measured pages themselves, or
`scripts/perf`. CI calls it for pull requests: one that touches those paths gets it at once, and
every pull request gets it with the `ready` label, as part of the `full suite` check that `main`
requires.
On a pull request each page is measured in its own job, five in all, with the same
pairs in the same order (`ab.mjs --part`). One more job joins their samples into a single result
(`ab.mjs --merge`) and judges it, so the gate and its correction cover every metric as they do in
one run. A page or profile with no samples fails that job.
It fails when a gated metric gets worse by an amount that matters,
or when a page goes over its budget in
[scripts/perf/budgets.json](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/budgets.json). The budgets sit about 10%
above what the current build measures. Layout shift is budgeted at 0.02 on every page, and each
page has its own blocking-time budget on the slow phone. The rules are in
[scripts/perf/gate.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/gate.mjs), with tests in `scripts/perf/test`
(`npm run perf:test`, which `npm run gate` runs).

Site perf builds both versions with a star count in the nav, as the deployed site shows one. After
its site build, `npm run gate` checks each page's HTML against these budgets with no browser
(`scripts/perf/html-budget.mjs`). It compresses each page as the perf server does, so its counts
match Site perf's, and a page over its HTML budget fails before the pull request.

| Where | What runs |
|---|---|
| Pull requests | GitHub's hosted runners, one job per page. Load-time budgets are skipped: they only hold on our own machine. |
| Pushes to main | The one desk runner labelled `perf`, so two perf runs never overlap. Deploys run beside it. |
| Pull requests and deploys | `npm run perf:budget` in apps/site checks page weight, inline CSS and script, fonts, scripts and images in the build. CI runs it on every pull request, `npm run gate` runs it in its site step, and the Site workflow runs it again before a deploy. |

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

## Repo facet

`sessions --facets` and the viewer's filter list count sessions per repo. A session's repo is a
long SQL expression over its folder: the main checkout's name, the worktree layouts of Claude
Code, T3 Code and Codex, and the macOS temp folder. SQLite worked it out about two and a half
times per session. The SQLite store now counts the sessions per folder first, then names each
folder once, and a store has far fewer folders than sessions. `test/core/repo-identity.test.ts`
checks that SQLite and the in-memory scan give the same counts.

Desk, Windows 11, Node 24.20, Nov 24, 2026.
[scripts/dogfood/bench-where.mjs](https://github.com/jackulau/coding.sh/blob/main/scripts/dogfood/bench-where.mjs)
ran on a generated store of 3,600 sessions and 208,010 events in 40 folders. Each run gives every
query's warm median of 9 calls, and 10 pairs of runs of the old and new code alternate. In
brackets is the paired median difference with its 95% bootstrap interval.

| Query | Before | After |
| --- | --- | --- |
| `facets agent,model,repo,flag` | 35.2 ms | 8.9 ms (-26.3 [-27.2, -25.3]) |

The other 19 queries (sessions, events, search and the other facets) moved by at most 0.8 ms, each
with an interval that includes no change, and every query returned the same number of rows.

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

## Read commands

Before it reads, a command such as `sessions` or `usage` ingests what hooks left in the spool and
checks whether stored sessions need a re-parse after an upgrade. Both load the spool ingest,
`core/ingest.ts`. It imported two names from the OTLP receiver, so every read also loaded the
receiver, its protobuf decoder and its span mapping (233 KB of source a read never runs) and
`node:http`, whose ESM import makes Node load its bundled HTTP client. The two names now live in
`src/otel/ingest-shared.ts`. `test/core/ingest-imports.test.ts` fails if the ingest or the
re-parse check loads the receiver or `node:http` again.

Desk, Windows 11, Node 24.20, Nov 24, 2026, the built `cli.mjs` on an empty store. Each cell is
the command over `node -e ""`, the median of 120 interleaved calls (80 for `--help`, which loads
neither and is the control). In brackets is the paired median difference from the commit before
this change, with its 95% bootstrap interval.

| Command | Before | After |
| --- | --- | --- |
| `sessions` | +169.9 ms | +136.7 ms (-33.2 [-42.8, -26.0]) |
| `usage` | +169.0 ms | +138.5 ms (-30.4 [-35.4, -26.4]) |
| `--help` | +54.2 ms | +54.4 ms (+0.2 [-24.3, 21.6]) |

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

### Redaction in the node hook

`hook.mjs` redacts a payload before it writes it ([privacy](guides/privacy.md#the-raw-spool)). The
rules live in their own file, `hook-redact.mjs`. A call that uses them costs about 4.8 ms more:
2.2 ms to import them, 0.6 ms to set them up, and 2.0 ms to redact a 2 KB payload, most of it spent
compiling each regex on its first use.

Most payloads hold nothing the default rules replace. `src/spool/gate.ts` reads the payload's text
first and loads the rules only when it may hold a secret, or when `config.toml` sets other rules.
`test/spool/gate.test.ts` runs the rules on payloads written by hand and generated, and fails when
they change one the check let through.

Two small changes pay for the check: `paths()` builds its paths without `path.join`, and the hook
names the day's spool file without `toISOString()`.

Desk, Windows 11, Node 24.20, Nov 20, 2026. Each cell is `hook.mjs` over `node -e ""`, the median
of interleaved calls (200 at 2 KB, 120 with a secret, 40 at 1 MB). In brackets is the paired
median difference from origin/main, which does not redact in the hook, with its 95% bootstrap
interval.

| Payload | origin/main | Rules on every payload | Rules only when needed |
| --- | --- | --- | --- |
| 2 KB, no secret | +10.2 ms | +15.5 ms (+5.3 [5.1, 5.7]) | +9.0 ms (-1.2 [-1.4, -0.9]) |
| 2 KB, one secret | +9.6 ms | +15.8 ms (+6.5 [6.1, 6.8]) | +13.6 ms (+3.8 [3.4, 4.3]) |
| 1 MB, no secret | +14.4 ms | +29.4 ms (+15.3 [14.5, 15.6]) | +17.7 ms (+3.1 [2.5, 3.9]) |

`bench.mjs hook --baseline` on the same machine puts `perf.hook` 1.41 ms [0.82, 2.09] under
origin/main. A run against the 0.1.7 hook puts the 2 KB call 0.67 ms [0.08, 0.91] under it.

At 1 MB, the extra 3.1 ms is the check reading the whole text. Bundling the rules into `hook.mjs`
added about 1.2 ms to every call, and a CommonJS bundle and node's compile cache were no faster.

The check finds a possible secret in 28% of this repo's source files, 67% of its docs pages, 12% of
its site files and 17% of its adapter fixtures. A session that reads many files pays the slower
cost often.

### Built-in modules in the node hook

The first ESM import of a built-in module makes Node build an ES module for it, which reads each
of its exports. For `node:fs` that loaded `stream`, `stream/promises`, `string_decoder` and the
internal modules behind them on every hook call. The modules `hook.mjs` loads now take `node:fs`
and `node:path` from `process.getBuiltinModule`, which returns the module Node has already loaded.
They load `node:os` only when `HOME` and `USERPROFILE` are both unset or a lock's holder is
checked, and `node:crypto` on first use. `test/capture/hook.test.ts` checks that the bundled hook
loads no built-in module that a bare node start does not.

Agents run `hook.mjs` with the first node on their PATH. A node older than 22.3 (20.16 on the 20
line) has no `process.getBuiltinModule`, so the first line of `hook.mjs` sets it to a `require`
there, and the hook still records the call.

Desk, Windows 11, Node 24.20, Nov 24, 2026. Each cell is `hook.mjs` over `node -e ""`, the median
of interleaved calls (200 at 0.6 KB and 2 KB, 120 with a secret, 40 at 1 MB). In brackets is the
paired median difference from origin/main, with its 95% bootstrap interval.

| Payload | origin/main | Built-ins from `getBuiltinModule` |
| --- | --- | --- |
| 0.6 KB, no secret | +11.7 ms | +7.6 ms (-4.1 [-12.6, -0.9]) |
| 2 KB, no secret | +9.2 ms | +5.8 ms (-3.4 [-5.9, -2.2]) |
| 2 KB, one secret | +17.7 ms | +14.7 ms (-3.0 [-4.3, -1.8]) |
| 1 MB, no secret | +14.6 ms | +11.0 ms (-3.7 [-4.8, -2.3]) |

The machine was busier during the 0.6 KB row: `node -e ""` took 65 ms there and 46 to 52 ms in the
others, which widens that interval.

`bench.mjs hook --baseline` on the same machine, 50 calls each, puts `perf.hookStart` 3.3 ms
[2.0, 4.9] under origin/main. It puts `perf.hook` 3.0 ms under, but at 50 calls that interval,
[-1.0, 7.3], still includes no change.

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
