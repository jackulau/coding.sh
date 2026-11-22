#!/usr/bin/env node
// Adds one line to the unreleased version of CHANGELOG.md, or checks the lines
// already there, with the rules the site build and tests apply later:
//   - at most 60 words, counted as apps/site/test/changelog-shape.test.mjs counts them;
//   - one of the seven sections that test allows;
//   - no duplicate of a line already in the file;
//   - no character outside CORE that only a -rest font file has (apps/site/scripts/subset-fonts.py);
//   - a link to a file under docs/ that exists, and a #fragment that names one of its headings.
// Zero dependencies.
//
//   node scripts/changelog/add.mjs --section Fixed --area Sessions --text "..." --link guides/explore.md#ask-your-agent
//   node scripts/changelog/add.mjs --check
//
// A failure exits 1 with one line per problem and leaves the file as it was.
// The write goes to a temp file that is renamed over CHANGELOG.md; when the file
// changed since it was read, the line is placed again (up to 5 tries).
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MAX_WORDS = 60;
export const SECTIONS = ["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security", "Performance"];
const REPO = "https://github.com/jackulau/coding.sh/blob/main/";
const TRIES = 5;

/** Words as the shape test counts them: whitespace-separated tokens after the "-". */
export const words = (line) => line.split(/\s+/).length - 1;

/**
 * Whether a line has a link: a markdown link to a URL, to a path that starts with /, ./,
 * ../ or docs/, or to a #fragment, or a bare URL. The site's changelog renders a docs/
 * path as that doc's page (apps/site/src/lib/changelog.ts). The shape test counts links
 * with this function, so --check and the site test agree.
 */
export const hasLink = (line) => /\]\((?:https?:\/\/|\.{0,2}\/|#|docs\/)[^)]+\)|https?:\/\/\S+/.test(line);

/** A NAME = ( "..." "..." ) range string in subset-fonts.py, as [from, to] code point pairs. */
function pyRanges(py, name) {
  const at = py.search(new RegExp(`^${name} = \\(`, "m"));
  const body = at === -1 ? undefined : py.slice(at).match(/^[A-Z]+ = \(([\s\S]*?)^\)/m)?.[1];
  if (!body) throw new Error(`apps/site/scripts/subset-fonts.py has no ${name} = (...) string`);
  return [...body.matchAll(/"([^"]*)"/g)]
    .map((m) => m[1])
    .join("")
    .split(",")
    .filter(Boolean)
    .map((r) => {
      const m = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(r.trim());
      if (!m) throw new Error(`subset-fonts.py ${name} has a range this script cannot read: ${r}`);
      return [parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)];
    });
}

/**
 * The font ranges, read at runtime from apps/site/scripts/subset-fonts.py: CORE (the
 * preloaded -core files) and LATIN (what the Geist faces cover; LATIN minus CORE is
 * the -rest files). A glyph outside LATIN is drawn by a system font and loads nothing.
 */
export function fontRanges(root = ROOT) {
  const py = readFileSync(join(root, "apps/site/scripts/subset-fonts.py"), "utf8");
  return { core: pyRanges(py, "CORE"), latin: pyRanges(py, "LATIN") };
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
const within = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

/**
 * The first character that only a -rest font file has (in LATIN, outside CORE), or
 * undefined. A page that shows one fails rule 5 of apps/site/scripts/perf-budget.mjs.
 */
export function outsideCore(text, { core, latin }) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (!within(cp, core) && within(cp, latin)) return { cp, name: hex(cp) };
  }
  return undefined;
}

/** GitHub's heading anchor, as apps/site/src/components/docs/markdown.ts makes it. */
export function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

const idCache = new Map();
/** Every heading id of a markdown file (repeats get -1, -2, ...), plus explicit id="" and name="" anchors. */
export function headingIds(file) {
  if (idCache.has(file)) return idCache.get(file);
  const ids = new Set();
  const seen = new Map();
  let fence = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^#{1,6} (.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const base = slug(h[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      ids.add(n ? `${base}-${n}` : base);
    }
    for (const m of line.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) ids.add(m[1]);
  }
  idCache.set(file, ids);
  return ids;
}

/**
 * A --link value to a doc path under docs/ ("guides/explore.md#x"). Takes
 * "docs/guides/explore.md#x", "guides/explore.md#x" or the GitHub URL of the doc.
 */
export function docOf(link) {
  let path = link.trim();
  if (path.startsWith(REPO)) path = path.slice(REPO.length);
  else if (/^[a-z]+:/i.test(path)) return undefined;
  path = path.replace(/^(\.\.?\/)+/, "").replace(/^docs\//, "");
  const hash = path.indexOf("#");
  return hash === -1 ? { file: path, id: "" } : { file: path.slice(0, hash), id: path.slice(hash + 1) };
}

/** Why a doc link does not resolve, or undefined when it does. */
export function linkProblem(doc, root = ROOT) {
  if (!doc.file || doc.file.split("/").includes("..")) return `link "${doc.file}" is not a path under docs/`;
  const file = join(root, "docs", doc.file);
  if (!existsSync(file) || !statSync(file).isFile()) return `link names docs/${doc.file}, which does not exist`;
  if (!doc.id || !doc.file.endsWith(".md")) return undefined;
  let id;
  try {
    id = decodeURIComponent(doc.id);
  } catch {
    return `link fragment #${doc.id} is not valid percent-encoding`;
  }
  if (!headingIds(file).has(id)) return `link names #${doc.id}, but docs/${doc.file} has no heading with that id`;
  return undefined;
}

/** The repo-doc links in a line: GitHub doc URLs and relative docs/ paths. Site URLs are left to the site build. */
function docLinks(line) {
  const out = [];
  for (const [, url] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (url.startsWith(`${REPO}docs/`) || /^(\.\.?\/)*docs\//.test(url)) out.push(docOf(url));
  }
  return out;
}

/** Line problems that do not depend on where the line sits: words, glyphs, links. */
export function lineProblems(line, ranges, root = ROOT) {
  const problems = [];
  const n = words(line);
  if (n > MAX_WORDS) problems.push(`${n} words, the limit is ${MAX_WORDS}`);
  if (!/^- \*\*[^*]+\.\*\* \S/.test(line)) problems.push('the line does not start with a bold area ("- **Sessions.** ...")');
  const bad = outsideCore(line, ranges);
  if (bad) problems.push(`${bad.name} (${String.fromCodePoint(bad.cp)}) is outside the CORE font ranges in apps/site/scripts/subset-fonts.py, so the page loads a -rest font (perf-budget rule 5)`);
  if (!hasLink(line)) problems.push("the line has no link");
  for (const doc of docLinks(line)) {
    const p = linkProblem(doc, root);
    if (p) problems.push(p);
  }
  return problems;
}

/** The unreleased block: the first "## " heading through the line before the next. */
export function unreleased(lines) {
  const start = lines.findIndex((l) => l.startsWith("## "));
  if (start === -1) return { error: "no version heading (## [x.y.z] - Unreleased)" };
  if (!/^## \[\d+\.\d+\.\d+\] - Unreleased$/.test(lines[start])) return { error: `the first version, "${lines[start]}", is released; add a "## [x.y.z] - Unreleased" heading first` };
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  return { start, end };
}

/** Bullets of the unreleased block, with continuation lines joined, and the 1-based line each starts on. */
function bullets(lines, block) {
  const out = [];
  let section = null;
  for (let i = block.start + 1; i < block.end; i++) {
    if (lines[i].startsWith("### ")) section = lines[i].slice(4).trim();
    else if (lines[i].startsWith("- ")) {
      let text = lines[i];
      for (let j = i + 1; j < block.end && lines[j].startsWith("  "); j++) text += " " + lines[j].trim();
      out.push({ line: i + 1, text, section });
    }
  }
  return out;
}

/** Every problem in the unreleased lines of a changelog, as "CHANGELOG.md:<line>: ..." strings. */
export function check(md, { root = ROOT, name = "CHANGELOG.md" } = {}) {
  const lines = md.split(/\r?\n/);
  const block = unreleased(lines);
  if (block.error) return [`${name}: ${block.error}`];
  const ranges = fontRanges(root);
  const problems = [];
  for (let i = block.start + 1; i < block.end; i++) {
    if (!lines[i].startsWith("### ")) continue;
    const s = lines[i].slice(4).trim();
    if (!SECTIONS.includes(s)) problems.push(`${name}:${i + 1}: section "${s}" is not one of ${SECTIONS.join(", ")}`);
  }
  const seen = new Map();
  for (const b of bullets(lines, block)) {
    if (!b.section) problems.push(`${name}:${b.line}: a bullet outside a ### section`);
    for (const p of lineProblems(b.text, ranges, root)) problems.push(`${name}:${b.line}: ${p}`);
    if (seen.has(b.text)) problems.push(`${name}:${b.line}: the same line as ${name}:${seen.get(b.text)}`);
    else seen.set(b.text, b.line);
  }
  return problems;
}

/** The line --area, --text and --link make. */
export function makeLine({ area, text, link }) {
  const doc = docOf(link);
  const url = doc ? `${REPO}docs/${doc.file}${doc.id ? `#${doc.id}` : ""}` : link;
  return `- **${area.trim().replace(/\.+$/, "")}.** ${text.trim()} ([docs](${url}))`;
}

/** Problems with the input itself, before the file is read. */
export function inputProblems({ section, area, text, link }, root = ROOT) {
  const problems = [];
  if (!SECTIONS.includes(section)) problems.push(`section "${section}" is not one of ${SECTIONS.join(", ")}`);
  if (!area?.trim() || /[*\n]/.test(area)) problems.push("--area is empty or has a * or a line break");
  if (!text?.trim() || /\n/.test(text)) problems.push("--text is empty or has a line break");
  if (!link?.trim()) problems.push("--link is missing");
  else {
    if (!docOf(link)) problems.push(`link "${link}" is not a doc under docs/ (give docs/<file>.md[#id])`);
  }
  if (problems.length) return problems;
  return lineProblems(makeLine({ area, text, link }), fontRanges(root), root);
}

/** md with `line` added at the end of `section` in the unreleased version, the section made if missing. */
export function insert(md, section, line) {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.split(/\r?\n/);
  const block = unreleased(lines);
  if (block.error) return { error: block.error };
  if (lines.includes(line)) return { error: "the same line is already in CHANGELOG.md" };
  const heads = [];
  for (let i = block.start + 1; i < block.end; i++) if (lines[i].startsWith("### ")) heads.push({ i, name: lines[i].slice(4).trim() });
  const own = heads.find((h) => h.name === section);
  if (own) {
    const next = heads.find((h) => h.i > own.i)?.i ?? block.end;
    let last = own.i;
    for (let i = own.i + 1; i < next; i++) if (lines[i].startsWith("- ") || (lines[i].startsWith("  ") && last > own.i)) last = i;
    if (last === own.i) lines.splice(own.i + 1, 0, "", line);
    else lines.splice(last + 1, 0, line);
  } else {
    const rank = SECTIONS.indexOf(section);
    const after = heads.find((h) => SECTIONS.indexOf(h.name) > rank);
    if (after) lines.splice(after.i, 0, `### ${section}`, "", line, "");
    else {
      let at = block.end;
      while (at > block.start + 1 && lines[at - 1].trim() === "") at--;
      lines.splice(at, 0, "", `### ${section}`, "", line);
    }
  }
  return { md: lines.join(eol) };
}

/** Takes CHANGELOG.md.lock, waiting for another run of this script to let it go. */
function lock(file) {
  const path = `${file}.lock`;
  const until = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return () => rmSync(path, { force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(path).mtimeMs > 10_000) rmSync(path, { force: true });
      } catch {}
      if (Date.now() > until) throw new Error(`${path} is held by another run; remove it if no run is going`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.random() * 30);
    }
  }
}

/** Adds the line. Returns the problems, empty on success. */
export function add({ file = join(ROOT, "CHANGELOG.md"), root = ROOT, section, area, text, link }) {
  const problems = inputProblems({ section, area, text, link }, root);
  if (problems.length) return problems;
  const line = makeLine({ area, text, link });
  const release = lock(file);
  try {
    for (let n = 0; n < TRIES; n++) {
      const before = readFileSync(file, "utf8");
      const out = insert(before, section, line);
      if (out.error) return [out.error];
      const tmp = `${file}.${process.pid}.${n}.tmp`;
      writeFileSync(tmp, out.md);
      // Someone else (an editor, another tool) changed the file since we read it: place the line again.
      if (readFileSync(file, "utf8") !== before) {
        rmSync(tmp, { force: true });
        continue;
      }
      try {
        renameSync(tmp, file);
      } catch (e) {
        rmSync(tmp, { force: true });
        if (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES") continue;
        throw e;
      }
      if (readFileSync(file, "utf8").split(/\r?\n/).includes(line)) return [];
    }
    return [`CHANGELOG.md kept changing while the line was written; tried ${TRIES} times`];
  } finally {
    release();
  }
}

const USAGE = `Usage:
  node scripts/changelog/add.mjs --section <S> --area <A> --text <T> --link <docs path[#id]> [--file CHANGELOG.md]
  node scripts/changelog/add.mjs --check [--file CHANGELOG.md]

--section is one of ${SECTIONS.join(", ")}. The line is "- **A.** T ([docs](link))", at most
${MAX_WORDS} words, in the CORE font subset, with a link to a doc under docs/ whose #fragment is one of its headings.
--check runs the same checks over every line of the unreleased version.`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check" || a === "--help" || a === "-h") opts[a.replace(/^-+/, "")] = true;
    else if (["--section", "--area", "--text", "--link", "--file", "--root"].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`changelog: ${e.message}`);
    return 1;
  }
  if (opts.help || opts.h) {
    console.log(USAGE);
    return 0;
  }
  const root = opts.root ? resolve(opts.root) : ROOT;
  const file = opts.file ? resolve(opts.file) : join(root, "CHANGELOG.md");
  if (opts.check) {
    const problems = check(readFileSync(file, "utf8"), { root });
    for (const p of problems) console.error(p);
    return problems.length ? 1 : 0;
  }
  const missing = ["section", "area", "text", "link"].filter((k) => opts[k] === undefined);
  if (missing.length) {
    console.error(`changelog: missing ${missing.map((k) => `--${k}`).join(", ")}\n${USAGE}`);
    return 1;
  }
  const problems = add({ file, root, section: opts.section, area: opts.area, text: opts.text, link: opts.link });
  if (problems.length) {
    console.error(`changelog: ${problems.join("; ")}`);
    return 1;
  }
  console.log(makeLine(opts));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
