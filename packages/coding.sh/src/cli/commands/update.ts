// coding.sh update [--check] [--dry-run]
//
// Checks GitHub for the latest release (always fresh, ignoring the 24 h
// throttle) and installs it the way install.sh does: npm i -g <release tgz>.
// --check only reports; --dry-run prints the install command on stdout.
// Exit codes: 0 ok (updated, up to date, or reported), 1 check or install
// failed, 130 interrupted.
import { spawn } from "node:child_process";
import { version } from "../meta.ts";
import { CliError, clean } from "../output.ts";
import type { CommandContext } from "../types.ts";
import { checkForUpdate, RELEASES_URL, type CheckOptions, type UpdateCache } from "../../update/index.ts";
import { isNewer } from "../../update/semver.ts";

const INSTALL_SCRIPT = "curl -fsSL https://coding.sh/install | sh";
const NPM_FLAGS = ["install", "-g", "--silent", "--no-fund", "--no-audit"];

export interface InstallResult {
  code: number | null;
  /** Combined npm output when it was captured (--json), for the error message. */
  output: string;
}

export interface UpdateDeps {
  check?: (env: NodeJS.ProcessEnv, opts: CheckOptions) => Promise<UpdateCache>;
  install?: (args: string[], opts: { quiet: boolean; signal: AbortSignal; env: NodeJS.ProcessEnv }) => Promise<InstallResult>;
  current?: string;
}

/** The exact install command for a release (what install.sh runs). */
export function installArgs(spec: string): string[] {
  return [...NPM_FLAGS, spec];
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function npmInstall(args: string[], opts: { quiet: boolean; signal: AbortSignal; env: NodeJS.ProcessEnv }): Promise<InstallResult> {
  return new Promise((resolve, reject) => {
    // npm's own output is progress, not the answer: it goes to stderr (or is captured under --json).
    const child = spawn("npm", args, {
      stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", 2, 2],
      env: opts.env,
      shell: process.platform === "win32",
      signal: opts.signal,
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.name === "AbortError") resolve({ code: 130, output });
      else reject(e);
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** The error for a failed check, with a next step that matches why it failed. */
export function checkFailed(cache: UpdateCache, current: string): CliError {
  const data = { current, releases: RELEASES_URL };
  // Set by refreshUpdateCache; undefined for an older cache file or an unexpected local error.
  const kind = cache.errorKind;
  // Both sources answered 404: the network is fine and a reinstall would fail the same way.
  if (kind === "no_release") {
    return new CliError("No coding.sh release has been published yet", { reason: "no_release", next: ["See the releases page:", RELEASES_URL], data });
  }
  return new CliError(`Couldn't check for updates${cache.error ? `: ${clean(cache.error)}` : ""}`, {
    reason: "update_check_failed",
    next: [kind === "network" || kind === undefined ? "Check your connection, or reinstall the latest release:" : "Try again later, or reinstall the latest release:", INSTALL_SCRIPT],
    data,
  });
}

export async function run(c: CommandContext): Promise<number> {
  return runUpdate(c, {});
}

export async function runUpdate(c: CommandContext, deps: UpdateDeps): Promise<number> {
  const { out } = c;
  const dryRun = c.flags["dry-run"] === true;
  const checkOnly = c.flags.check === true;
  const current = deps.current ?? version();

  const spin = out.spin("Checking for updates");
  const cache = await (deps.check ?? checkForUpdate)(c.env, { force: true, current, timeoutMs: 5000 });
  spin.stop();
  if (c.signal.aborted) return 130;

  const latest = cache.latest;
  // A failed refresh keeps the previous result in the cache; only a check from this run counts.
  if (!latest || cache.error) throw checkFailed(cache, current);

  const url = cache.url ?? RELEASES_URL;
  const available = isNewer(latest, current);
  const spec = cache.install;
  const command = spec ? ["npm", ...installArgs(spec)].map(shellQuote).join(" ") : null;
  const base = { current, latest, updateAvailable: available, url, install: spec ?? null, command, checkedAt: cache.checkedAt ?? null };

  if (!out.json) {
    out.row("Current", current);
    out.row("Latest", latest);
    out.row("Changelog", url);
  }

  if (!available) {
    if (out.json) out.data({ status: "up_to_date", ...base });
    else {
      if (checkOnly) out.print(latest);
      out.ok(`coding.sh ${current} is the latest version`);
    }
    return 0;
  }

  if (!spec || !command) {
    throw new CliError(`coding.sh ${latest} is out, but the release has no installable package`, {
      reason: "no_install_target",
      next: ["Reinstall with the installer:", INSTALL_SCRIPT],
      data: base,
    });
  }

  if (checkOnly || dryRun) {
    if (out.json) out.data({ status: "available", dryRun, ...base });
    else if (dryRun) {
      out.print(command);
      out.note(`Dry run: nothing installed. Run the command above, or ${out.style("coding.sh update", "cyan", "err")}.`);
    } else {
      out.print(latest);
      out.warn(`coding.sh ${latest} is available`);
      out.next("Install it", "coding.sh update");
    }
    return 0;
  }

  const installing = out.spin(`Installing coding.sh ${latest}`);
  let result: InstallResult;
  try {
    result = await (deps.install ?? npmInstall)(installArgs(spec), { quiet: out.json, signal: c.signal, env: c.env });
  } catch (e) {
    installing.stop();
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    throw new CliError(missing ? "Can't install the update: npm is not on PATH" : `Can't install the update: ${(e as Error).message}`, {
      reason: missing ? "npm_not_found" : "install_failed",
      next: ["Install it manually:", command],
      data: base,
    });
  }
  installing.stop();
  if (c.signal.aborted || result.code === 130) return 130;
  if (result.code !== 0) {
    const tail = clean(result.output.trim().split("\n").slice(-3).join(" ")).slice(0, 300);
    throw new CliError(`npm install failed${result.code === null ? "" : ` (exit ${result.code})`}${tail ? `: ${tail}` : ""}`, {
      reason: "install_failed",
      next: ["Retry by hand (it may need a writable npm prefix):", command],
      data: base,
    });
  }

  if (out.json) out.data({ status: "updated", ...base });
  else out.ok(`Updated coding.sh ${current} → ${latest}`);
  return 0;
}
