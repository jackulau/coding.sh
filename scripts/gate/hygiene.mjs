// The gate's repo-hygiene check on the commits a push sends; the pre-push hook
// runs it (scripts/hooks/lib.mjs prepushPlan).
//
//   node scripts/gate/hygiene.mjs <base>..<sha> [<sha> ...]
//
// Each range's authors must end in @users.noreply.github.com, the repo must set
// no git identity of its own, and no private agent file may be tracked. Exits 1
// with the reasons when one fails. Reads git; never writes. Zero dependencies.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, repoHygiene } from "./checks.mjs";

export function main(argv, { cwd = process.cwd(), env = process.env, stderr = process.stderr } = {}) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"], env);
  if (!top.ok) {
    stderr.write("hygiene: not inside a git checkout\n");
    return 2;
  }
  const failures = new Set();
  // ci: the authors are checked by their noreply suffix only, as in CI, so the check needs no global config.
  for (const range of argv.length ? argv : [undefined]) {
    const r = repoHygiene(resolve(top.out), { env, ci: true, range });
    if (r.status === "fail") for (const d of r.detail) failures.add(d);
  }
  if (!failures.size) return 0;
  for (const f of failures) stderr.write(`hygiene: ${f}\n`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
