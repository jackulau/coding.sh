// The one function that talks to the network for update checks.
//
// It runs in two places: in-process (`coding.sh update`, the viewer, the MCP
// server) and in a detached `node -e` child that `scheduleUpdateCheck` spawns
// with this function's source text, so a command never waits on the network.
// That second use is why the body must stay self-contained: no references to
// imports or other module-level names, only globals and dynamic `import()` of
// node: builtins. test/update/refresh.test.ts runs it out-of-process to keep
// that true.

export interface RefreshArgs {
  /** Cache file to read and rewrite (paths(env).root/update.json). */
  file: string;
  /** Version of the running CLI. */
  current: string;
  /** "owner/name" on GitHub. */
  repo: string;
  /** npm package name for the fallback lookup. */
  npmName: string;
  githubApi: string;
  npmRegistry: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Clock override (tests). */
  now?: number;
  /** User-Agent header (GitHub's API rejects requests without one). */
  userAgent: string;
}

export interface UpdateCache {
  /** Last successful check (epoch ms). */
  checkedAt?: number;
  /** Last attempt, successful or not (epoch ms); throttles retries. */
  attemptedAt?: number;
  latest?: string;
  /** CLI version at the time of the check. */
  current?: string;
  /** Release page / changelog. */
  url?: string;
  /** What `npm install -g` installs: a release tarball URL or `name@version`. */
  install?: string;
  source?: "github" | "npm";
  /** Release notes (untrusted text, truncated). */
  notes?: string;
  /** Why the last attempt failed. */
  error?: string;
  /**
   * What kind of failure `error` is: "no_release" when GitHub and npm both
   * answered HTTP 404 (nothing published yet), "network" when a request threw or
   * timed out, "bad_response" for any other status or an unusable body.
   */
  errorKind?: "network" | "no_release" | "bad_response";
  /** Last update notice shown on the terminal. */
  notified?: { version: string; at: number };
}

/** Fetches the latest release and rewrites the cache file. Never throws; returns the new cache. */
export async function refreshUpdateCache(a: RefreshArgs, fetchImpl: typeof fetch = globalThis.fetch): Promise<UpdateCache> {
  const now = typeof a.now === "number" ? a.now : Date.now();
  const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
  const version = (v: unknown): string | undefined =>
    typeof v === "string" && VERSION_RE.test(v.trim()) ? v.trim().replace(/^v/, "").replace(/\+.*$/, "") : undefined;
  const httpsUrl = (v: unknown): string | undefined => (typeof v === "string" && /^https:\/\/[^\s]+$/.test(v) ? v : undefined);
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  // getJson tags its errors; anything untagged (bad tag, foreign package) is a bad response.
  const kind = (e: unknown): string => {
    const k = (e as { kind?: unknown } | null)?.kind;
    return typeof k === "string" ? k : "bad_response";
  };

  let prev: UpdateCache = {};
  let fsp: typeof import("node:fs/promises") | undefined;
  try {
    fsp = await import("node:fs/promises");
    const parsed = JSON.parse(await fsp.readFile(a.file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prev = parsed as UpdateCache;
  } catch {
    // missing or corrupt cache: start fresh
  }

  const getJson = async (url: string): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Accept: "application/vnd.github+json, application/json", "User-Agent": a.userAgent },
        signal: AbortSignal.timeout(a.timeoutMs),
      });
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { kind: "network" });
    }
    if (!res.ok) throw Object.assign(new Error(`${url} returned HTTP ${res.status}`), { kind: res.status === 404 ? "no_release" : "bad_response" });
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${url} returned an unexpected body`);
    return body as Record<string, unknown>;
  };

  let found: Partial<UpdateCache> | undefined;
  const errors: string[] = [];
  const kinds: string[] = [];
  try {
    // releases/latest already skips drafts and prereleases.
    const r = await getJson(`${a.githubApi}/repos/${a.repo}/releases/latest`);
    const tag = typeof r.tag_name === "string" ? r.tag_name.trim() : "";
    const latest = version(tag);
    if (!latest || r.draft === true || r.prerelease === true) throw new Error(`latest release tag ${JSON.stringify(tag)} is not a version`);
    const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
    const asset = assets.find((x) => x && x.name === `coding.sh-${latest}.tgz`) ?? assets.find((x) => x && typeof x.name === "string" && x.name.endsWith(".tgz"));
    found = {
      latest,
      source: "github",
      url: httpsUrl(r.html_url) ?? `https://github.com/${a.repo}/releases/tag/${encodeURIComponent(tag)}`,
      // Same artifact install.sh installs.
      install: httpsUrl(asset?.browser_download_url) ?? `https://github.com/${a.repo}/releases/download/${encodeURIComponent(tag)}/coding.sh-${latest}.tgz`,
    };
    if (typeof r.body === "string" && r.body.trim()) found.notes = r.body.slice(0, 4000);
  } catch (e) {
    errors.push(`GitHub: ${message(e)}`);
    kinds.push(kind(e));
    try {
      // Fallback for an npm-published build. The manifest must point back at our
      // repository, so a different package squatting the name is never offered.
      const m = await getJson(`${a.npmRegistry}/${encodeURIComponent(a.npmName)}/latest`);
      const latest = version(m.version);
      const repo = m.repository;
      const repoUrl = typeof repo === "string" ? repo : repo && typeof repo === "object" ? (repo as { url?: unknown }).url : undefined;
      if (!latest) throw new Error("no version in the latest manifest");
      if (typeof repoUrl !== "string" || !repoUrl.toLowerCase().includes(a.repo.toLowerCase())) throw new Error(`package ${a.npmName} does not come from ${a.repo}`);
      found = { latest, source: "npm", url: `https://www.npmjs.com/package/${a.npmName}/v/${latest}`, install: `${a.npmName}@${latest}` };
    } catch (e2) {
      errors.push(`npm: ${message(e2)}`);
      kinds.push(kind(e2));
    }
  }

  // Both sources answering 404 is not a connection problem: nothing has been published yet.
  const errorKind: UpdateCache["errorKind"] = kinds.includes("network") ? "network" : kinds.every((k) => k === "no_release") ? "no_release" : "bad_response";
  const next: UpdateCache = found
    ? { ...found, checkedAt: now, attemptedAt: now, current: a.current, ...(prev.notified ? { notified: prev.notified } : {}) }
    : { ...prev, attemptedAt: now, current: a.current, error: errors.join("; "), errorKind };

  try {
    fsp ??= await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await fsp.mkdir(dirname(a.file), { recursive: true });
    const tmp = `${a.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await fsp.rename(tmp, a.file);
  } catch {
    // read-only home: the result still reaches in-process callers
  }
  return next;
}
