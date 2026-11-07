// Writes the job summary, step outputs and (optionally) a pull request comment
// for the coding.sh GitHub Action. Inputs arrive as environment variables set by
// action.yml; see the "Report" step there.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const read = (p) => (p ? JSON.parse(readFileSync(p, "utf8")) : null);

const head = read(env.HEAD_JSON)?.experiment;
const base = read(env.BASE_JSON)?.experiment ?? null;
const cmp = read(env.COMPARE_JSON)?.comparison ?? null;
if (!head) throw new Error("no result for this run");

const pct = (x) => (x == null || Number.isNaN(x) ? "–" : `${(x * 100).toFixed(1)}%`);
const pp = (x) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)} pp`;
const ppBare = (x) => `${x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}`;
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const rate = (e) => `${pct(e.summary.passRate.p)} (${e.summary.passed}/${e.summary.n})`;
const ci = (e) => `${pct(e.summary.passRate.lo)} – ${pct(e.summary.passRate.hi)}`;

// ---- gate ---------------------------------------------------------------
const gate = env.GATE || "regressions";
if (!["regressions", "worse", "pass-rate"].includes(gate)) throw new Error(`gate must be regressions, worse or pass-rate, got "${gate}"`);
const why = [];
if (cmp) {
  if (gate === "regressions" && cmp.regressions.length > 0)
    why.push(`${cmp.regressions.length} case(s) that passed on ${env.BASE_REF} now fail`);
  if (gate === "worse" && cmp.verdict === "worse")
    why.push(`pass rate is worse than ${env.BASE_REF} with 95% confidence (${pp(cmp.diff.mean)})`);
  if (gate === "pass-rate" && cmp.b.passRate < cmp.a.passRate)
    why.push(`pass rate dropped from ${pct(cmp.a.passRate)} to ${pct(cmp.b.passRate)}`);
}
const minRate = env.MIN_PASS_RATE ? Number(env.MIN_PASS_RATE) : null;
if (minRate != null && Number.isNaN(minRate)) throw new Error(`min-pass-rate must be a number, got "${env.MIN_PASS_RATE}"`);
if (minRate != null && head.summary.passRate.p < minRate)
  why.push(`pass rate ${pct(head.summary.passRate.p)} is below the minimum ${pct(minRate)}`);
const regressed = why.length > 0;

// ---- markdown -----------------------------------------------------------
const marker = `<!-- coding.sh-action: ${env.SPEC || "evals"} -->`;
const sha = (env.GITHUB_SHA || "").slice(0, 7);
const ds = `${head.dataset.name}@${String(head.dataset.version).slice(0, 8)}`;
const md = [marker];

const gateTripped = why.length > (minRate != null && head.summary.passRate.p < minRate ? 1 : 0);
let headline;
if (gateTripped) headline = "regression";
else if (regressed) headline = "below the minimum pass rate";
else if (!cmp) headline = `${pct(head.summary.passRate.p)} pass`;
else if (cmp.verdict === "better") headline = "better than base";
else headline = "no regression";
md.push(`### coding.sh evals: ${headline}`, "");
md.push(
  `\`${env.SPEC}\` on dataset \`${ds}\`, ${head.summary.cases} cases × ${head.trials} trial(s)` +
    (base ? `. Base \`${env.BASE_REF}\` (${env.BASE_SHA}) vs this commit (${sha}).` : "."),
  "",
);

if (cmp && base) {
  const d = cmp.diff;
  const verdict = cmp.verdict === "inconclusive" ? "inconclusive (CI includes 0)" : `**${cmp.verdict}**`;
  md.push(
    "| | Base | This commit | Change |",
    "|---|---:|---:|---:|",
    `| Pass rate | ${rate(base)} | ${rate(head)} | **${pp(d.mean)}** |`,
    `| 95% CI | ${ci(base)} | ${ci(head)} | ${ppBare(d.lo)} to ${ppBare(d.hi)} pp |`,
    `| Verdict | | | ${verdict} |`,
    "",
    `${cmp.regressions.length} regressed, ${cmp.improvements.length} improved over ${cmp.paired} paired cases` +
      (cmp.mcnemar ? `; McNemar p = ${cmp.mcnemar.p.toFixed(3)}` : "") +
      `. Gate \`${gate}\`: ${regressed ? "**tripped**" : "passed"}.`,
    "",
  );
} else {
  md.push(
    "| | This commit |",
    "|---|---:|",
    `| Pass rate | ${rate(head)} |`,
    `| 95% CI | ${ci(head)} |`,
    `| Errors | ${head.summary.errors} |`,
    "",
  );
  if (env.BASE_NOTE) md.push(`> ${env.BASE_NOTE}`, "");
  else md.push("No baseline: this run is reported alone.", "");
  if (minRate != null) md.push(`Minimum pass rate ${pct(minRate)}: ${regressed ? "**not met**" : "met"}.`, "");
}
if (regressed) md.push(...why.map((w) => `- ${w}`), "");

// Failure reasons for this run, keyed by case.
const reasons = new Map();
for (const r of head.runs ?? []) {
  if (r.pass) continue;
  const g = (r.grades ?? []).find((x) => x.result && !x.result.pass);
  const reason = r.error ?? (g ? `${g.graderId}: ${g.result.reason ?? "failed"}` : "failed");
  if (!reasons.has(r.caseId)) reasons.set(r.caseId, String(typeof reason === "object" ? JSON.stringify(reason) : reason));
}

const LIMIT = 25;
if (cmp?.regressions.length) {
  md.push(`<details${regressed ? " open" : ""}><summary>Regressions (${cmp.regressions.length})</summary>`, "");
  md.push("| Case | Base | This commit | Reason |", "|---|---:|---:|---|");
  for (const r of cmp.regressions.slice(0, LIMIT))
    md.push(`| \`${r.caseId}\` | ${pct(r.a)} | ${pct(r.b)} | ${cell(clip(reasons.get(r.caseId) ?? "", 160))} |`);
  if (cmp.regressions.length > LIMIT) md.push(`| … ${cmp.regressions.length - LIMIT} more | | | |`);
  md.push("", "</details>", "");
} else if (!cmp && reasons.size) {
  md.push(`<details><summary>Failures (${reasons.size})</summary>`, "");
  md.push("| Case | Reason |", "|---|---|");
  for (const [id, why] of [...reasons].slice(0, LIMIT)) md.push(`| \`${id}\` | ${cell(clip(why, 160))} |`);
  md.push("", "</details>", "");
}
if (cmp?.improvements.length) md.push(`Improved: ${cmp.improvements.slice(0, LIMIT).map((r) => `\`${r.caseId}\``).join(", ")}`, "");
const warnings = [...(cmp?.power?.warnings ?? []).map((w) => w.message), ...(cmp?.gradeWarning ? [cmp.gradeWarning] : [])];
if (warnings.length) md.push(...warnings.map((w) => `> ${w}`), "");
const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
  ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : "";
md.push(`<sub>[coding.sh](https://coding.sh) agent evals${runUrl ? ` · [run log](${runUrl})` : ""}</sub>`, "");
const body = md.join("\n");

// ---- outputs ------------------------------------------------------------
const reportPath = join(env.ROOT || ".", "report.md");
writeFileSync(reportPath, body);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${body}\n`);
const outputs = {
  verdict: cmp ? cmp.verdict : "none",
  "pass-rate": head.summary.passRate.p,
  "baseline-pass-rate": base ? base.summary.passRate.p : "",
  delta: cmp ? cmp.diff.mean : "",
  "ci-low": cmp ? cmp.diff.lo : "",
  "ci-high": cmp ? cmp.diff.hi : "",
  regressions: cmp ? cmp.regressions.length : 0,
  regressed: String(regressed),
  why: why.join("; "),
  report: reportPath,
};
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
else process.stdout.write(`${body}\n${JSON.stringify(outputs, null, 2)}\n`);

// ---- pull request comment ----------------------------------------------
if (env.COMMENT === "true") {
  if (!env.PR_NUMBER) console.log("comment: not a pull request run, skipping");
  else {
    try {
      await upsertComment(body);
    } catch (err) {
      // Fork pull requests get a read-only token; the summary still has the result.
      console.log(`::warning::could not comment on the pull request: ${err.message}`);
    }
  }
}

async function upsertComment(text) {
  const api = `${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
  const headers = {
    authorization: `Bearer ${env.GH_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
  const call = async (url, init = {}) => {
    const res = await fetch(url, { headers, ...init });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const list = await call(`${api}/issues/${env.PR_NUMBER}/comments?per_page=100&page=${page}`);
    existing = list.find((c) => typeof c.body === "string" && c.body.startsWith(marker));
    if (list.length < 100) break;
  }
  if (existing) {
    await call(`${api}/issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body: text }) });
    console.log(`comment: updated ${existing.html_url}`);
  } else {
    const c = await call(`${api}/issues/${env.PR_NUMBER}/comments`, { method: "POST", body: JSON.stringify({ body: text }) });
    console.log(`comment: posted ${c.html_url}`);
  }
}
