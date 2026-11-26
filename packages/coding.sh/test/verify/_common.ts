// Shared by the checks in this folder: the model bound a check reads. It imports nothing.

/** CODING_SH_MODEL_BOUND as a whole number. `raw` is the variable's value; unset counts as 0. */
export function modelBound(raw: string | undefined): number {
  const text = raw ?? "0";
  const extra = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(extra)) throw new Error(`CODING_SH_MODEL_BOUND must be a whole number, not ${text}`);
  return extra;
}
