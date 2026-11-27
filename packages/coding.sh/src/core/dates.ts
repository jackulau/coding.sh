// The Date range: a JavaScript Date holds a time at most 8.64e15 ms either side of 1970. A time read
// from a source that falls outside it is read as missing.

/** The largest time in ms, either side of 1970, that a Date holds. */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/** `ms` when it is in the Date range; undefined when it is past it, NaN, Infinity or undefined. */
export function dateMs(ms: number | undefined): number | undefined {
  return ms !== undefined && Math.abs(ms) <= MAX_DATE_MS ? ms : undefined;
}

/**
 * `durationMs` when the start it gives, `end` less it, is in the Date range; undefined when that
 * start is out of it, or when there is no duration. A caller then places the start at `end`.
 */
export function durationBefore(end: number, durationMs: number | undefined): number | undefined {
  return durationMs !== undefined && dateMs(end - durationMs) !== undefined ? durationMs : undefined;
}
