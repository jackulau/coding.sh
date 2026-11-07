// Adapter registry: every supported agent, in display order. Third-party
// adapters can be appended by the CLI at startup; ids must be unique.
import type { Adapter, DetectResult } from "../core/types.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { MORE_ADAPTERS } from "./more/index.ts";
import { opencode } from "./opencode.ts";
import { t3code } from "./t3code.ts";

function dedupe(list: Adapter[]): Adapter[] {
  const seen = new Set<string>();
  return list.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

export const ADAPTERS: Adapter[] = dedupe([claudeCode, codex, opencode, cursor, t3code, ...MORE_ADAPTERS]);

export function getAdapter(id: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export interface DetectedAdapter {
  adapter: Adapter;
  result: DetectResult;
}

/** Runs every adapter's detect() in parallel; a failing detect reports "not installed" with a note. */
export async function detectAll(adapters: Adapter[] = ADAPTERS): Promise<DetectedAdapter[]> {
  return Promise.all(
    adapters.map(async (adapter) => {
      try {
        return { adapter, result: await adapter.detect() };
      } catch (e) {
        return { adapter, result: { installed: false, hooked: false, notes: [`detect failed: ${e instanceof Error ? e.message : String(e)}`] } };
      }
    }),
  );
}

export { claudeCode, codex, cursor, opencode, t3code };
