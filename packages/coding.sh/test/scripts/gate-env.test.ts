import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { AGENT_HOME_KEYS } from "../_agent-env.ts";

const PKG = join(import.meta.dirname, "..", "..");
const REPO = join(PKG, "..", "..");
const ADAPTERS = join(PKG, "src", "adapters");

const { isolatedEnv } = (await import(pathToFileURL(join(REPO, "scripts", "gate.mjs")).href)) as {
  isolatedEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; dir: string };
};

const temps: string[] = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** Every variable name the adapters read: env.NAME, process.env.NAME, and the XDG names xdg() looks up by string. */
function adapterEnvReads(): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of sources(ADAPTERS)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b|"(XDG_[A-Z]+_HOME)"/g)) {
      const name = m[1] ?? m[2]!;
      if (!names.has(name)) names.set(name, relative(PKG, file));
    }
  }
  return names;
}

/** CI and CODING_SH_* are coding.sh's own switches; PATH and PATHEXT find binaries, not data. */
const NOT_A_HOME = (name: string) => name === "CI" || name.startsWith("CODING_SH_") || name === "PATH" || name === "PATHEXT";

test("the gate's isolated env sets every agent home variable the adapters read under its throwaway dir, or unsets it", () => {
  const real = join(REPO, "real-profile-not-touched");
  const reads = adapterEnvReads();
  assert.ok(reads.has("APPDATA") && reads.has("GEMINI_CLI_HOME"), "the scan finds the adapters' reads");
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const name of reads.keys()) if (!NOT_A_HOME(name)) base[name] = join(real, name);
  const { env, dir } = isolatedEnv(base);
  temps.push(dir);
  const leaks = [...reads]
    .filter(([name]) => !NOT_A_HOME(name) && env[name] !== undefined && !env[name]!.startsWith(dir))
    .map(([name, file]) => `${name} (read in ${file})`);
  assert.deepEqual(leaks, [], "these still point outside the gate's temp dir");
});

test("the shared agent home list names every variable the adapters read", () => {
  for (const [name, file] of adapterEnvReads()) {
    if (NOT_A_HOME(name)) continue;
    assert.ok(AGENT_HOME_KEYS.includes(name), `${name} (read in ${file}) is missing from AGENT_HOME_KEYS in test/_agent-env.ts`);
  }
});

test("the gate's directory variables match the adapters' defaults under the throwaway home", () => {
  const { env, dir } = isolatedEnv({ PATH: process.env.PATH });
  temps.push(dir);
  assert.equal(env.GEMINI_CLI_HOME, env.HOME);
  assert.equal(env.APPDATA, join(env.HOME!, "AppData", "Roaming"));
  assert.equal(env.XDG_CONFIG_HOME, join(env.HOME!, ".config"));
  assert.equal(env.GEMINI_HOME, undefined);
  for (const k of ["OPENCODE_DB", "PI_CODING_AGENT_SESSION_DIR"]) assert.equal(env[k], undefined, `${k} is unset`);
});
