// Loads a generated Amp plugin / Pi extension (TypeScript, run with Node type stripping)
// against a fake host, fires events, and collects what the fake hook received.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Handler = (e: unknown, ctx?: unknown) => unknown;

/** A hook.mjs stand-in that writes {argv, stdin} to <dir>/<n>.json. */
export function fakeHook(dir: string): string {
  const p = join(dir, "hook.mjs");
  writeFileSync(
    p,
    `import { writeFileSync } from "node:fs";
let body = "";
process.stdin.on("data", (d) => (body += d));
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(dir)} + "/call-" + process.hrtime.bigint() + ".json", JSON.stringify({ argv: process.argv.slice(2), stdin: JSON.parse(body) }));
});
`,
  );
  return p;
}

export function hookCalls(dir: string): { argv: string[]; stdin: Record<string, unknown> }[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith("call-"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

/** Import the plugin file and register its handlers on a fake host. */
export async function loadPlugin(file: string, host: Record<string, unknown>): Promise<Map<string, Handler[]>> {
  const handlers = new Map<string, Handler[]>();
  const api = {
    ...host,
    on(event: string, h: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
    },
  };
  const mod = await import(pathToFileURL(file).href);
  mod.default(api);
  return handlers;
}

export async function fire(handlers: Map<string, Handler[]>, event: string, e: unknown, ctx?: unknown): Promise<void> {
  for (const h of handlers.get(event) ?? []) await h(e, ctx);
}

export async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for hook calls");
    await new Promise((r) => setTimeout(r, 25));
  }
}
