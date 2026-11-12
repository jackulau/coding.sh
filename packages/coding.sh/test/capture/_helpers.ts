// Shared test helpers for capture/snapshot tests. Every test works in throwaway
// dirs under os.tmpdir() with an isolated CODING_SH_HOME and git config.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

export const PKG_ROOT = realpathSync(join(import.meta.dirname, "..", ".."));

const cleanup: string[] = [];

export function tmp(prefix = "csh-test-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(d);
  return d;
}

export function removeTmp(): void {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
}

/**
 * What the agent or host app running the tests may have set, and the hook reads: an eval run, a
 * host app's thread, a parent agent's session, a model base URL. Left in, they send hook.sh to
 * hook.mjs and add fields to the spool line, so a suite run inside an agent fails where CI passes.
 */
export const CALLER_ENV = [
  "CODING_SH_RUN_ID", "T3CODE_THREAD_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_TOOL_CALL_ID",
  "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE",
  "LITELLM_PROXY_API_BASE", "LITELLM_PROXY_URL", "LITELLM_BASE_URL", "PORTKEY_GATEWAY_URL", "RAMP_ROUTER_BASE_URL",
  "TFY_GATEWAY_URL", "KONG_PROXY_URL", "BIFROST_URL", "BIFROST_BASE_URL", "CLIPROXYAPI_URL",
];

/** `env` without the caller's variables (CALLER_ENV). */
export function withoutCallerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of CALLER_ENV) delete out[k];
  return out;
}

/** Isolate git config and coding.sh data dir for this test process. Returns CODING_SH_HOME. */
export function isolate(): string {
  const base = tmp("csh-home-");
  const gitconfig = join(base, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.CODING_SH_HOME = join(base, "home");
  delete process.env.CODING_SH_DISABLE;
  for (const k of CALLER_ENV) delete process.env[k];
  return process.env.CODING_SH_HOME;
}

export function sh(cwd: string, cmd: string, args: string[], input?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1 << 28 });
}

export function gitc(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", args).replace(/\n$/, "");
}

export function write(root: string, files: Record<string, string>): void {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
}

/** New repo with `files` committed (no commit when files is undefined). */
export function makeRepo(files?: Record<string, string>): string {
  const root = tmp("csh-repo-");
  gitc(root, "init", "-q", "-b", "main");
  if (files) {
    write(root, files);
    gitc(root, "add", "-A");
    gitc(root, "commit", "-q", "-m", "init");
  }
  return root;
}

/** relative path → sha256 of content (symlinks: "link:<target>") for every file under dir, skipping .git. */
export function treeHash(dir: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      const rel = relative(dir, abs);
      if (rel === ".git" || rel.startsWith(".git/") || skip(rel)) continue;
      if (e.isDirectory()) walk(abs);
      else if (e.isSymbolicLink()) out[rel] = "link";
      else out[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex") + ((statSync(abs).mode & 0o111) !== 0 ? "+x" : "");
    }
  };
  walk(dir);
  return out;
}

/** Fingerprint of everything in a .git dir: path → size+content hash (objects: path only). */
export function gitDirFingerprint(gitDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      const rel = relative(gitDir, abs);
      if (e.isDirectory()) walk(abs);
      else out[rel] = rel.startsWith("objects/") ? "obj" : createHash("sha256").update(readFileSync(abs)).digest("hex");
    }
  };
  walk(gitDir);
  return out;
}

/** Node args to run a .ts file in a child process. */
export function tsNodeArgs(): string[] {
  const f = (process.features as { typescript?: string | false }).typescript;
  return f ? ["--no-warnings"] : ["--no-warnings", "--experimental-strip-types"];
}
