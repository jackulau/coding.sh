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
See [Evals](https://coding.sh/docs/evals#metrics) for the metric A/B itself.

## Budgets in CI

[.github/workflows/site-perf.yml](https://github.com/jackulau/coding.sh/blob/main/.github/workflows/site-perf.yml) builds the base and head
commits and runs 9 pairs. It fails when a gated metric gets worse, or when a page goes over its
budget in [scripts/perf/budgets.json](https://github.com/jackulau/coding.sh/blob/main/scripts/perf/budgets.json). The budgets sit about 10%
above the numbers above. Pull requests run on GitHub's hosted runners and skip the load-time
budgets, which only hold on our own machine. The deploy also checks page weight, fonts, scripts
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
