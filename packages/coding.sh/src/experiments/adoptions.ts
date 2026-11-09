// Adoption memory for `exp sweep --guard prior` (AB-1): each sweep that ends
// in "ship" appends the dataset it was tuned on to an append-only
// adoptions.jsonl next to the eval store, so later sweeps can re-run every
// earlier suite before adopting a new winner.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Adoption {
  dataset: string;
  name: string;
  version: string;
  /** The adopted config's name. */
  config: string;
  /** taskKey of the adopted config (aa.ts). */
  taskKey: string;
  /** The sweep's name. */
  sweep: string;
  at: number;
}

const file = (root: string) => join(root, "adoptions.jsonl");

export async function appendAdoption(root: string, a: Adoption): Promise<void> {
  await mkdir(root, { recursive: true });
  await appendFile(file(root), JSON.stringify(a) + "\n");
}

/** Every adoption, oldest first; unreadable lines are skipped. */
export async function listAdoptions(root: string): Promise<Adoption[]> {
  let text: string;
  try {
    text = await readFile(file(root), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: Adoption[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Adoption;
      if (v && typeof v.dataset === "string") out.push(v);
    } catch {
      // a torn last line from a crash: skip it
    }
  }
  return out;
}

/** Distinct datasets (by id) with a shipped adoption, except `exclude`, in first-adopted order. */
export function priorDatasets(adoptions: readonly Adoption[], exclude: string): string[] {
  const out: string[] = [];
  for (const a of adoptions) if (a.dataset !== exclude && !out.includes(a.dataset)) out.push(a.dataset);
  return out;
}
