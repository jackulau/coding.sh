// One reader for every "when" the CLI, the query language, the MCP tools and the HTTP API take:
// an age (7d), epoch ms, a calendar day (2026-11-09, today, yesterday) or a date and time.
// A day or a clock time without a zone is read in the caller's zone, so `--since 2026-11-09`
// starts at local midnight, the same instant `--since 2026-11-09T00:00:00` names.

const AGE_UNITS: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
const DAY_WORDS: Record<string, number> = { today: 0, yesterday: 1 };
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

export interface WhenOptions {
  /** "Now", for ages and day words. Default: Date.now(). */
  now?: number;
  /**
   * The zone a day or a clock time without one is read in, as minutes to add to local time to
   * get UTC (Date#getTimezoneOffset: 360 for UTC-6). Default: this process's zone, with its
   * daylight-saving rules. An HTTP caller passes the request's.
   */
  tzOffsetMin?: number;
}

export interface When {
  /** Epoch ms. */
  ms: number;
  /** The value named a day or a clock time without a zone, so the zone decided the instant. */
  zoned: boolean;
}

/** Wall-clock parts in the zone → epoch ms; undefined when the parts are not a real date (2026-02-31). */
function wallClock(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tzOffsetMin: number | undefined): number | undefined {
  if (h > 23 || mi > 59 || s > 59) return undefined;
  if (tzOffsetMin === undefined) {
    const t = new Date(y, mo - 1, d, h, mi, s, ms);
    return t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : undefined;
  }
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.getTime() + tzOffsetMin * 60_000 : undefined;
}

/** Midnight in the zone, `daysAgo` days before the day holding `now`. */
function midnight(now: number, daysAgo: number, tzOffsetMin: number | undefined): number {
  if (tzOffsetMin === undefined) {
    const t = new Date(now);
    return new Date(t.getFullYear(), t.getMonth(), t.getDate() - daysAgo).getTime();
  }
  const t = new Date(now - tzOffsetMin * 60_000);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - daysAgo) + tzOffsetMin * 60_000;
}

/**
 * `7d` (that long ago), epoch ms (12+ digits), `today`, `yesterday`, `2026-11-09` (midnight in
 * the zone), `2026-11-09T08:30` or `2026-11-09 08:30` (that clock time in the zone), or a date
 * and time with `Z` or an offset (that instant). Undefined when it reads as none of these.
 */
export function parseWhen(raw: string, o: WhenOptions = {}): When | undefined {
  const t = raw.trim();
  const now = o.now ?? Date.now();
  const age = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(t);
  if (age) return { ms: now - Number(age[1]) * AGE_UNITS[age[2]!]!, zoned: false };
  if (/^\d{12,}$/.test(t)) return { ms: Number(t), zoned: false };
  const word = DAY_WORDS[t.toLowerCase()];
  if (word !== undefined) return { ms: midnight(now, word, o.tzOffsetMin), zoned: true };
  const m = ISO.exec(t);
  if (!m) return undefined;
  if (m[8]) {
    const zone = /^z$/i.test(m[8]) ? "Z" : m[8].length === 3 ? `${m[8]}:00` : m[8].includes(":") ? m[8] : `${m[8].slice(0, 3)}:${m[8].slice(3)}`;
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}.${(m[7] ?? "0").padEnd(3, "0")}${zone}`);
    return Number.isNaN(ms) ? undefined : { ms, zoned: false };
  }
  const ms = wallClock(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), Number((m[7] ?? "0").padEnd(3, "0")), o.tzOffsetMin);
  return ms === undefined ? undefined : { ms, zoned: true };
}

/** `-06:00` for 360: the UTC offset of a zone given as Date#getTimezoneOffset minutes. */
export function utcOffset(tzOffsetMin: number): string {
  const a = Math.abs(tzOffsetMin);
  return `${tzOffsetMin > 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** `2026-11-09 00:00` in the zone (this process's when none is given). */
export function wallText(ms: number, tzOffsetMin = new Date(ms).getTimezoneOffset()): string {
  return new Date(ms - tzOffsetMin * 60_000).toISOString().slice(0, 16).replace("T", " ");
}
