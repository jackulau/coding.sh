// Shared fakes for update tests: a temp HOME/CODING_SH_HOME, a routed fetch
// that counts calls, and a release payload shaped like GitHub's.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fresh env whose HOME and CODING_SH_HOME live in a temp dir. No CI, no opt-outs. */
export function tmpEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "csh-update-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  return { HOME: home, USERPROFILE: home, CODING_SH_HOME: join(home, ".coding.sh"), PATH: process.env.PATH, ...extra };
}

export function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const v = tag.replace(/^v/, "");
  return {
    tag_name: tag,
    html_url: `https://github.com/jackulau/coding.sh/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    body: "## What's new\n- things",
    assets: [{ name: `coding.sh-${v}.tgz`, browser_download_url: `https://github.com/jackulau/coding.sh/releases/download/${tag}/coding.sh-${v}.tgz` }],
    ...extra,
  };
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: string[];
}

/** Routes by URL substring; unmatched URLs answer 404. A thrown value simulates a network error. */
export function fakeFetch(routes: Record<string, unknown | ((url: string) => unknown)>): FakeFetch {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    for (const [k, v] of Object.entries(routes)) {
      if (!url.includes(k)) continue;
      const body = typeof v === "function" ? (v as (u: string) => unknown)(url) : v;
      if (body instanceof Error) throw body;
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export const GH = "/repos/jackulau/coding.sh/releases/latest";
export const NPM = "registry.npmjs.org/coding.sh/latest";

export function clock(start = Date.UTC(2026, 10, 6, 12)): { now: () => number; advance(ms: number): void; set(t: number): void } {
  let t = start;
  return { now: () => t, advance: (ms) => void (t += ms), set: (v) => void (t = v) };
}

export function ttyStream(isTTY = true): { write(s: string): boolean; isTTY: boolean; text: string } {
  const s = { isTTY, text: "", write: (x: string) => ((s.text += x), true) };
  return s;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
