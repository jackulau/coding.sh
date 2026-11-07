# X web rewrite: what we take for coding.sh

Source: Yagiz Nizipli, "Rebuilding the global town square from scratch", blog.x.com/engineering, 2026-11-04. Read via a browser on 2026-11-06 (the blog returns 403 to fetchers). The full text is in the session scratchpad and is not checked in.

## What they did (facts from the post)

- **Architecture:** three servers (rweb CSR, rweb SSR for crawlers, Jetfuel SSR) became one. It runs Vite/Rolldown, React streaming SSR with Suspense, Fastify, Platformatic Watt (worker threads, recycled on event-loop or memory overrun), Relay/GraphQL and XDS (Base UI + Tailwind).
- **Result:** on Slow 4G the first post shows at 2.7 s, where the old app took 23.9 s. On a profile or post, no JS downloads before the first post (rweb downloaded 3.0–3.6 MB). Total JS per page is 1.3–2.3 MB, against 4.1–4.8 MB before.
- **Per audience:**
  - People get streaming HTML.
  - Crawlers verified by IP get a complete, non-hydrating document with no bundle and no router state, kept under Googlebot's 2 MB cutoff.
  - Link-preview bots get only head tags and skip body loaders.
  - They do not branch on User-Agent: it would buffer Lighthouse too, and anyone could ask for the expensive path.
- **Data in page:** the page carries each GraphQL response once as JSON text, not normalized store records, which were 4–5× bigger. The browser replays the responses into an empty store. Unread responses are kept for 30 s after the stream ends.
- **Intent preload:**
  - Links preload code and data on hover or focus.
  - Posts preload after the pointer rests 100 ms, or on press.
  - Nothing preloads when content scrolls under a still pointer.
  - Route loaders start the main query, so a preload fetches data together with code.
- **Startup files:** Rolldown's default chunking needed 754 files for the signed-in entry (582 logged out). That is about 8 round trips, because HTTP/2 allows about 100 streams. They packed startup modules into 3 chunks (deps, app code, the lazy-chunk name map), bringing the counts to 182 and 10. Home first post went from 6.63 s to 4.95 s with +275 ms per JS response.
- **Async entry:** the entry is an async module rather than a deferred one, so the shell hydrates at 589 ms instead of waiting for the document to finish parsing at 6,017 ms.
- **Stylesheet first:** an inline script injects the entry and chunk preloads once the CSS loads.
  - FCP on a profile went from 3,064 ms to 1,984 ms, and on a post from 7,216 ms to 1,804 ms.
  - Cost: hydration was 0.3–0.6% later on 2 of 5 pages.
- **Bytes:**
  - English renders messages from keys, saving 5 catalog files (49.5 KB gz).
  - A tiny message parser replaces ICU (−8 KB gz per entry).
  - The Sentry release ID is gone from 211 chunks (12.4 KB).
  - Images are served as WebP, about half the size of JPEG.
  - Repeated icons are an inline SVG sprite: −165 KB (14.2%) on a profile and −340 KB on a thread.
  - Structured data dedupes URLs and text: −450 KB (13%).
- **Server:** event loops were busy 67% at the median and 84% at p95, so a 1 s timeout fired on 1–9% of renders against a 25 ms upstream. The fixes were more workers and running independent requests in parallel instead of serially (guest token alongside feature flags).
- **Measurement:**
  - Lighthouse CI runs on every PR, desktop and mobile, against fixed pages.
  - Changes are measured on production builds behind a latency proxy, with regressions reported next to gains.
  - For the post they used 11 interleaved pairs per page and marked a change only when the 95% bootstrap CI excluded zero.
  - The main metric is time to first post, because FCP flatters a splash screen.
  - Field data (LCP, INP, CLS, FCP, TTFB) goes to perftown.
- **Agents:** 5 engineers plus agents built the first version in under 6 months.
  - A root AGENTS.md sets the rules: named exports, no barrels, validation at trust boundaries, and nothing committed until lint, typecheck and tests pass.
  - The repo holds 25+ skills (commits, stacked PRs, review, CI shepherding, deps, i18n, Relay/router).
  - Custom oxlint plugins include "anti-slop": no chained type assertions, no `unknown` params, no conditional empty spreads.
  - Pre-commit formats, lints and type-checks. Pre-push lints the packages that import the changed code.
  - The old servers served as executable specs, with a parity script diffing what crawlers read.
- **Rollout:** the edge routes by path list (published from the route tree on each deploy) plus a feature switch. Rollout goes country by country with an A/B on real traffic, and anyone can be moved back instantly.

## How it maps to coding.sh

| X practice | coding.sh site (apps/site) | coding.sh viewer (`coding.sh ui`) | coding.sh product |
|---|---|---|---|
| Content in the first response | Static Astro already ships HTML. Check that no island blocks first paint and that demo content renders without JS. | Server-render the first page of sessions and the selected session into the HTML. Embed the API JSON once and replay it into the client cache. Keep unread responses for 30 s. | — |
| Stylesheet first, async entry | Inline critical CSS or load it first, and start scripts after the CSS. | Same | — |
| Fewer startup files | Count startup requests and pack shared chunks. | Pack into 3 chunks. | — |
| Intent preload (hover/focus, 100 ms rest) | Astro prefetch on hover for docs and nav. | Preload session detail on 100 ms rest or press. | — |
| SVG sprite for repeated icons | Use it if icons repeat (logos strip, cube marks). | Event-row icons | — |
| Crawler doc lean, under 2 MB | Check the sitemap, canonical, JSON-LD, hreflang and real 404 on docs. Keep OG/link-preview tags complete. | n/a | — |
| Time-to-first-content metric, not FCP | Measure "first viewer row visible" with a custom mark. | "First session row" mark | Metric scripts in `exp`/bench (RB-1) |
| 11 interleaved pairs + 95% bootstrap CI excludes 0 | Every perf change on the site is gated through `coding.sh exp`. | Same | This is our bench method: continuous metrics, interleaving, CI verdict |
| Lighthouse CI on PRs with budgets | GitHub Action with budgets | — | `coding.sh` perf recipe in docs |
| AGENTS.md + repo skills + anti-slop lint + pre-commit | — | — | Dogfood in this repo (Q items below), and mine "agent slop" patterns from traces as a grader |
| Old system as executable spec + parity script | — | — | `compare` / tool-evals parity mode |

Queue items derived from this live under "Round 2 additions (X rewrite)" in tasks/research-queue.md.
