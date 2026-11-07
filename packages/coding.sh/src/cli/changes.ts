// Rendering FileChange plans for --dry-run: the exact edits, as unified diffs.
import type { FileChange } from "../core/types.ts";
import type { Output } from "./output.ts";

/** Minimal unified diff (LCS over lines) with 2 lines of context. */
export function unifiedDiff(before: string, after: string, context = 2): string[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((l) => `-${l}`), ...b.map((l) => `+${l}`)];
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: { t: " " | "-" | "+"; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: " ", s: a[i++]! }), j++;
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: "-", s: a[i++]! });
    else ops.push({ t: "+", s: b[j++]! });
  }
  while (i < n) ops.push({ t: "-", s: a[i++]! });
  while (j < m) ops.push({ t: "+", s: b[j++]! });
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, k) => {
    if (o.t === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = 1;
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach((o, k) => {
    if (!keep[k]) {
      gap = true;
      return;
    }
    if (gap && out.length) out.push("@@");
    gap = false;
    out.push(`${o.t}${o.s}`);
  });
  return out;
}

export function changeJson(c: FileChange): Record<string, unknown> {
  return { path: c.path, action: c.action, summary: c.summary, before: c.before ?? null, after: c.after ?? null };
}

/** Prints planned changes on stdout (they are the answer of a dry run). */
export function printChanges(out: Output, changes: readonly FileChange[], heading?: string): void {
  for (const c of changes) {
    out.print(`${out.style(c.action, "bold")} ${c.path}${heading ? `  (${heading})` : ""}`);
    out.print(`  ${c.summary}`);
    if (c.before !== undefined || c.after !== undefined) {
      for (const l of unifiedDiff(c.before ?? "", c.after ?? "")) {
        const styled = l.startsWith("+") ? out.style(l, "green") : l.startsWith("-") ? out.style(l, "red") : l;
        out.print(`    ${styled}`);
      }
    }
    out.print();
  }
}
