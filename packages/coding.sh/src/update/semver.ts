// Minimal SemVer 2.0.0 parsing and precedence (https://semver.org/#spec-item-11).
// A leading "v" (git tags) is accepted; build metadata is ignored for ordering.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers ("beta.2" → ["beta", "2"]); empty for a release. */
  prerelease: string[];
}

const RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(input: string): SemVer | undefined {
  const m = RE.exec(input.trim());
  if (!m) return undefined;
  const prerelease = m[4] ? m[4].split(".") : [];
  // Numeric identifiers must not have leading zeros.
  if (prerelease.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

/** Strips a leading "v" and surrounding space: "v1.2.3" → "1.2.3". Undefined when not SemVer. */
export function normalizeVersion(input: string): string | undefined {
  const t = input.trim();
  return parseSemver(t) ? t.replace(/^v/, "").replace(/\+.*$/, "") : undefined;
}

function compareIds(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1; // numeric identifiers sort before alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1, 0 or 1 by SemVer precedence. Throws on input that is not SemVer. */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) throw new TypeError(`not a semantic version: ${JSON.stringify(x ? b : a)}`);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  // A release outranks any of its prereleases.
  if (!x.prerelease.length || !y.prerelease.length) return x.prerelease.length === y.prerelease.length ? 0 : x.prerelease.length ? -1 : 1;
  const n = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < n; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1; // fewer identifiers = lower precedence
    if (q === undefined) return 1;
    const c = compareIds(p, q);
    if (c) return c;
  }
  return 0;
}

/** True when `latest` is a strictly newer version than `current`; false for anything unparseable. */
export function isNewer(latest: string | undefined, current: string | undefined): boolean {
  if (!latest || !current || !parseSemver(latest) || !parseSemver(current)) return false;
  return compareSemver(latest, current) > 0;
}
