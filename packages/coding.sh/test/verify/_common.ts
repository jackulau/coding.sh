// Shared by the checks in this folder: the model bound a check reads, and stdin as the hook reads it and
// as a failure message shows it. It imports nothing, so a check that loads it loads none of the hook.

/** CODING_SH_MODEL_BOUND as a whole number. `raw` is the variable's value; unset counts as 0. */
export function modelBound(raw: string | undefined): number {
  const text = raw ?? "0";
  const extra = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(extra)) throw new Error(`CODING_SH_MODEL_BOUND must be a whole number, not ${text}`);
  return extra;
}

/** The stdin text the hook works on: UTF-8, without a leading BOM. */
export function stdinText(stdin: Buffer): string {
  const text = stdin.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** A stdin preview for a failure message: the first and last bytes, escaped. */
export function preview(stdin: Buffer): string {
  const s = JSON.stringify(stdin.toString("latin1"));
  return stdin.length <= 160 ? s : `${JSON.stringify(stdin.subarray(0, 100).toString("latin1"))}…(${stdin.length} bytes)…${JSON.stringify(stdin.subarray(-40).toString("latin1"))}`;
}
