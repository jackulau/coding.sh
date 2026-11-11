// coding.sh compare --parity <a> <b>: what a crawler reads from two pages, side by side.
//
// Each side is a URL (fetched the way a crawler does: no cookies, redirects followed one hop at a
// time and recorded) or a shell command whose stdout is the page. Compared: status, the redirect
// chain, title, description, canonical, robots (meta and X-Robots-Tag), Open Graph and Twitter card
// tags, the hreflang alternate count, JSON-LD types and the html lang. A URL that points at the
// side's own origin is compared by its path, so a staging copy and production read the same when
// each one's canonical names its own host. Exit 0 when the pages read the same, 1 when they differ.
import { spawn } from "node:child_process";
import { CliError, clean } from "../output.ts";
import { str } from "../common.ts";
import { UsageError } from "../args.ts";
import type { CommandContext } from "../types.ts";

export const PARITY_USER_AGENT = "Mozilla/5.0 (compatible; coding.sh-parity/1; +https://coding.sh)";
const MAX_REDIRECTS = 10;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** What a crawler reads from one page. Absent fields: the page has none. */
export interface PageRead {
  status?: number;
  /** Each hop before the final page: its status and where it pointed. */
  redirects: { status: number; location: string }[];
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  xRobotsTag?: string;
  /** og:* and twitter:* tags, by property name. */
  social: Record<string, string>;
  hreflang: number;
  jsonLdTypes: string[];
  /** ld+json scripts that did not parse. */
  jsonLdErrors: number;
  lang?: string;
}

export interface ParitySide {
  input: string;
  /** The URL the page was finally read from (a command: absent). */
  finalUrl?: string;
  /** A command's exit code. */
  exitCode?: number;
  page: PageRead;
}

export interface ParityDiff {
  field: string;
  a: string | number | string[] | null;
  b: string | number | string[] | null;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  laquo: "\u00ab", raquo: "\u00bb", middot: "\u00b7", bull: "\u2022", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", times: "\u00d7", rarr: "\u2192", larr: "\u2190",
  eacute: "\u00e9", egrave: "\u00e8", agrave: "\u00e0", aacute: "\u00e1", uuml: "\u00fc", ouml: "\u00f6", auml: "\u00e4", szlig: "\u00df", ntilde: "\u00f1", ccedil: "\u00e7",
};
const decode = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const squash = (s: string): string => decode(s).replace(/\s+/g, " ").trim();

/** The attributes of one start tag (`<meta name="x" content='y'>`), names lowercased. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<\s*[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/**
 * The rest of a start tag after its name, up to the closing '>'. A quoted attribute value is
 * skipped whole, so a raw '>' in it (content="a > b") does not end the tag. A quote opens a
 * value only after '=': an apostrophe in an unquoted value is plain text.
 */
const TAG_REST = String.raw`(?:=\s*(?:"[^"]*"|'[^']*')|=(?!\s*["'])|[^>=])*`;
const TITLE = new RegExp(String.raw`<title\b${TAG_REST}>([\s\S]*?)<\/title\s*>`, "i");
const SCRIPT = new RegExp(String.raw`<script\b(${TAG_REST})>([\s\S]*?)<\/script\s*>`, "gi");

const tags = (html: string, name: string): Record<string, string>[] => [...html.matchAll(new RegExp(`<${name}\\b${TAG_REST}>`, "gi"))].map((m) => attrs(m[0]));

/** Every top-level JSON-LD entity's @type (entries of an @graph count as top level). */
function ldTypes(doc: unknown, into: Set<string>): void {
  if (Array.isArray(doc)) {
    for (const x of doc) ldTypes(x, into);
    return;
  }
  if (typeof doc !== "object" || doc === null) return;
  const o = doc as Record<string, unknown>;
  const t = o["@type"];
  for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string" && x) into.add(x);
  if (o["@graph"] !== undefined) ldTypes(o["@graph"], into);
}

/** What a crawler reads from the HTML. `base` resolves relative canonical links. */
export function readPage(html: string, base?: string): Omit<PageRead, "status" | "redirects" | "xRobotsTag"> {
  // Comments hide tags from crawlers too.
  const doc = html.replace(/<!--[\s\S]*?-->/g, "");
  const page: Omit<PageRead, "status" | "redirects" | "xRobotsTag"> = { social: {}, hreflang: 0, jsonLdTypes: [], jsonLdErrors: 0 };
  const title = TITLE.exec(doc);
  if (title) page.title = squash(title[1]!);
  const resolve = (href: string): string => {
    try {
      return base ? new URL(href, base).href : href;
    } catch {
      return href;
    }
  };
  for (const m of tags(doc, "meta")) {
    const name = (m.name ?? "").toLowerCase();
    const prop = (m.property ?? "").toLowerCase();
    const content = squash(m.content ?? "");
    if (name === "description" && page.description === undefined) page.description = content;
    else if (name === "robots" && page.robots === undefined) page.robots = content;
    const key = prop.startsWith("og:") || prop.startsWith("twitter:") ? prop : name.startsWith("twitter:") || name.startsWith("og:") ? name : undefined;
    if (key && !(key in page.social)) page.social[key] = content;
  }
  for (const l of tags(doc, "link")) {
    const rel = (l.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("canonical") && page.canonical === undefined && l.href !== undefined) page.canonical = resolve(l.href.trim());
    if (rel.includes("alternate") && l.hreflang) page.hreflang++;
  }
  const types = new Set<string>();
  for (const m of doc.matchAll(SCRIPT)) {
    if ((attrs(`<script${m[1]}>`).type ?? "").toLowerCase().trim() !== "application/ld+json") continue;
    try {
      ldTypes(JSON.parse(m[2]!), types);
    } catch {
      page.jsonLdErrors++;
    }
  }
  page.jsonLdTypes = [...types].sort();
  const html0 = tags(doc, "html")[0];
  if (html0?.lang) page.lang = html0.lang;
  return page;
}

/** Fetches a URL as a crawler: redirects one hop at a time, recorded; the final page read. */
export async function fetchSide(url: string, userAgent = PARITY_USER_AGENT): Promise<ParitySide> {
  const redirects: PageRead["redirects"] = [];
  let at = url;
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(at, { redirect: "manual", headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const timedOut = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
      throw new CliError(timedOut ? `${at} did not answer within ${TIMEOUT_MS / 1000} s` : `Couldn't fetch ${at}: ${cause?.code ?? cause?.message ?? (e as Error).message}`, { reason: timedOut ? "timeout" : "fetch_failed", exitCode: 2, next: ["Check the URL is up, then run again"] });
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      const next = new URL(location, at).href;
      redirects.push({ status: res.status, location: next });
      if (hop + 1 >= MAX_REDIRECTS) throw new CliError(`${url} redirects more than ${MAX_REDIRECTS} times`, { reason: "redirect_loop", exitCode: 2 });
      at = next;
      continue;
    }
    const html = await boundedText(res);
    const xrt = res.headers.get("x-robots-tag");
    return { input: url, finalUrl: at, page: { status: res.status, redirects, ...(xrt ? { xRobotsTag: xrt } : {}), ...readPage(html, at) } };
  }
}

async function boundedText(res: Response): Promise<string> {
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    n += chunk.byteLength;
    if (n >= MAX_BYTES) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs a shell command; its stdout is the page. */
export function commandSide(cmd: string, env: NodeJS.ProcessEnv, cwd: string): Promise<ParitySide> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, env, cwd, stdio: ["ignore", "pipe", "pipe"], timeout: TIMEOUT_MS });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => reject(new CliError(`Couldn't run ${JSON.stringify(cmd)}: ${e.message}`, { reason: "command_failed", exitCode: 2 })));
    child.on("close", (code, signal) => {
      const html = Buffer.concat(out).toString("utf8");
      if (child.killed && signal) {
        reject(new CliError(`${JSON.stringify(cmd)} did not finish within ${TIMEOUT_MS / 1000} s`, { reason: "timeout", exitCode: 2 }));
        return;
      }
      if (code !== 0 && !html.trim()) {
        reject(new CliError(`${JSON.stringify(cmd)} exited ${code} and printed no page${err.trim() ? `: ${oneLine(err)}` : ""}`, { reason: "command_failed", exitCode: 2 }));
        return;
      }
      resolve({ input: cmd, exitCode: code ?? -1, page: { redirects: [], ...readPage(html) } });
    });
  });
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** A URL on the side's own origin, as its path; anything else as is. */
function local(v: string | undefined, origins: readonly string[]): string | undefined {
  if (v === undefined) return undefined;
  try {
    const u = new URL(v);
    if (origins.includes(u.origin)) return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    // not a URL: compared as written
  }
  return v;
}

function origins(s: ParitySide): string[] {
  const out = new Set<string>();
  for (const u of [s.input, s.finalUrl]) {
    try {
      if (u && isUrl(u)) out.add(new URL(u).origin);
    } catch {
      // a command
    }
  }
  return [...out];
}

/** The fields a crawler reads, in order, comparable across the two sides. */
export function parityFields(s: ParitySide): [string, string | number | string[] | null][] {
  const o = origins(s);
  const p = s.page;
  const out: [string, string | number | string[] | null][] = [
    ["status", p.status ?? null],
    ["redirects", p.redirects.length ? p.redirects.map((r) => `${r.status} ${local(r.location, o)}`).join(" → ") : null],
    ["title", p.title ?? null],
    ["description", p.description ?? null],
    ["canonical", local(p.canonical, o) ?? null],
    ["robots", p.robots ?? null],
    ["x-robots-tag", p.xRobotsTag ?? null],
  ];
  return out.concat([
    ["hreflang", p.hreflang],
    ["jsonld", p.jsonLdTypes],
    ["jsonld-errors", p.jsonLdErrors],
    ["lang", p.lang ?? null],
  ]);
}

const URL_SOCIAL = new Set(["og:url", "og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:url"]);

/** Every field that reads differently, in crawler order; empty when the pages are at parity. */
export function diffParity(a: ParitySide, b: ParitySide): ParityDiff[] {
  // A command prints a page and has no HTTP status: with one on a side, status is not compared.
  const statusless = a.page.status === undefined || b.page.status === undefined;
  const fa = parityFields(a).filter(([f]) => !(statusless && f === "status"));
  const fb = new Map(parityFields(b));
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const diffs: ParityDiff[] = [];
  for (const [field, va] of fa) {
    const vb = fb.get(field) ?? null;
    if (!same(va, vb)) diffs.push({ field, a: va, b: vb });
  }
  const oa = origins(a);
  const ob = origins(b);
  const social = (s: ParitySide, o: string[], k: string) => (s.page.social[k] === undefined ? null : URL_SOCIAL.has(k) ? local(s.page.social[k], o)! : s.page.social[k]!);
  const keys = [...new Set([...Object.keys(a.page.social), ...Object.keys(b.page.social)])].sort((x, y) => (x.startsWith("og:") === y.startsWith("og:") ? x.localeCompare(y) : x.startsWith("og:") ? -1 : 1));
  // Social tags sit after robots, in their own order: og:*, then twitter:*.
  const at = diffs.findIndex((d) => ["hreflang", "jsonld", "jsonld-errors", "lang"].includes(d.field));
  const socialDiffs: ParityDiff[] = [];
  for (const k of keys) {
    const va = social(a, oa, k);
    const vb = social(b, ob, k);
    if (va !== vb) socialDiffs.push({ field: k, a: va, b: vb });
  }
  diffs.splice(at === -1 ? diffs.length : at, 0, ...socialDiffs);
  // Two error pages read the same and say nothing: that is not parity.
  const sa = a.page.status;
  const sb = b.page.status;
  if (sa !== undefined && sb !== undefined && sa >= 500 && sb >= 500 && !diffs.some((d) => d.field === "status")) diffs.unshift({ field: "status", a: `${sa} (server error)`, b: `${sb} (server error)` });
  return diffs;
}

const show = (v: ParityDiff["a"]): string => (v === null ? "-" : Array.isArray(v) ? (v.length ? v.join(", ") : "-") : String(v));

export async function run(c: CommandContext): Promise<number> {
  const { out } = c;
  const [ra, rb] = c.positionals;
  if (!ra?.trim() || !rb?.trim()) throw new UsageError("--parity needs two pages: coding.sh compare --parity <urlA|cmdA> <urlB|cmdB>", { reason: "missing_argument" });
  const ua = str(c.flags["user-agent"]) ?? PARITY_USER_AGENT;
  const read = (x: string) => (isUrl(x) ? fetchSide(x, ua) : commandSide(x, c.env, c.cwd));
  const [a, b] = await Promise.all([read(ra), read(rb)]);
  const diffs = diffParity(a, b);
  const fields = parityFields(a).filter(([f]) => f !== "status" || (a.page.status !== undefined && b.page.status !== undefined)).length + new Set([...Object.keys(a.page.social), ...Object.keys(b.page.social)]).size;
  if (out.json) {
    out.data({ parity: diffs.length === 0, a, b, diffs });
    return diffs.length ? 1 : 0;
  }
  if (!diffs.length) {
    out.print(`Parity: ${fields} fields read the same`);
    return 0;
  }
  const tty = out.stdoutTTY;
  const cell = (v: ParityDiff["a"]) => (tty ? oneLine(clean(show(v))).slice(0, 60) : clean(show(v)).replace(/[\t\n]+/g, " "));
  out.table(["FIELD", "A", "B"], diffs.map((d) => [d.field, cell(d.a), cell(d.b)]));
  out.note(`${diffs.length} of ${fields} fields differ; the rest read the same`);
  return 1;
}
