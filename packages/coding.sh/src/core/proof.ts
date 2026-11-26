// Proofs and the checks that judge them. An agent can pass a proof check without proving what was
// asked: it can change the theorem, edit the spec, leave an escape hatch (`sorry`, `Admitted`, an
// axiom) or run the checker with a flag that skips the work. The readers here take one diff or one
// command; ProofState follows them over a session's events, and core/intent.ts turns it into
// test-tamper findings and the flag. Pure: rules over text, no I/O.
import { posix } from "node:path";
import type { AgentEvent } from "../schema/index.ts";
import { exitCodeOf } from "./failing-command.ts";
import { diffHunks, shellScript, simpleCommands, type DiffLine, type ShellDiffOrigin, type SimpleCommand } from "./shell-diff.ts";

/** A proof language, or a TLC model config (`.cfg`). */
export type ProofLang = "lean" | "rocq" | "dafny" | "verus" | "isabelle" | "tla" | "tlc";

const BY_EXT = new Map<string, ProofLang>([["lean", "lean"], ["v", "rocq"], ["dfy", "dafny"], ["thy", "isabelle"], ["tla", "tla"]]);
/** Build files that choose what a checker reads and with which options. */
const PROOF_CONFIG = /(?:^|\/)(?:_CoqProject|_RocqProject|lakefile\.(?:lean|toml)|ROOTS?|dfyconfig\.toml)$/;
/**
 * Verilog shares `.v` with Rocq: its keywords, declarations that end in `;`, and sized literals
 * (`8'hFF`). The text may be a diff, so a line can start with its marker.
 */
const VERILOG =
  /\b(?:endmodule|endcase|endgenerate|endfunction|endtask|always_ff|always_comb|always_latch|posedge|negedge)\b|^[-+ ]?[ \t]*(?:module|macromodule)[ \t]+\w+[ \t]*(?:#[ \t]*)?[(;]|\balways[ \t]*@|^[-+ ]?[ \t]*(?:input|output|inout)[ \t]+(?:wire|reg|logic|signed|\[)|^[-+ ]?[ \t]*(?:assign|wire|reg|logic|localparam|parameter|genvar)\b[^\n;]*;|\b\d+'[sS]?[bBhHdDoO]/m;
/**
 * Verilog lines that Rocq does not write: a `//` or `/*` comment, a port connection
 * (`.grant (grant),`), a `begin`, and an assignment that ends in `;` (`grant <= admit;`,
 * `if (req) grant = 1;`). A `.v` diff with one and no Rocq sentence is not read as Rocq.
 */
const VERILOG_LINE =
  /^[-+ ]?[ \t]*(?:\/[/*]|\.\w+[ \t]*\()|\*\/[ \t\r]*$|^[-+ ]?[ \t]*(?:end[ \t]+)?(?:else[ \t]+)?(?:if[ \t]*\([^()\n]*\)[ \t]*)?(?:begin\b|\w+(?:\[[^\]\n]*\])?[ \t]*(?:<=|=(?![=>]))[^;\n]*;[ \t\r]*$)/m;
/**
 * A line that starts a Rocq sentence: `Require Import`, a `Lemma` or `Definition` with its name,
 * `Proof.`, `Qed.`, `End Name.`. Read with comments blanked, so a word in a comment is not one.
 */
const ROCQ_SENTENCE =
  /^[-+ ]?[ \t]*(?:#\[[^\]\n]*\][ \t]*)?(?:(?:Local|Global|Polymorphic|Monomorphic|Program)[ \t]+)*(?:(?:(?:From[ \t]+[\w.]+[ \t]+)?Require|Import|Export|Open[ \t]+Scope)[ \t]+[\w.]|(?:Theorem|Lemma|Corollary|Proposition|Fact|Remark|Example|Definition|Fixpoint|CoFixpoint|Inductive|CoInductive|Record|Structure|Class|Instance|Axioms?|Parameters?|Hypothes[ie]s|Variables?|Conjectures?|Section|Module(?:[ \t]+Type)?)[ \t]+(?:[\w']+[ \t]*)?(?:[:({[.]|<:)|(?:Proof|Qed|Defined|Admitted|Abort)[ \t]*\.(?=\s|$)|Proof[ \t]+(?:using|with)\b|End[ \t]+[\w']+[ \t]*\.)/m;
/** A Rust file is a Verus one when its code uses Verus syntax: words in comments and strings do not count. */
const VERUS = /\bverus!\s*\{|#\[verifier[:(]|\b(?:spec|proof)\s+fn\b|\buse\s+vstd::/;
/** A `.cfg` file is a TLC model when it has TLC's directives. */
const TLC_DIRECTIVE = /^[-+ ]?[ \t]*(?:SPECIFICATION|INIT|NEXT|INVARIANTS?|PROPERT(?:Y|IES)|CONSTANTS?|CONSTRAINTS?|ACTION_CONSTRAINTS?|SYMMETRY|VIEW|CHECK_DEADLOCK|ALIAS|POSTCONDITION)\b/m;
/** TLC lines that shrink what the model checker explores. */
const TLC_NARROW = /^[ \t]*(?:CONSTRAINTS?|ACTION_CONSTRAINTS?)\b|^[ \t]*CHECK_DEADLOCK[ \t]+FALSE\b/;
/** Line keys: a TLC line that narrows the model starts with NARROW; UNREAD stands for a change that could not be read. */
const NARROW = "\u0001";
const UNREAD = "\u0000";
/** Test, example and scratch folders: escape hatches there are expected. */
const PROOF_TEST = /(?:^|\/)(?:tests?|examples?|scratch)\//i;
/** Files and folders named as the spec or the statements to prove. `spec/` and `specs/` are test folders (core/intent.ts). */
const SPEC_NAMED = /(?:^|\/)(?:specifications?|statements?)\/|(?:^|\/)[^/]*(?:Spec|Specification|Statements?)\.[A-Za-z]+$|(?:^|\/)(?:spec|specification|statements?)\.[A-Za-z]+$/;

const extOf = (path: string) => /\.([A-Za-z]+)$/.exec(path)?.[1] ?? "";

/** The language of a proof file: by its extension, by its text for `.rs`, `.cfg` and `.v`, or as learned before. */
export function proofLang(path: string, text = "", known?: ProofLang): ProofLang | undefined {
  if (known) return known;
  const ext = extOf(path);
  if (ext === "rs") return VERUS.test(text) && VERUS.test(scanProof(text, SYNTAX.verus).bare) ? "verus" : undefined;
  if (ext === "cfg") return TLC_DIRECTIVE.test(text) ? "tlc" : undefined;
  if (ext === "v" && VERILOG.test(text)) return undefined;
  return BY_EXT.get(ext);
}

/** `_CoqProject`, `lakefile.lean`, an Isabelle `ROOT`, `dfyconfig.toml`. */
export const isProofConfig = (path: string): boolean => PROOF_CONFIG.test(path);

/** How a language writes comments and strings. `cart`: Isabelle's cartouches, text that is not code. */
export interface Syntax {
  line?: string;
  block?: [string, string];
  cart?: [string, string][];
  /** Has char literals (`'a'`), told apart from primes in names (`x'`). */
  chars?: true;
  /** Strings have no backslash escape (Rocq doubles the quote instead). */
  raw?: true;
}
const HASH: Syntax = { line: "#" };
const SYNTAX: Record<ProofLang, Syntax> = {
  lean: { line: "--", block: ["/-", "-/"], chars: true },
  rocq: { block: ["(*", "*)"], raw: true },
  dafny: { line: "//", block: ["/*", "*/"], chars: true },
  verus: { line: "//", block: ["/*", "*/"], chars: true },
  isabelle: { block: ["(*", "*)"], cart: [["\\<open>", "\\<close>"], ["‹", "›"]] },
  tla: { line: "\\*", block: ["(*", "*)"] },
  tlc: { line: "\\*", block: ["(*", "*)"] },
};
/** A proof file's syntax; build files: lakefile.lean is Lean, ROOT is Isabelle, the rest use `#` comments. */
export const syntaxOf = (path: string, lang: ProofLang | undefined): Syntax =>
  lang ? SYNTAX[lang] : /(?:^|\/)lakefile\.lean$/.test(path) ? SYNTAX.lean : /(?:^|\/)ROOTS?$/.test(path) ? SYNTAX.isabelle : HASH;

const CHAR = /'(?:\\.|[^'\\\n])'/y;

/**
 * The text with comments blanked (`code`) and with strings and cartouches blanked too (`bare`),
 * each the same length with the same line breaks. Block comments nest. A diff hunk can start inside
 * a comment, so a close with no open blanks everything before it. A string ends at its line's end.
 */
export function scanProof(text: string, sx: Syntax): { code: string; bare: string } {
  const code = text.split("");
  const bare = text.split("");
  const blank = (both: boolean, from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (text[k] === "\n") continue;
      bare[k] = " ";
      if (both) code[k] = " ";
    }
  };
  const [open, close] = sx.block ?? ["", ""];
  let depth = 0;
  let cart = 0;
  let cleared = 0;
  let i = 0;
  const at = (s: string) => s !== "" && text.startsWith(s, i);
  while (i < text.length) {
    const from = i;
    if (depth > 0) {
      if (at(open)) (depth++, (i += open.length));
      else if (at(close)) (depth--, (i += close.length));
      else i++;
      blank(true, from, i);
      continue;
    }
    const c = sx.cart?.find(([o, e]) => at(o) || at(e));
    if (cart > 0) {
      if (c) at(c[0]) ? (cart++, (i += c[0].length)) : (cart--, (i += c[1].length));
      else i++;
      blank(false, from, i);
    } else if (sx.line && at(sx.line)) {
      const eol = text.indexOf("\n", i);
      i = eol < 0 ? text.length : eol;
      blank(true, from, i);
    } else if (at(open)) {
      depth = 1;
      i += open.length;
      blank(true, from, i);
    } else if (at(close)) {
      i += close.length;
      blank(true, cleared, i);
      cleared = i;
    } else if (c) {
      if (at(c[0])) {
        cart = 1;
        i += c[0].length;
        blank(false, from, i);
      } else {
        i += c[1].length;
        blank(false, cleared, i);
        cleared = i;
      }
    } else if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") i += text[i] === "\\" && !sx.raw ? 2 : 1;
      if (text[i] === '"') i++;
      blank(false, from, Math.min(i, text.length));
    } else if (sx.chars && text[i] === "'" && !/[\w']/.test(text[i - 1] ?? "")) {
      CHAR.lastIndex = i;
      if (CHAR.test(text)) {
        i = CHAR.lastIndex;
        blank(false, from, i);
      } else i++;
    } else i++;
  }
  return { code: code.join(""), bare: bare.join("") };
}

/** Text read for Rocq sentences: `(* *)` comments, Verilog's `//` and `/*` comments, and strings blanked. */
const rocqText = (text: string) => scanProof(scanProof(text, { line: "//", block: ["(*", "*)"], raw: true }).bare, { block: ["/*", "*/"], raw: true }).code;
/** A Verilog line outside Rocq's `(* *)` comments and strings: code quoted in a Rocq comment is not one. */
const verilogLine = (text: string) => VERILOG_LINE.test(text) && VERILOG_LINE.test(scanProof(text, SYNTAX.rocq).bare);

/** A hatch word on its own: not part of a hyphenated word (`sorry-free`). */
const word = (w: string) => new RegExp(`(?<![A-Za-z]-)\\b${w}\\b(?!-[A-Za-z])`, "g");
/** A Rocq command: the first word of a line or of a sentence after `. `, after attributes and `Local` or `Global`. */
const command = (w: string) => new RegExp(`(?:^|\\.(?=[ \\t]))[ \\t]*(?:(?:Local|Global|Polymorphic|Monomorphic|#\\[[^\\].]*\\])[ \\t]*)*\\b${w}\\b(?!-[A-Za-z])`, "g");

/** Escape hatches: the checker takes a goal on trust. Read line by line, with comments and strings blanked. */
const HATCHES: Record<ProofLang, [string, RegExp][]> = {
  lean: [["sorry", word("sorry")], ["admit", word("admit")], ["axiom", word("axiom")], ["debug.skipKernelTC", /\bset_option[ \t]+debug\.skipKernelTC[ \t]+true\b/g]],
  rocq: [
    ["Admitted", command("Admitted")],
    // The tactic: a sentence or a step of one ends after it.
    ["admit", /(?<![A-Za-z]-)\badmit\b(?=[ \t]*(?:[.;|)\]}]|$))/g],
    ["Axiom", command("(?:Axioms?|Conjectures?)")],
    ["Admit Obligations", command("Admit[ \\t]+Obligations")],
    ["Unset Guard Checking", command("Unset[ \\t]+Guard[ \\t]+Checking")],
    ["Unset Universe Checking", command("Unset[ \\t]+Universe[ \\t]+Checking")],
    ["Unset Positivity Checking", command("Unset[ \\t]+Positivity[ \\t]+Checking")],
    // The attribute: `#[bypass_check(guard)]`.
    ["bypass_check", /#\[[^\]\n]*\bbypass_check\b/g],
  ],
  dafny: [["assume", word("assume")], ["{:axiom}", /\{:\s*axiom\b/g], ["{:verify false}", /\{:\s*verify\s+false\s*\}/g]],
  // A call, not a method call (`self.admit(x)`) or a function of that name.
  verus: [
    ["external_body", /#\[\s*verifier\s*(?:::\s*external_body|\(\s*external_body\s*\))\s*\]/g],
    ["assume", /(?<!\.)\bassume(?<!\bfn[ \t]+assume)\s*\(/g],
    ["admit", /(?<!\.)\badmit(?<!\bfn[ \t]+admit)\s*\(/g],
  ],
  isabelle: [["sorry", word("sorry")], ["axiomatization", word("axiomatization")]],
  tla: [["OMITTED", word("OMITTED")], ["AXIOM", word("AXIOMS?")]],
  tlc: [],
};
/** Build file options that switch checking off. Read with strings kept: TOML and lakefile options are quoted. */
const CONFIG_HATCHES: [string, RegExp][] = [
  ["quick_and_dirty", /\bquick_and_dirty\b(?![ \t]*=[ \t]*false\b)/g],
  ["skip_proofs", /\bskip_proofs\b(?![ \t]*=[ \t]*false\b)/g],
  ["debug.skipKernelTC", /(?:\b|(?<=-D))debug\.skipKernelTC\b(?![ \t"']*(?:[=,:][ \t"']*)?false\b)/g],
  ["-type-in-type", /(?<![\w-])--?type-in-type\b/g],
  ["no-verify", /(?<![\w-])(?:--?no-verify|\/noVerify)\b|^[ \t]*no-verify[ \t]*=(?![ \t]*false\b)/gm],
];

/** Where a statement starts: the keyword (Verus: the modifiers) in group 1, the name in group 2. Read on blanked text. */
const STMT: Partial<Record<ProofLang, RegExp>> = {
  lean: /^[ \t]*(?:@\[[^\]\n]*\][ \t]*)?(?:(?:private|protected|noncomputable|nonrec|partial|unsafe)[ \t]+)*(theorem|lemma)[ \t]+([^\s:({[]+)/gm,
  rocq: /^[ \t]*(?:#\[[^\]\n]*\][ \t]*)?(?:(?:Local|Global|Polymorphic|Monomorphic|Program)[ \t]+)*(Theorem|Lemma|Corollary|Proposition|Fact|Remark|Property|Example)[ \t]+([\w'.]+)/gm,
  dafny: /^[ \t]*(?:(?:ghost|static|twostate|opaque|abstract)[ \t]+)*(lemma|method|function|predicate|constructor)\b(?:[ \t]+method\b)?(?:[ \t]*\{:[^}\n]*\})*[ \t]*([\w'?]*)/gm,
  verus: /^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?((?:(?:open|closed|proof|spec|exec|broadcast|const|unsafe|async)[ \t]+)*)fn[ \t]+(\w+)/gm,
  isabelle: /^[ \t]*(theorem|lemma|corollary|proposition|schematic_goal)\b(?:[ \t]+([\w'.]+)(?=[ \t]*(?:\[[^\]\n]*\][ \t]*)?:))?/gm,
  tla: /^[ \t]*(THEOREM|LEMMA|PROPOSITION|COROLLARY)\b(?:[ \t]+(\w+)[ \t]*==)?/gm,
};
const ENDS: Partial<Record<ProofLang, RegExp>> = {
  rocq: /\.(?=\s|$)/g,
  isabelle: /\b(?:proof|by|apply|using|unfolding|including|supply|sorry|oops)\b/g,
  tla: /\b(?:PROOF|BY|OBVIOUS|OMITTED)\b|<\d+>|\n(?=\S)/g,
};
/** What a `{` follows when it opens a set or a block inside a clause, not the body. */
const NOT_BODY = /(?:[=!&|+\-*/%^~:(\[<]|=>|>=|\b(?:in|then|else|reads|modifies|decreases|requires|ensures))$/;
const CLAUSE = /\b(requires|ensures|reads|modifies|decreases|recommends)\b/g;

const atLineStart = (s: string, i: number) => {
  let k = i - 1;
  while (k >= 0 && (s[k] === " " || s[k] === "\t")) k--;
  return k < 0 || s[k] === "\n";
};

/** Where a statement that starts at `from` ends: before its proof or body, and never past `cap`. */
function extent(lang: ProofLang, bare: string, from: number, cap: number): number {
  const re = ENDS[lang];
  if (re) {
    re.lastIndex = 0;
    const m = re.exec(bare.slice(from, cap));
    return m ? from + m.index + (lang === "rocq" ? 1 : 0) : cap;
  }
  let depth = 0;
  for (let i = from; i < cap; i++) {
    const c = bare[i];
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (c === "}" && depth > 0) depth--;
    else if (c === "{") {
      if (lang !== "lean" && bare[i + 1] !== ":" && depth === 0 && !NOT_BODY.test(bare.slice(Math.max(from, i - 40), i).trimEnd())) return i;
      depth++;
    } else if (lang === "lean" && depth === 0) {
      if (c === ":" && bare[i + 1] === "=") return i;
      if (c === "|" && atLineStart(bare, i)) return i;
      if (c === "w" && bare.startsWith("where", i) && !/[\w.']/.test(bare[i - 1] ?? "") && !/[\w']/.test(bare[i + 5] ?? "")) return i;
    }
  }
  return cap;
}

/** A theorem, lemma or specified function as written: `text` has no whitespace and no comments. */
export interface Stmt {
  name: string;
  text: string;
  /** A claim (theorem, lemma, proof fn) or a function with requires or ensures; other functions are definitions. */
  spec: boolean;
  /** Dafny and Verus: the signature and the clauses, to tell an added `ensures` from a weakened one. */
  sig?: string;
  clauses?: string[];
}

const strip = (s: string) => s.replace(/\s+/g, "");
/** Split on commas outside brackets: Verus lists clauses that way. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) (out.push(s.slice(from, i)), (from = i + 1));
  }
  out.push(s.slice(from));
  return out.filter((x) => x !== "");
}

/** The statements in a scanned piece of a file. */
export function statements(lang: ProofLang, code: string, bare: string): Stmt[] {
  const re = STMT[lang];
  if (!re) return [];
  const starts: [number, number, string, string][] = [];
  re.lastIndex = 0;
  for (let m; (m = re.exec(bare)); ) starts.push([m.index, m.index + m[0].length, m[1] ?? "", m[2] ?? ""]);
  return starts.map(([at, head, kw, name], k): Stmt => {
    const end = extent(lang, bare, head, starts[k + 1]?.[0] ?? bare.length);
    if (lang !== "dafny" && lang !== "verus") return { name, text: strip(code.slice(at, end)), spec: true };
    const cuts: [number, string][] = [];
    const b = bare.slice(at, end);
    for (const m of b.matchAll(CLAUSE)) cuts.push([m.index, m[1] as string]);
    const c = code.slice(at, end);
    const sig = strip(c.slice(0, cuts[0]?.[0] ?? c.length));
    const clauses = cuts.flatMap(([i, w], n) => {
      if (w === "decreases" || w === "recommends") return [];
      const body = strip(c.slice(i + w.length, cuts[n + 1]?.[0] ?? c.length));
      return (lang === "verus" ? splitTop(body) : [body]).map((x) => `${w}:${x}`);
    });
    const spec = kw === "lemma" || /\bproof\b/.test(kw) || clauses.some((x) => /^(?:requires|ensures):/.test(x));
    return { name, text: sig + clauses.join(""), spec, sig, clauses };
  });
}

/** What a diff did to statements; one with the same text on both sides is unchanged. */
export interface StmtDelta {
  changed: [Stmt, Stmt][];
  removed: Stmt[];
  added: Stmt[];
}

/** `xs` without the ones `ys` has the same text for, each match used once. */
function leftOver(xs: Stmt[], ys: Stmt[]): Stmt[] {
  const n = new Map<string, number>();
  for (const y of ys) n.set(y.text, (n.get(y.text) ?? 0) + 1);
  return xs.filter((x) => {
    const k = n.get(x.text) ?? 0;
    if (k) n.set(x.text, k - 1);
    return !k;
  });
}

/** Pair what changed by name, each one before with the first one after of that name. Only claims and specified functions count. */
export function compareStatements(before: Stmt[], after: Stmt[]): StmtDelta {
  const out: StmtDelta = { changed: [], removed: [], added: [] };
  const now = leftOver(after, before);
  const byName = new Map<string, number[]>();
  now.forEach((a, k) => {
    const list = byName.get(a.name);
    if (list) list.push(k);
    else byName.set(a.name, [k]);
  });
  const next = new Map<string, number>();
  const used: boolean[] = [];
  for (const b of leftOver(before, after)) {
    const n = next.get(b.name) ?? 0;
    const k = byName.get(b.name)?.[n];
    if (k === undefined) {
      if (b.spec) out.removed.push(b);
      continue;
    }
    next.set(b.name, n + 1);
    used[k] = true;
    const a = now[k] as Stmt;
    if (a.spec || b.spec) out.changed.push([b, a]);
  }
  now.forEach((a, k) => {
    if (!used[k] && a.spec) out.added.push(a);
  });
  return out;
}

/** The clauses of `xs` that `ys` lacks, each match used once. */
function clauseDiff(xs: string[] = [], ys: string[] = []): string[] {
  const n = new Map<string, number>();
  for (const y of ys) n.set(y, (n.get(y) ?? 0) + 1);
  return xs.filter((x) => {
    const k = n.get(x) ?? 0;
    if (k) n.set(x, k - 1);
    return !k;
  });
}

/** An edit that only adds `ensures` clauses proves more, not less. */
export function strengthens(b: Stmt, a: Stmt): boolean {
  if (b.sig === undefined || b.sig !== a.sig) return false;
  return !clauseDiff(b.clauses, a.clauses).length && clauseDiff(a.clauses, b.clauses).every((c) => c.startsWith("ensures:"));
}

/** An edit that only drops `ensures` clauses or adds `requires` clauses proves less. */
export function weakens(b: Stmt, a: Stmt): boolean {
  if (b.sig === undefined || b.sig !== a.sig) return false;
  const lost = clauseDiff(b.clauses, a.clauses);
  const extra = clauseDiff(a.clauses, b.clauses);
  return lost.length + extra.length > 0 && lost.every((c) => c.startsWith("ensures:")) && extra.every((c) => c.startsWith("requires:"));
}

/** A short key for a statement's text: its length and FNV-1a hash, base 36. */
export function textKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${s.length.toString(36)}:${(h >>> 0).toString(36)}`;
}

export interface ProofDiff extends StmtDelta {
  /** Escape hatches put in (positive) or taken out (negative), by name. */
  hatches: Map<string, number>;
  /**
   * Lines taken out and put in, without whitespace, each with its run: the `-` and `+` lines
   * between two context lines share one. A line that only moved cancels. TLC lines that narrow the
   * model start with NARROW.
   */
  taken: [string, number][];
  fresh: [string, number][];
  /** The text after the change, as the hunks show it, has a line that starts a Rocq sentence. Read for Rocq and build files only. */
  rocq: boolean;
}

/** A `Module Type` header; the rest of the line, a carriage return included, tells a declaration from a `:=` definition. */
const MODULE_TYPE = /^[ \t]*(?:#\[[^\]\n]*\][ \t]*)?Module[ \t]+Type[ \t]+([\w']+)([^\n]*)$/;
const MODULE_END = /^[ \t]*End[ \t]+([\w']+)[ \t]*\./;

/**
 * The lines of a Rocq `Module Type` block, from its header to its `End`: an `Axiom` there
 * declares what a module must provide. One whose header is not in the hunk is not seen.
 */
function moduleTypeLines(bare: string[]): boolean[] {
  let name: string | undefined;
  return bare.map((l) => {
    if (name === undefined) {
      const m = MODULE_TYPE.exec(l);
      if (m && !(m[2] ?? "").includes(":=")) name = m[1];
      return name !== undefined;
    }
    if (MODULE_END.exec(l)?.[1] === name) name = undefined;
    return true;
  });
}

/** Read one file's diff. A clipped diff's last hunk counts only when it only adds lines. */
export function readProofDiff(path: string, lang: ProofLang | undefined, diff: string, truncated = false): ProofDiff {
  const sx = syntaxOf(path, lang);
  let hunks = diffHunks(diff);
  if (truncated && hunks.length && !(hunks.at(-1) as DiffLine[]).every((l) => l.t === "+")) hunks = hunks.slice(0, -1);
  const before: Stmt[] = [];
  const after: Stmt[] = [];
  // Each line with its code, its bare text and its run: the context lines above it, plus one for each hunk above.
  const lines: Record<"-" | "+", [string, string, number][]> = { "-": [], "+": [] };
  let rocq = false;
  let runs = 0;
  for (const h of hunks) {
    let run = runs;
    for (const side of ["-", "+"] as const) {
      const img = h.filter((l) => l.t === " " || l.t === side);
      const text = img.map((l) => l.s).join("\n");
      const { code, bare } = scanProof(text, sx);
      const cl = code.split("\n");
      const bl = bare.split("\n");
      const inType = lang === "rocq" ? moduleTypeLines(bl) : undefined;
      run = runs;
      img.forEach((l, k) => {
        if (l.t === side) lines[side].push([cl[k] as string, inType?.[k] ? "" : (bl[k] as string), run]);
        else run++;
      });
      if (lang) (side === "-" ? before : after).push(...statements(lang, code, bare));
      if (side === "+" && !rocq && (!lang || lang === "rocq") && ROCQ_SENTENCE.test(rocqText(text))) rocq = true;
    }
    runs = run + 1;
  }
  const pool = new Map<string, number>();
  for (const [c] of lines["+"]) if (strip(c)) pool.set(strip(c), (pool.get(strip(c)) ?? 0) + 1);
  const take = (l: [string, string, number]) => {
    const k = strip(l[0]);
    const n = pool.get(k) ?? 0;
    if (n) pool.set(k, n - 1);
    return !!k && !n;
  };
  const taken = lines["-"].filter(take);
  const fresh = lines["+"].filter((l) => !!strip(l[0]) && !take(l));
  const hatches = new Map<string, number>();
  const list = lang ? HATCHES[lang] : CONFIG_HATCHES;
  for (const [ls, sign] of [[taken, -1], [fresh, 1]] as const)
    for (const [c, b] of ls)
      for (const [name, re] of list) {
        const n = (lang ? b : c).match(re)?.length ?? 0;
        if (n) hatches.set(name, (hatches.get(name) ?? 0) + sign * n);
      }
  const key = ([c, , run]: [string, string, number]): [string, number] => [(lang === "tlc" && TLC_NARROW.test(c) ? NARROW : "") + strip(c), run];
  return { hatches, ...compareStatements(before, after), taken: taken.map(key), fresh: fresh.map(key), rocq };
}

/** A proof checker run, read from its command line. */
export interface ProofCheck {
  /** The language, or `make` or `dune` for a build that runs the checker. */
  lang: string;
  /** What a build or a Dafny command does: the make targets, `build` or `test` with dune's aliases, Dafny's subcommand. Another target is another check. */
  target?: string;
  /** The proof files named on the command line, sorted: a check of other files is not the same check. */
  path?: string;
  /** A flag that skips checking (`--no-verify`, `-o quick_and_dirty`). */
  bypass?: string;
  /** What the tool's exit status covers: `both` when the checker runs last, `green` when only `&&` follow it. */
  exit?: "both" | "green";
  /** A later command filters the output (grep, head), so an output with no error proves nothing. */
  filtered?: true;
  background?: true;
}

const CHECKER_HINT = /\b(?:coqc|coqchk|rocq|rocqchk|lake|lean|dafny|verus|isabelle|tlc2?|tla2tools|tlapm|apalache-mc|make|dune)\b/;
/** The jar that runs TLC by default: `java -jar tla2tools.jar MC.tla`. */
const TLC_JAR = /(?:^|[/\\])tla2tools\.jar$/;
const PROOF_ARG = /\.(?:v|lean|dfy|thy|tla|cfg)$/;
const FILTERS = new Set(["grep", "egrep", "fgrep", "rg", "head", "tail", "sed", "awk", "cut", "wc", "sort", "uniq", "jq"]);
/** Checker flags that skip the work, and the `-o` (Isabelle) and `-D` (Lean) options that do, unless set to false. */
const BYPASS_ARG = /^(?:--?no-verify|\/noVerify|--?type-in-type|-vos|-deadlock)$/;
const BYPASS_SET: Record<string, RegExp> = { o: /^(quick_and_dirty|skip_proofs)(?:=(?!false$).*)?$/, D: /^(debug\.skipKernelTC)(?:=(?!false$).*)?$/ };
const NOT_A_RUN = /^(?:--?version|--?help|-h)$/;
/** Output that only a proof checker prints: what makes a make or dune build a proof check. */
const ROCQ_OUT = /^File "[^"\n]*\.v", line \d+|^[ \t]*(?:COQC|COQDEP|ROCQ compile)[ \t]+\S+\.v\b/m;
const PROOF_OUT = new RegExp(
  `${ROCQ_OUT.source}|\\.lean:\\d+:\\d+:|Failed to finish proof|Unfinished session|\\.thy"|\\.dfy\\(\\d+,\\d+\\): Error|Dafny program verifier finished|verification results::|Model checking completed|is violated|TLC2 Version|Finished computing initial states|obligations? (?:failed|proved)`,
  "m",
);

/** The command a wrapper runs: `timeout 600 lake build`, `opam exec -- coqc A.v`, `nice -n 10 lake build`. */
function unwrap(c: SimpleCommand): [string, string[]] {
  let cmd = c.cmd;
  let args = c.args;
  for (let n = 0; n < 3; n++) {
    if (cmd === "timeout") {
      let k = 0;
      while (k < args.length && (args[k] as string).startsWith("-")) k += /^(?:-[sk]|--signal|--kill-after)$/.test(args[k] as string) ? 2 : 1;
      args = args.slice(k + 1);
    } else if (cmd === "nice") {
      let k = 0;
      while (k < args.length && (args[k] as string).startsWith("-")) k += /^(?:-n|--adjustment)$/.test(args[k] as string) ? 2 : 1;
      args = args.slice(k);
    } else if (cmd === "opam" && args[0] === "exec") {
      const k = args.indexOf("--");
      args = args.slice(k < 0 ? 1 : k + 1);
    } else break;
    cmd = (args[0] ?? "").replace(/^.*\//, "");
    args = args.slice(1);
  }
  return [cmd, args];
}

/** The language a checker command checks; undefined for any other command. */
function checkerLang(cmd: string, args: string[]): string | undefined {
  if (args.some((a) => NOT_A_RUN.test(a))) return undefined;
  const sub = args.find((a) => !a.startsWith("-")) ?? "";
  switch (cmd) {
    case "coqc":
      return args.some((a) => a.endsWith(".v")) ? "rocq" : undefined;
    case "coqchk":
    case "rocqchk":
      return "rocq";
    case "rocq":
      return /^(?:compile|c|check)$/.test(sub) ? "rocq" : undefined;
    case "lake":
      return /^(?:build|test|lean)$/.test(sub) || (sub === "env" && args.includes("lean")) ? "lean" : undefined;
    case "lean":
      return args.some((a) => a.endsWith(".lean")) ? "lean" : undefined;
    case "dafny":
      return /^(?:verify|build|run|test)$|\.dfy$|^\//.test(sub) ? "dafny" : undefined;
    case "verus":
      return "verus";
    case "cargo":
      return sub === "verus" ? "verus" : undefined;
    case "isabelle":
      return sub === "build" || sub === "process" ? "isabelle" : undefined;
    case "tlc":
    case "tlc2":
      return "tlc";
    case "java": {
      const jar = args.indexOf("-jar");
      return args.includes("tlc2.TLC") || (jar >= 0 && TLC_JAR.test(args[jar + 1] ?? "")) ? "tlc" : undefined;
    }
    case "tlapm":
      return "tla";
    case "apalache-mc":
      return sub === "check" ? "tla" : undefined;
    case "make":
      return args.some((a) => /^(?:clean|cleanall|distclean|install|uninstall|help|doc|html|vos|vio|quick|-n|--dry-run|--just-print)$/.test(a)) ? undefined : "make";
    case "dune":
      return sub === "build" || sub === "test" ? "dune" : undefined;
  }
  return undefined;
}

/** The make targets and variables as written, without the options that only change how make runs (`-j4`, `-k`, `-s`). */
function makeTarget(args: string[]): string {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (/^(?:-[jl]|--jobs|--load-average|--max-load)$/.test(a)) {
      if (/^\d+(?:\.\d+)?$/.test(args[k + 1] ?? "")) k++;
      continue;
    }
    if (/^(?:-[jl][\d.]*|--(?:jobs|load-average|max-load)=.*|-[ksBw]+|--(?:keep-going|silent|quiet|always-make|(?:no-)?print-directory))$/.test(a)) continue;
    out.push(a);
  }
  return out.join(" ");
}

/** What a build or Dafny command does, for the check's key. */
function targetOf(lang: string, sub: string, args: string[]): string | undefined {
  if (lang === "make") return makeTarget(args) || undefined;
  if (lang === "dune") return [sub, ...args.filter((a) => a.startsWith("@")).sort()].join(" ");
  if (lang === "dafny" && /^(?:verify|build|run|test)$/.test(sub)) return sub;
  return undefined;
}

/** A checker flag that skips checking, as `--no-verify`, `-o quick_and_dirty` or `debug.skipKernelTC`. */
function bypassOf(args: string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (BYPASS_ARG.test(a)) return a;
    const o = /^-([oD])(.*)$/.exec(a);
    const v = o ? BYPASS_SET[o[1] as string]?.exec(o[2] || (args[k + 1] ?? "")) : undefined;
    if (v) return o?.[1] === "o" ? `-o ${v[1]}` : v[1];
  }
  return undefined;
}

/** A path that does not start under the directory a `cd` moved to. */
const ROOTED = /^(?:\/|[A-Za-z]:\/|~)/;
/**
 * A `(` that opens a subshell, after an operator, and a run of `)` that closes one, before an
 * operator, a redirection or the end. A run of `)` is tried once, from its first `)`.
 */
const SUBSHELL = /(^|&&|\|\||[;&|\n])([ \t]*)\(+|(?<!\))(?=(\)+))\3(?=[ \t]*(?:[;&|\n<>]|\d+[<>]|$))/g;

/**
 * The simple commands a command line runs. The commands in a subshell read as if they ran outside
 * it, and the script of a `bash -c` takes the shell's place: its commands run in the shell's
 * directory, and the last one takes the shell's operator. Three shells deep at most.
 */
function runCommands(command: string, depth = 0, dir?: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const text = command.replace(SUBSHELL, (_, op?: string, space?: string) => (op === undefined ? " " : `${op}${space ?? ""} `));
  for (const c of simpleCommands(text, { quotes: true })) {
    if (c.name === "") continue;
    const under = dir === undefined || (c.dir !== undefined && ROOTED.test(c.dir)) ? c.dir : c.dir === undefined ? dir : posix.join(dir, c.dir);
    const [cmd, args] = unwrap(c);
    const script = depth < 3 ? shellScript({ cmd, args }) : undefined;
    const inner = script === undefined ? [] : runCommands(script, depth + 1, under);
    const last = inner[inner.length - 1];
    if (!last) {
      out.push(under === c.dir ? c : { ...c, dir: under as string });
      continue;
    }
    // A command the script puts in the background stays there.
    if (last.sep !== "&") {
      if (c.sep === undefined) delete last.sep;
      else last.sep = c.sep;
    }
    out.push(...inner);
  }
  return out;
}

/**
 * The proof check a shell command line runs: its last checker command, if it has one. Quoted words
 * stay whole: `git commit -m "WIP; lake build"` runs no check.
 */
export function proofCheck(command: string, input?: unknown): ProofCheck | undefined {
  if (!CHECKER_HINT.test(command)) return undefined;
  const cmds = runCommands(command);
  let at = -1;
  let lang: string | undefined;
  let args: string[] = [];
  for (let k = 0; k < cmds.length; k++) {
    const [cmd, a] = unwrap(cmds[k] as SimpleCommand);
    const l = checkerLang(cmd, a);
    if (l) [at, lang, args] = [k, l, a];
  }
  if (lang === undefined) return undefined;
  const c = cmds[at] as SimpleCommand;
  const files = args.filter((a) => PROOF_ARG.test(a)).map((a) => (c.dir && !ROOTED.test(a) ? posix.join(c.dir, a) : a));
  // make and dune pass their arguments to the build, not to a checker.
  const bypass = lang === "make" || lang === "dune" ? undefined : bypassOf(args);
  const target = targetOf(lang, args.find((a) => !a.startsWith("-")) ?? "", args);
  const exit = at === cmds.length - 1 ? "both" : cmds.slice(at, -1).every((x) => x.sep === "&&") ? "green" : undefined;
  const background = c.sep === "&" || (!!input && typeof input === "object" && (input as { run_in_background?: unknown }).run_in_background === true);
  const check: ProofCheck = { lang };
  if (target) check.target = target;
  if (files.length) check.path = files.sort().join(" ");
  if (bypass) check.bypass = bypass;
  if (exit) check.exit = exit;
  if (cmds.slice(at + 1).some((x) => FILTERS.has(x.cmd))) check.filtered = true;
  if (background) check.background = true;
  return check;
}

/** What a harness writes, at the start of a line, when a call went to the background or ran out of time. */
const STILL_RUNNING = /^[ \t]*(?:Error: )?(?:exec )?command (?:running in (?:the )?background|timed out)\b/im;
/** The line Claude Code puts first when a call ends with an exit status other than 0. */
const EXIT_LINE = /^\s*(?:Error: )?Exit code -?\d+[^\n]*\n?/;
/** What a harness writes in place of the output when the user turned a call down or stopped it. */
const TURNED_DOWN =
  /^\s*(?:Error: )?(?:The user doesn'?t want to proceed with this tool use|(?:The )?tool use was rejected|\[Request interrupted by user|[\w ]{0,40}?\b(?:rejected|denied) by (?:the )?user\b)/i;
/** The programs that run each kind of check. A make or dune build runs any of them. */
const PROGRAMS: Record<string, readonly string[]> = {
  lean: ["lake", "lean"],
  rocq: ["coqc", "coqchk", "rocq", "rocqchk"],
  dafny: ["dafny"],
  verus: ["verus", "cargo"],
  isabelle: ["isabelle"],
  tlc: ["tlc", "tlc2", "java", "tla2tools.jar"],
  tla: ["tlapm", "apalache-mc"],
};
/** The commands that start a checker (`timeout 600 lake build`, `opam exec -- coqc A.v`, `nice lake build`). */
const WRAPPERS = ["timeout", "opam", "nice"];
/**
 * A line in which a shell, make, env, cmd or PowerShell says it found no program by that name, or
 * java says it could not open the jar. The name is the first group that matched.
 */
const NO_PROGRAM =
  /^(?:[^\s:]+: )?(?:line \d+: |\d+: )?(?:[^\s:']*\/)?'?([\w.+-]+)'?: (?:[Cc]ommand not found|not found|No such file or directory)(?: \[[^\]\n]*\])?$|^[^\s:]*sh(?::\d+)?: command not found: (?:[^\s:]*\/)?([\w.+-]+)$|^(?:[\w.+-]+ ?: )?The term '(?:[^'\n]*[/\\])?([\w.+-]+)' is not recognized\b|^'(?:[^'\n]*[/\\])?([\w.+-]+)' is not recognized as an internal or external command\b|^(?:fish: Unknown command:|\[ERROR\] Command not found|timeout: failed to run command) '?(?:[^'\s]*\/)?([\w.+-]+?)'?(?:: No such file or directory)?$|^Error: Unable to access jarfile (?:\S*[/\\])?([\w.+-]+)$/;
const MAYBE_NO_PROGRAM = /not (?:found|recognized)|No such file|Unknown command|Unable to access jarfile/i;
/** A line in which make reports a failed recipe. */
const MAKE_STATUS = /^g?make(?:\[\d+\])?: \*\*\* /;

/**
 * The output without the lines that say one of the check's own programs was not found, and without
 * make's report of the recipe that failed for it; undefined when no line says so.
 */
function withoutNotFound(lang: string, out: string): string | undefined {
  if (!MAYBE_NO_PROGRAM.test(out)) return undefined;
  const own = new Set([...WRAPPERS, ...(lang === "make" || lang === "dune" ? [lang, ...Object.values(PROGRAMS).flat()] : (PROGRAMS[lang] ?? []))]);
  const lines = out.split("\n");
  const kept = lines.filter((line) => {
    const m = NO_PROGRAM.exec(line.trimEnd());
    const name = m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? "").replace(/\.exe$/i, "") : "";
    return !own.has(name);
  });
  return kept.length < lines.length ? kept.filter((line) => !MAKE_STATUS.test(line)).join("\n") : undefined;
}
/**
 * Errors in a checker's output. A hole the checker only warns about (Lean's `declaration uses
 * 'sorry'`) is not one: a hole left anywhere in the project would keep every check red.
 */
const ERROR = /\berror:|\bError:|\b[1-9]\d* errors?\b|^\*\*\* |\bis violated\b|make: \*\*\*|\[ERROR\]|EXITCODE: ERROR/m;

/** A tool's output as text: a string, or the stdout, stderr and output fields of an object. */
export function outText(out: unknown): string {
  if (typeof out === "string") return out;
  if (!out || typeof out !== "object") return "";
  const o = out as Record<string, unknown>;
  return [o.stdout, o.stderr, o.output].filter((x): x is string => typeof x === "string").join("\n");
}

/**
 * What a check's tool.end says: red, green, or nothing to go on. There is nothing to go on when the
 * call ran in the background, was interrupted or was turned down, or when the checker's exit status
 * is 126 or 127, which means it never ran. Then an error line makes the check red, whatever else
 * the output says. For a call that timed out or went to the background, the lines the harness wrote
 * about it, and the exit status line before them, are not read for errors. Otherwise there is
 * nothing to go on when the call timed out or went to the background, when a line says the checker
 * was not found, or when the output is clipped.
 */
export function checkOutcome(check: ProofCheck, end: Record<string, unknown>): "red" | "green" | undefined {
  if (check.background || end.interrupted === true) return undefined;
  const out = outText(end.output);
  if (TURNED_DOWN.test(out)) return undefined;
  const code = exitCodeOf(end.exitCode, out);
  if (check.exit && (code === 126 || code === 127)) return undefined;
  const running = STILL_RUNNING.test(out);
  const text = running ? out.replace(EXIT_LINE, "").split("\n").filter((line) => !STILL_RUNNING.test(line)).join("\n") : out;
  const rest = withoutNotFound(check.lang, text);
  if (ERROR.test(rest ?? text)) return "red";
  if (rest !== undefined || running) return undefined;
  if (check.exit === "both" && end.ok === false) return "red";
  if (check.exit) return end.ok === true ? "green" : undefined;
  if (out.endsWith("…") || (!!end.cut && typeof end.cut === "object")) return undefined;
  return out.trim() && !check.filtered ? "green" : undefined;
}

/** What the session did to one proof, spec or build file. Statement keys are names; `#lines` and `#gone` stand for the file's lines and the file itself. */
export interface ProofFile {
  /** Escape hatches the agent put in and has not taken out, by name. */
  sites?: Map<string, number>;
  /** Statements the agent changed: [text key before (null: the agent added it), text key now (null: removed)]. */
  stmts?: Map<string, [string | null, string | null]>;
  /** Pinned, spec-named and build files: each line's count put in minus taken out; UNREAD when a change could not be read. */
  lines?: Map<string, number>;
  /**
   * For each of those lines, the number of outcomes read before the agent last moved its count away
   * from zero, or took out a line it had put in in the same run of a diff.
   */
  lineAt?: Map<string, number>;
  /** For each of those lines, the run of a diff that last moved its count away from zero: the change's event id and the run's number. */
  lineRun?: Map<string, string>;
  /** The agent made the file; `made`: the shell call that wrote it, until a diff says it was there before. */
  added?: true;
  made?: string;
  /** The agent deleted the file and what it held is unknown. */
  gone?: true;
  /** A language found from the text (`.rs`, `.cfg`), kept for diffs that do not show it. */
  lang?: "verus" | "tlc";
  /** Changed keys since the last passing check, each with the number of outcomes read before the change. */
  touched?: Map<string, number>;
  /** Keys whose change turned a failing check green and that are still changed. */
  flipped?: Set<string>;
  /** Its path, kept once the log of changes (ProofState.log) holds it. */
  path?: string;
}

/** A check that failed and has not passed since. */
export interface ProofRed {
  /** Its tool.end, and the number of that outcome: a pass flips only what changed after it. */
  at: string;
  seq: number;
  /** The length of the log of changes when it failed: a pass reads the log from there. */
  log?: number;
  /** It failed after the agent changed code that is not a proof since a pass. */
  own?: true;
  /** The agent changed code that is not a proof since it failed, so a pass may come from the code. */
  broken?: true;
}

/** A check that ended. The file changes its call made arrive after its end. */
export interface ProofRun {
  id: string;
  /** Its tool.end, and the failing one before it when it passed after a failure (`flip`). */
  at: string;
  before?: string;
  /** The number of its outcome, when it had one. */
  seq?: number;
  green?: true;
  flip?: true;
}

export interface ProofState {
  files?: Map<string, ProofFile>;
  /**
   * The keys changed since a pass left no check failing, each with its file, in order. A pass reads
   * the changes made after its failure, and clears the files the log holds. A state an older build
   * saved has no log until such a pass, and reads every file until then.
   */
  log?: [ProofFile, string][];
  /** The log's length when it was last cut to the latest change of each key in a file still held. */
  logCut?: number;
  /** Checks started and not yet ended, by call id (the last 8). */
  runs?: [string, ProofCheck][];
  /** Checks that ended (the last 8). */
  ran?: ProofRun[];
  /** Recent moves of proof files: [call id, from, to] (the last 8). */
  moves?: [string, string, string][];
  /** Failing checks, by language and files (the last 8). */
  reds?: Map<string, ProofRed>;
  /** Set at each pass; `edited`: the agent changed code that is not a proof since. */
  green?: { edited?: true };
  /** The key of a failed check that a run with a bypass flag then passed, until a run without one passes. */
  bypass?: string;
  /** Check outcomes read so far. */
  seq?: number;
  /** A Rocq check ran, a check printed Rocq output, or a diff showed a Rocq sentence: `.v` files are Rocq. */
  rocq?: true;
  /** A TLC or TLA+ check ran: `.cfg` files with TLC directives are TLC models. */
  tlc?: true;
  /** The `.tla` files changed (the last 8): a `.cfg` beside one is its model. */
  tla?: string[];
}
/** The holder of the state, made on first use: core/intent.ts's TamperState. */
export interface HasProof {
  proof?: ProofState;
}

export type ProofShape = "weaken" | "delete" | "escape" | "unknown";
/** What a trace reader is told as the state changes (core/intent.ts turns notes into findings). */
export type ProofNote =
  | { kind: "check"; e: AgentEvent; flips: [string, string][]; before: string }
  | { kind: "bypass"; e: AgentEvent; flag: string; before: string }
  | { kind: "hatch"; e: AgentEvent; path: string; hatch: string; open: boolean }
  | { kind: "change"; e: AgentEvent; path: string; key: string; shape: ProofShape; tampered: boolean; flip?: { before: string; after: string } }
  | { kind: "move"; from: string; to: string };
type Note = ((n: ProofNote) => void) | undefined;

const RECENT = 8;
const FILE_CAP = 1000;
const LINE_CAP = 2000;
const STMT_CAP = 2000;
const OUTSIDE = /^(?:\/|[A-Za-z]:\/|~|\.\.\/)/;
/** Docs, logs, proof build products, tool folders and paths outside the repo: changing them is not changing code. */
const NOT_CODE = /(?:^|\/)\.[^/]+\/|\.(?:md|markdown|txt|rst|org|adoc|log|out|lock|vo|vos|vok|glob|aux|olean|ilean|hash|trace)$|^(?:\/|[A-Za-z]:\/|~|\.\.\/)/i;

/** An escape hatch the agent put in is still there. A count below zero is one the agent took out of the file as the session found it. */
const opened = (f: ProofFile) => [...(f.sites?.values() ?? [])].some((n) => n > 0);
/** The file holds an escape hatch the agent put in or a flipped change: its findings stand, so it is kept. */
const pinned = (f: ProofFile) => !!f.flipped?.size || opened(f);

/**
 * The file at `path`, made on first use. Once `files` holds FILE_CAP files, a new one takes the
 * place of the first that is not pinned. When every file is pinned, none is taken out and `files`
 * grows past the cap.
 */
function fileOf(ps: ProofState, path: string): ProofFile {
  const files = (ps.files ??= new Map());
  let f = files.get(path);
  if (f) return f;
  if (files.size >= FILE_CAP) makeRoom(ps);
  files.set(path, (f = {}));
  const ix = placeLast(ps, f, path);
  if (ix) {
    push(ix.free, [ix.next, f]);
    if (ix.free.length > 2 * files.size + 256) {
      ix.free = [];
      for (const g of files.values()) if (!ix.aside.has(g)) push(ix.free, [(ix.place.get(g) as [number, string])[0], g]);
    }
  }
  return f;
}

/** Take out the first file in `files` that is not pinned, if there is one. */
function makeRoom(ps: ProofState): void {
  const ix = indexOf(ps);
  const v = firstOf(ps, ix, ix.free, (g) => !pinned(g), ix.aside);
  const p = v && ix.place.get(v);
  if (p) ps.files?.delete(p[1]);
}

/** A file set aside while pinned goes back among the files that can make room once it is not. */
function settle(ps: ProofState, f: ProofFile): void {
  const ix = INDEXES.get(ps);
  const p = ix?.place.get(f);
  if (!ix || !p || !ix.aside.has(f) || pinned(f)) return;
  ix.aside.delete(f);
  push(ix.free, [p[0], f]);
}

const prune = (ps: ProofState, path: string, f: ProofFile) => {
  if (!f.sites?.size && !f.stmts?.size && !f.lines?.size && !f.added && !f.gone && !f.lang && !f.touched?.size && !f.flipped?.size) ps.files?.delete(path);
};

/** The state, made on first use with an empty log of changes. */
const stateOf = (h: HasProof): ProofState => (h.proof ??= { log: [] });

/** The file is still the one at its path: not moved over, deleted or dropped. */
const held = (ps: ProofState, f: ProofFile) => f.path !== undefined && ps.files?.get(f.path) === f;

/** A file queued by its place in `ProofState.files` when it was queued. */
type Queued = [number, ProofFile];

/**
 * Kept beside a state, and made again from its files when the state is loaded: each held file's
 * place in `files` and its path; by "+" or "-" and a name, the files whose record of that statement
 * a statement moved from another file can match; and the files that can make room for a new one.
 * An entry whose file moved since it was queued goes back at the new place when it comes up; one
 * whose file left `files` or no longer matches is dropped then. A pinned file that comes up to make
 * room is set aside until it is not pinned.
 */
interface ProofIndex {
  place: WeakMap<ProofFile, [number, string]>;
  next: number;
  loose: Map<string, Queued[]>;
  /** Each held file that is not set aside, by its place. */
  free: Queued[];
  aside: WeakSet<ProofFile>;
}
const INDEXES = new WeakMap<ProofState, ProofIndex>();

/** A record a statement moved from another file can match: "+" the agent added it, "-" the agent removed it. */
const looseKind = (r: [string | null, string | null] | undefined) => (!r ? undefined : r[0] === null ? "+" : r[1] === null ? "-" : undefined);

function push(heap: Queued[], q: Queued): void {
  let i = heap.push(q) - 1;
  while (i > 0) {
    const up = (i - 1) >> 1;
    const p = heap[up] as Queued;
    if (p[0] <= q[0]) break;
    heap[i] = p;
    i = up;
  }
  heap[i] = q;
}

function pop(heap: Queued[]): void {
  const last = heap.pop() as Queued;
  let i = 0;
  for (let c = 1; c < heap.length; c = 2 * i + 1) {
    if (c + 1 < heap.length && (heap[c + 1] as Queued)[0] < (heap[c] as Queued)[0]) c++;
    if ((heap[c] as Queued)[0] >= last[0]) break;
    heap[i] = heap[c] as Queued;
    i = c;
  }
  if (heap.length) heap[i] = last;
}

/** The index of the state, made from its files the first time it is asked for. */
function indexOf(ps: ProofState): ProofIndex {
  let ix = INDEXES.get(ps);
  if (ix) return ix;
  ix = { place: new WeakMap(), next: 0, loose: new Map(), free: [], aside: new WeakSet() };
  for (const [path, f] of ps.files ?? []) {
    ix.place.set(f, [++ix.next, path]);
    push(ix.free, [ix.next, f]);
    for (const [name, r] of f.stmts ?? []) {
      const k = looseKind(r);
      if (k) queue(ix, k + name, f);
    }
  }
  INDEXES.set(ps, ix);
  return ix;
}

/** The file just went last in `files`, at `path`. */
function placeLast(ps: ProofState, f: ProofFile, path: string): ProofIndex | undefined {
  const ix = INDEXES.get(ps);
  if (ix) ix.place.set(f, [++ix.next, path]);
  return ix;
}

function queue(ix: ProofIndex, key: string, f: ProofFile): void {
  const p = ix.place.get(f);
  if (!p) return;
  let heap = ix.loose.get(key);
  if (!heap) ix.loose.set(key, (heap = []));
  push(heap, [p[0], f]);
}

/** The queued file that comes first in `files` and that `ok` takes. A held file `ok` turns down leaves the queue, for `aside` when given. */
function firstOf(ps: ProofState, ix: ProofIndex, heap: Queued[], ok: (f: ProofFile) => boolean, aside?: WeakSet<ProofFile>): ProofFile | undefined {
  for (let q = heap[0]; q; q = heap[0]) {
    const p = ix.place.get(q[1]);
    const here = p !== undefined && ps.files?.get(p[1]) === q[1];
    const live = here && ok(q[1]);
    if (live && p[0] === q[0]) return q[1];
    pop(heap);
    if (live) push(heap, [p[0], q[1]]);
    else if (here) aside?.add(q[1]);
  }
  return undefined;
}

/** True the first time `seen` meets the key of the file. */
function first(seen: Map<ProofFile, Set<string>>, f: ProofFile, key: string): boolean {
  let keys = seen.get(f);
  if (keys?.has(key)) return false;
  if (!keys) seen.set(f, (keys = new Set()));
  keys.add(key);
  return true;
}

/**
 * Log a change. Once the log is twice as long as after its last cut, cut it to the latest change
 * of each key in a file still held, and move each failure's place in it to match: a pass still
 * reads the same keys.
 */
function logChange(ps: ProofState, f: ProofFile, path: string, key: string): void {
  const log = ps.log;
  if (!log) return;
  f.path = path;
  if (log.push([f, key]) < 2 * (ps.logCut ?? 0) + 256) return;
  const seen = new Map<ProofFile, Set<string>>();
  const keep = log.map(() => false);
  for (let i = log.length - 1; i >= 0; i--) {
    const [g, k] = log[i] as [ProofFile, string];
    keep[i] = held(ps, g) && first(seen, g, k);
  }
  const place = [0];
  keep.forEach((k, i) => place.push((place[i] as number) + (k ? 1 : 0)));
  for (const r of ps.reds?.values() ?? []) if (r.log !== undefined) r.log = place[r.log] as number;
  ps.log = log.filter((_, i) => keep[i]);
  ps.logCut = ps.log.length;
}

/** The keys changed from the log's `from`th change on, once each, in files still held: [path, file, key]. */
function changedSince(ps: ProofState, from: number): [string, ProofFile, string][] {
  const seen = new Map<ProofFile, Set<string>>();
  const out: [string, ProofFile, string][] = [];
  for (const [f, key] of ps.log?.slice(from) ?? []) if (held(ps, f) && first(seen, f, key)) out.push([f.path as string, f, key]);
  return out;
}

/**
 * Whether a key of the file is changed from what the session started with. With `since`, a line
 * counts only when the agent changed it after that many outcomes: a line changed before a failure
 * does not count at a pass because other lines changed after it. Taking out a line the agent put
 * in its place changes it again (readLines).
 */
export function proofTampered(f: ProofFile, key: string, since?: number): boolean {
  if (key === "#gone") return !!f.gone;
  if (key === "#lines") {
    for (const [k, n] of f.lines ?? [])
      if ((k === UNREAD || (k.startsWith(NARROW) ? n > 0 : n < 0)) && (since === undefined || (f.lineAt?.get(k) ?? since) >= since)) return true;
    return false;
  }
  const r = f.stmts?.get(key);
  return !!r && r[0] !== null && r[0] !== r[1];
}

const runOf = (ps: ProofState, id: string | undefined) => (id === undefined ? undefined : ps.ran?.find((r) => r.id === id));
/** The number of outcomes read before a change. A change by a call that ran a check comes before its outcome. */
const stampOf = (ps: ProofState, run: ProofRun | undefined) => (run?.seq !== undefined ? run.seq - 1 : (ps.seq ?? 0));

/**
 * A key changed: log it, and keep it for the next pass. A change made by a call that also ran a
 * check comes before the check: after a pass it is not kept, and after a pass that followed a
 * failure it flips.
 */
function touch(ps: ProofState, f: ProofFile, path: string, key: string, shape: ProofShape, e: AgentEvent, id: string | undefined, note: Note): void {
  const t = proofTampered(f, key);
  const run = runOf(ps, id);
  let flip: { before: string; after: string } | undefined;
  if (!t) {
    f.flipped?.delete(key);
    settle(ps, f);
  } else if (!run?.green) (f.touched ??= new Map()).set(key, stampOf(ps, run));
  else if (run.flip && proofTampered(f, key, stampOf(ps, run))) {
    (f.flipped ??= new Set()).add(key);
    flip = { before: run.before as string, after: run.at };
  }
  logChange(ps, f, path, key);
  if (!note) return;
  const n: Extract<ProofNote, { kind: "change" }> = { kind: "change", e, path, key, shape, tampered: t };
  if (flip) n.flip = flip;
  note(n);
}

function closeSites(f: ProofFile, path: string, e: AgentEvent, note: Note): void {
  for (const [h, n] of f.sites ?? []) if (n > 0) note?.({ kind: "hatch", e, path, hatch: h, open: false });
  delete f.sites;
}

/** A shell call starts: keep the proof check it runs until it ends. */
export function proofStart(h: HasProof, id: string | undefined, cmd: string, input: unknown): void {
  const check = id === undefined ? undefined : proofCheck(cmd, input);
  if (!check) return;
  const ps = stateOf(h);
  if (check.lang === "rocq") ps.rocq = true;
  if (check.lang === "tlc" || check.lang === "tla") ps.tlc = true;
  (ps.runs ??= []).push([id as string, check]);
  if (ps.runs.length > RECENT) ps.runs.shift();
}

/** Checks are the same when they check the same language, build target and files. */
const checkKey = (c: ProofCheck) => `${c.lang}\u0000${c.target ?? ""}\u0000${c.path ?? ""}`;
/** For a `dafny build`, the key of a `dafny verify` of the same files: a build verifies them first. */
const verifyKey = (c: ProofCheck) => (c.lang === "dafny" && c.target === "build" ? checkKey({ ...c, target: "verify" }) : undefined);

/**
 * A shell call ends: what its check says. A pass after a failure of the same check flips the
 * changes made after its last failure that still stand, unless the agent changed code outside the
 * proofs since the failure, or the failure came after such a change. A pass with a bypass flag
 * after a failure stands until the check passes without one. A `dafny build` with a bypass flag
 * also stands after a failed `dafny verify` of the same files, until either passes without one. A
 * make or dune build counts as a check once its output shows a proof checker ran.
 */
export function proofEnd(h: HasProof, e: AgentEvent, note?: Note): void {
  const ps = h.proof;
  const id = e.payload?.toolUseId;
  const k = ps?.runs?.findIndex(([r]) => r === id) ?? -1;
  if (!ps?.runs || k < 0) return;
  const check = (ps.runs.splice(k, 1)[0] as [string, ProofCheck])[1];
  if (!ps.runs.length) delete ps.runs;
  const run: ProofRun = { id: id as string, at: e.id };
  if ((ps.ran ??= []).push(run) > RECENT) ps.ran.shift();
  const text = outText(e.payload?.output);
  if (ROCQ_OUT.test(text)) ps.rocq = true;
  const out = checkOutcome(check, e.payload ?? {});
  if (!out) return;
  const key = checkKey(check);
  const was = ps.reds?.get(key);
  if ((check.lang === "make" || check.lang === "dune") && !was && !PROOF_OUT.test(text)) return;
  const seq = (ps.seq = (ps.seq ?? 0) + 1);
  run.seq = seq;
  const reds = (ps.reds ??= new Map());
  if (check.bypass) {
    const of = was ? key : verifyKey(check);
    const failed = of === undefined ? undefined : reds.get(of);
    if (out === "green" && of !== undefined && failed) {
      ps.bypass = of;
      note?.({ kind: "bypass", e, flag: check.bypass, before: failed.at });
    }
  } else if (out === "red") {
    reds.delete(key);
    const red: ProofRed = { at: e.id, seq };
    if (ps.log) red.log = ps.log.length;
    if (ps.green?.edited) red.own = true;
    reds.set(key, red);
    if (reds.size > RECENT) reds.delete(reds.keys().next().value as string);
  } else {
    run.green = true;
    const flips: [string, string][] = [];
    if (was && !was.own && !was.broken) {
      run.flip = true;
      run.before = was.at;
      // The keys changed since the failure; every file's for a failure an older build saved.
      const since = ps.log && was.log !== undefined ? changedSince(ps, was.log) : [...(ps.files ?? [])].flatMap(([path, f]) => [...(f.touched?.keys() ?? [])].map((t): [string, ProofFile, string] => [path, f, t]));
      for (const [path, f, t] of since) {
        const at = f.touched?.get(t);
        if (at !== undefined && at >= was.seq && proofTampered(f, t, was.seq)) {
          (f.flipped ??= new Set()).add(t);
          flips.push([path, t]);
        }
      }
    }
    reds.delete(key);
    if (!reds.size) {
      // Only the files in the log hold changed keys, but in a state an older build saved.
      const changed = ps.log ? [...new Set(ps.log.map(([f]) => f))].filter((f) => held(ps, f)).map((f): [string, ProofFile] => [f.path as string, f]) : [...(ps.files ?? [])];
      for (const [path, f] of changed) {
        delete f.touched;
        prune(ps, path, f);
      }
      ps.log = [];
      delete ps.logCut;
    }
    if (ps.bypass === key || ps.bypass === verifyKey(check)) delete ps.bypass;
    ps.green = {};
    if (flips.length) note?.({ kind: "check", e, flips, before: was?.at as string });
  }
  if (!reds.size) delete ps.reds;
}

/**
 * The language of `path` as the session knows it: from the text or an earlier diff. A `.v` file is
 * Verilog as likely as Rocq. Its diff is Rocq when the text has a Rocq sentence, or when it has no
 * Verilog line and the file or the session showed Rocq before. A `.cfg` file is a TLC model once a
 * TLC check ran or the `.tla` file of the same name changed.
 */
function langOf(ps: ProofState | undefined, path: string, text = ""): ProofLang | undefined {
  const f = ps?.files?.get(path);
  const lang = proofLang(path, text, f?.lang);
  if (lang === "rocq" && ((!f && !ps?.rocq) || verilogLine(text)) && !ROCQ_SENTENCE.test(rocqText(text))) return undefined;
  if (lang === "tlc" && f?.lang !== "tlc" && !ps?.tlc && !ps?.tla?.includes(path.replace(/\.cfg$/, ".tla"))) return undefined;
  return lang;
}

/** A call that runs a check, or ran one of the last ones: what it writes (a log, a build product) is not an edit. */
const checkCall = (ps: ProofState, id: string | undefined): boolean =>
  id !== undefined && (!!ps.runs?.some(([r]) => r === id) || !!ps.ran?.some((r) => r.id === id));

/**
 * A file that is not a proof, a spec or a build file changed: a pass after it may come from the
 * change. `mine`: the agent made the change, so a failure after it is the agent's own. `test`: a
 * test file, which counts as code whatever its language.
 */
export function proofSourceWrite(h: HasProof, path: string, id: string | undefined, mine: boolean, test = false): void {
  const ps = h.proof;
  if (!ps || NOT_CODE.test(path) || (!test && (isProofConfig(path) || langOf(ps, path))) || checkCall(ps, id)) return;
  for (const r of ps.reds?.values() ?? []) r.broken = true;
  if (mine && ps.green) ps.green.edited = true;
}

/** True while an escape hatch the agent put in stays, a bypass stands, or a flipped change stands. */
export function proofHigh(ps: ProofState | undefined): boolean {
  if (!ps) return false;
  if (ps.bypass) return true;
  for (const f of ps.files?.values() ?? []) if (pinned(f)) return true;
  return false;
}

/** What the session knows of `from` moves to `to`, over what it knew of `to`. */
function moveFile(ps: ProofState, from: string, to: string, e: AgentEvent, note: Note): void {
  const old = ps.files?.get(to);
  if (old) closeSites(old, to, e, note);
  ps.files?.delete(to);
  const f = ps.files?.get(from);
  if (f) {
    ps.files?.delete(from);
    ps.files?.set(to, f);
    f.path = to;
    placeLast(ps, f, to);
  }
  note?.({ kind: "move", from, to });
}

/** The agent deleted a proof file and what it held is unknown: it is gone, unless the agent made it. */
function dropFile(ps: ProofState, path: string, e: AgentEvent, id: string | undefined, note: Note): void {
  const f = ps.files?.get(path);
  if (f) closeSites(f, path, e, note);
  if (f?.added) {
    ps.files?.delete(path);
    return;
  }
  const g = fileOf(ps, path);
  g.gone = true;
  settle(ps, g);
  touch(ps, g, path, "#gone", "delete", e, id, note);
}

const sameKind = (a: string, b: string) => (isProofConfig(a) && isProofConfig(b)) || extOf(a) === extOf(b);

/**
 * A shell command writes a file, as read from its command line before it runs. A proof file it
 * deletes, or moves out of the repo or to a file of another kind, is gone; one moved to a file of
 * its kind keeps what the session knew. A proof file it creates is the agent's own until a diff
 * shows it was there before. Other files are code, test files (`test`) included.
 */
export function proofWrite(h: HasProof, e: AgentEvent, w: { op: string }, path: string, to: string | undefined, id: string | undefined, test = false, note?: Note): void {
  if (test || (!isProofConfig(path) && !langOf(h.proof, path))) return proofSourceWrite(h, path, id, true, test);
  if (OUTSIDE.test(path)) return;
  const ps = stateOf(h);
  if (w.op === "delete") {
    if (to !== undefined && !OUTSIDE.test(to) && sameKind(path, to)) {
      moveFile(ps, path, to, e, note);
      if ((ps.moves ??= []).push([id ?? "", path, to]) > RECENT) ps.moves.shift();
    } else dropFile(ps, path, e, id, note);
    return;
  }
  if (w.op !== "create" || ps.files?.has(path) || ps.moves?.some(([m, , t]) => m === (id ?? "") && t === path)) return;
  const f = fileOf(ps, path);
  f.added = true;
  if (id !== undefined) f.made = id;
}

/** A file change as core/intent.ts reads it: the repo-relative path, where a move put it, who made it, and whether a pattern pins it. */
export interface ProofTarget {
  path: string;
  /** Where a move put the file. */
  to?: string | undefined;
  origin: ShellDiffOrigin;
  prot: boolean;
  /** A test file (core/intent.ts): it gets the generic test reading, not the proof reading. */
  test?: boolean;
}

/**
 * A file changed. Proof, spec and build files are read here: escape hatches, statements and, for
 * pinned, spec-named and build files, lines. True when the generic test reading should skip the
 * file: every proof file but Verus `.rs` files, which can hold Rust tests too. A test file is not
 * read here and returns false.
 */
export function proofChange(h: HasProof, e: AgentEvent, t: ProofTarget, note?: Note): boolean {
  const p = e.payload ?? {};
  const id = typeof p.toolUseId === "string" ? p.toolUseId : undefined;
  const mine = t.origin === "edit" || t.origin === "named";
  const diff = typeof p.diff === "string" ? p.diff : "";
  let path = t.path;
  const lang = t.test || isProofConfig(path) ? undefined : langOf(h.proof, path, diff);
  if (t.test || (!lang && !isProofConfig(path))) {
    proofSourceWrite(h, path, id, mine, t.test);
    return false;
  }
  const handled = lang !== "verus";
  if (OUTSIDE.test(path)) return handled;
  const ps = stateOf(h);
  if (lang === "tla" && !ps.tla?.includes(path)) {
    (ps.tla ??= []).push(path);
    if (ps.tla.length > RECENT) ps.tla.shift();
  }
  if (!mine && !checkCall(ps, id)) for (const r of ps.reds?.values() ?? []) r.broken = true;
  let op = typeof p.op === "string" ? p.op : "modify";
  // A move the command line showed: its delete and its add are not changes.
  if (ps.moves?.some(([m, from, to]) => m === (id ?? "") && ((op === "delete" && from === path) || (op === "add" && to === path)))) return handled;
  if (t.to !== undefined) {
    if (OUTSIDE.test(t.to) || !sameKind(path, t.to)) {
      if (mine) dropFile(ps, path, e, id, note);
      return handled;
    }
    moveFile(ps, path, t.to, e, note);
    path = t.to;
    op = "modify";
  }
  const f = fileOf(ps, path);
  if (lang === "verus" || lang === "tlc") f.lang = lang;
  if (f.made !== undefined && f.made === id) {
    if (op !== "add") delete f.added;
    delete f.made;
  }
  // A file written back after a delete is there again; what it holds reads as new.
  if (op === "add") {
    if (f.gone) {
      delete f.gone;
      touch(ps, f, path, "#gone", "delete", e, id, note);
    } else if (mine && !f.stmts?.size && !f.lines?.size) f.added = true;
  }
  const truncated = p.diffTruncated === true;
  const d = readProofDiff(path, lang, diff, truncated);
  if (d.rocq && lang === "rocq") ps.rocq = true;
  if (!PROOF_TEST.test(path))
    for (const [name, n] of d.hatches) {
      // Hatches put in minus taken out, from the file as the session found it: taking one out
      // and putting it back nets to zero. A change by anyone else only moves the count toward zero.
      const was = f.sites?.get(name) ?? 0;
      let now = was + n;
      if (!mine) now = was > 0 ? Math.max(0, Math.min(was, now)) : Math.min(0, Math.max(was, now));
      if (now === was) continue;
      if (now) (f.sites ??= new Map()).set(name, now);
      else f.sites?.delete(name);
      if (was > 0 !== now > 0) note?.({ kind: "hatch", e, path, hatch: name, open: now > 0 });
    }
  if (f.sites && !f.sites.size) delete f.sites;
  settle(ps, f);
  if (op === "delete" && (!diff || truncated)) {
    if (mine) dropFile(ps, path, e, id, note);
    else prune(ps, path, f);
    return handled;
  }
  readStatements(ps, f, path, d, mine, e, id, note);
  const unread = (!diff || truncated) && (typeof p.deletions !== "number" || p.deletions > 0);
  readLines(ps, f, path, lang, t.prot, d, unread, mine, e, id, note);
  prune(ps, path, f);
  return handled;
}

/**
 * The record of a statement named `name` in another file, for a statement moved between files: in
 * the first file in `files` whose record of it is `kind`. The caller's file holds no record of it.
 */
function elsewhere(ps: ProofState, name: string, kind: "+" | "-"): [string, ProofFile, [string | null, string | null]] | undefined {
  const ix = indexOf(ps);
  const heap = ix.loose.get(kind + name);
  const g = heap && firstOf(ps, ix, heap, (h) => looseKind(h.stmts?.get(name)) === kind);
  if (heap && !heap.length) ix.loose.delete(kind + name);
  const p = g && ix.place.get(g);
  return g && p ? [p[1], g, g.stmts?.get(name) as [string | null, string | null]] : undefined;
}

/**
 * Follow the statements a change touched, each against its text when the session started. A
 * change by someone else only puts a statement back. A statement added in a file the agent made,
 * or one that only gains `ensures` clauses, is not a weakening. The shape is `weaken` only for a
 * Dafny or Verus statement that lost `ensures` or gained `requires` clauses and nothing else; a
 * statement taken out is `delete`; any other change is `unknown`, as a text change can go either way.
 */
function readStatements(ps: ProofState, f: ProofFile, path: string, d: ProofDiff, mine: boolean, e: AgentEvent, id: string | undefined, note: Note): void {
  const key = (s: Stmt) => textKey(s.text);
  const set = (g: ProofFile, at: string, name: string, r: [string | null, string | null], shape: ProofShape) => {
    const was = looseKind(g.stmts?.get(name));
    if (r[0] === null && r[1] === null) g.stmts?.delete(name);
    else (g.stmts ??= new Map()).set(name, r);
    if (g.stmts && !g.stmts.size) delete g.stmts;
    const now = looseKind(g.stmts?.get(name));
    const ix = INDEXES.get(ps);
    if (ix && now && now !== was) queue(ix, now + name, g);
    touch(ps, g, at, name, shape, e, id, note);
  };
  if (!mine) {
    for (const s of [...d.changed.map(([, a]) => a), ...d.added]) {
      const r = f.stmts?.get(s.name);
      if (r && r[0] === key(s) && r[1] !== r[0]) set(f, path, s.name, [r[0], r[0]], "unknown");
    }
    return;
  }
  for (const [b, a] of d.changed) {
    const r = f.stmts?.get(a.name);
    // Weaker than the start, so only when this change starts from the start's text.
    const shape: ProofShape = (!r || r[0] === key(b)) && weakens(b, a) ? "weaken" : "unknown";
    if (r) set(f, path, a.name, [r[0], key(a)], shape);
    else if (!f.added && !strengthens(b, a)) set(f, path, a.name, [key(b), key(a)], shape);
  }
  for (const b of d.removed) {
    const r = f.stmts?.get(b.name);
    const there = r ? undefined : elsewhere(ps, b.name, "+");
    if (r) set(f, path, b.name, [r[0], null], "delete");
    else if (there) set(there[1], there[0], b.name, [key(b), there[2][1]], "unknown");
    else if (!f.added) set(f, path, b.name, [key(b), null], "delete");
  }
  for (const a of d.added) {
    const r = f.stmts?.get(a.name);
    const there = r ? undefined : elsewhere(ps, a.name, "-");
    if (r) set(f, path, a.name, [r[0], key(a)], "unknown");
    else if (there) {
      set(there[1], there[0], a.name, [null, null], "unknown");
      set(f, path, a.name, [there[2][0], key(a)], "unknown");
    } else if ((f.stmts?.size ?? 0) < STMT_CAP) set(f, path, a.name, [null, key(a)], "unknown");
  }
}

/**
 * Follow the lines of a pinned, spec-named or build file the agent did not make: each line's count
 * put in minus taken out, and when the agent last moved it away from zero. When the agent takes out
 * a line it put in, the lines taken out in the run that put it in, while still out, are changed
 * again now: a line changed before a failure and again after it counts as changed after it. A
 * change by someone else only moves a count back toward zero; one the agent made that cannot be
 * read leaves UNREAD. The shape is `weaken` only while a TLC line that narrows the model stays
 * added; any other line change is `unknown`.
 */
function readLines(ps: ProofState, f: ProofFile, path: string, lang: ProofLang | undefined, prot: boolean, d: ProofDiff, unread: boolean, mine: boolean, e: AgentEvent, id: string | undefined, note: Note): void {
  const tracked = !f.added && (lang === undefined || lang === "tlc" || prot || SPEC_NAMED.test(path));
  if (!tracked || (!mine && !f.lines?.size)) return;
  const lines = (f.lines ??= new Map());
  const stamps = (f.lineAt ??= new Map());
  const runs = (f.lineRun ??= new Map());
  const at = stampOf(ps, runOf(ps, id));
  // The runs of the agent's own lines it takes out.
  const back = new Set<string>();
  let moved = false;
  const bump = (k: string, by: number, run: number) => {
    const was = lines.get(k) ?? 0;
    const now = was + by;
    if (Math.abs(now) > Math.abs(was)) {
      if (!mine) return;
      stamps.set(k, at);
      runs.set(k, `${e.id} ${run}`);
    } else if (mine && was > 0 && runs.has(k)) back.add(runs.get(k) as string);
    if (now) lines.set(k, now);
    else {
      lines.delete(k);
      stamps.delete(k);
      runs.delete(k);
    }
    moved = true;
  };
  if (unread) {
    if (mine && !lines.has(UNREAD)) {
      lines.set(UNREAD, 1);
      stamps.set(UNREAD, at);
      moved = true;
    }
  } else {
    for (const [k, run] of d.taken) bump(k, -1, run);
    for (const [k, run] of d.fresh) bump(k, 1, run);
    if (back.size) for (const [k, n] of lines) if (n < 0 && back.has(runs.get(k) as string)) stamps.set(k, at);
  }
  if (lines.size > LINE_CAP) {
    lines.clear();
    stamps.clear();
    runs.clear();
    lines.set(UNREAD, 1);
    stamps.set(UNREAD, at);
  }
  if (!lines.size) delete f.lines;
  if (!stamps.size) delete f.lineAt;
  if (!runs.size) delete f.lineRun;
  if (!moved || (!mine && proofTampered(f, "#lines"))) return;
  let shape: ProofShape = "unknown";
  if (!f.lines?.has(UNREAD)) for (const [k, n] of f.lines ?? []) if (k.startsWith(NARROW) && n > 0) shape = "weaken";
  touch(ps, f, path, "#lines", shape, e, id, note);
}

/** A proof finding, which core/intent.ts adds to a trace's test-tamper findings. */
export interface ProofFinding {
  e: AgentEvent;
  /** The file; empty for a bypass flag on the checker command. */
  path: string;
  kind: "statement" | "spec" | "escape";
  shape: ProofShape;
  hatch?: string;
  theorem?: string;
  high: boolean;
  flippedGreen: boolean;
  /** The failing and the passing check's tool.end. */
  before?: string;
  after?: string;
}

type Entry = { e: AgentEvent; shape: ProofShape; flip?: { before: string; after: string } };

/** A value by path and key; `at` holds the path, so a move renames many slots at once. */
type Slot<T> = { key: string; v: T; at: PathKeys<T>; next?: Slot<T>; dead?: true };
/** One path's slots by key, and the runs that hold them in order. */
type PathKeys<T> = { path: string; keys: Map<string, Slot<T>>; runs: Run<T>[] };
/** Slots linked in order, from `head` to `tail`. */
type Run<T> = { head: Slot<T>; tail: Slot<T> };

/**
 * Values by path and key, in the order of a Map keyed by both where a move deletes each key of
 * the path and sets it again under the new path: the moved keys go to the end, and one the new
 * path already has keeps its place and takes the moved value. A move links the moved keys onto
 * the end at once and walks the smaller of the two paths, so a long session of moves stays linear.
 */
function pathMap<T>() {
  const paths = new Map<string, PathKeys<T>>();
  const order = new Set<Run<T>>();
  const slot = (path: string, key: string) => paths.get(path)?.keys.get(key);
  const set = (path: string, key: string, v: T) => {
    let p = paths.get(path);
    if (!p) paths.set(path, (p = { path, keys: new Map(), runs: [] }));
    const had = p.keys.get(key);
    if (had) {
      had.v = v;
      return;
    }
    const s: Slot<T> = { key, v, at: p };
    const run = { head: s, tail: s };
    p.keys.set(key, s);
    p.runs.push(run);
    order.add(run);
  };
  const del = (path: string, key: string) => {
    const s = slot(path, key);
    if (!s) return;
    s.dead = true;
    s.at.keys.delete(key);
  };
  const move = (from: string, to: string) => {
    const f = paths.get(from);
    if (!f?.keys.size) return;
    const run = f.runs[0] as Run<T>;
    order.delete(run);
    for (const r of f.runs.slice(1)) {
      run.tail.next = r.head;
      run.tail = r.tail;
      order.delete(r);
    }
    order.add(run);
    f.runs = [run];
    if (from === to) return;
    paths.delete(from);
    const t = paths.get(to);
    if (!t) {
      f.path = to;
      paths.set(to, f);
      return;
    }
    const [big, small] = f.keys.size > t.keys.size ? [f, t] : [t, f];
    for (const [k, s] of small.keys) {
      const b = big.keys.get(k);
      if (!b) {
        s.at = big;
        big.keys.set(k, s);
        continue;
      }
      const [there, moved] = small === t ? [s, b] : [b, s];
      there.v = moved.v;
      moved.dead = true;
      there.at = big;
      big.keys.set(k, there);
    }
    t.runs.push(run);
    big.runs = t.runs;
    big.path = to;
    paths.set(to, big);
  };
  function* entries(): Generator<[string, string, T]> {
    for (const r of order)
      for (let s: Slot<T> | undefined = r.head; s; s = s === r.tail ? undefined : s.next) if (!s.dead) yield [s.at.path, s.key, s.v];
  }
  return { get: (path: string, key: string) => slot(path, key)?.v, has: (path: string, key: string) => !!slot(path, key), set, del, move, entries };
}

/**
 * The notes of one trace, turned into findings once it is read: escape hatches still in place, a
 * bypass that stands, and the changes to statements, specs and build files, each high when it
 * turned a failing check green and still stands.
 */
export function proofLog(): { note: (n: ProofNote) => void; findings: (ps: ProofState | undefined) => ProofFinding[] } {
  /** Hatches put in, by path and name: the event that put each in. */
  const open = pathMap<AgentEvent>();
  const changes = pathMap<Entry[]>();
  let bypass: { e: AgentEvent; flag: string; before: string } | undefined;
  const note = (n: ProofNote) => {
    if (n.kind === "hatch") {
      if (!n.open) open.del(n.path, n.hatch);
      else if (!open.has(n.path, n.hatch)) open.set(n.path, n.hatch, n.e);
    } else if (n.kind === "move") {
      open.move(n.from, n.to);
      changes.move(n.from, n.to);
    } else if (n.kind === "bypass") bypass = { e: n.e, flag: n.flag, before: n.before };
    else if (n.kind === "change") {
      const list = changes.get(n.path, n.key) ?? [];
      // Changes between two flips are one change: the last one says what it became.
      if (list.length && !list.at(-1)?.flip) list.pop();
      const entry: Entry = { e: n.e, shape: n.shape };
      if (n.flip) entry.flip = n.flip;
      list.push(entry);
      changes.set(n.path, n.key, list);
    } else
      for (const [path, key] of n.flips) {
        const last = changes.get(path, key)?.at(-1);
        if (last && !last.flip) last.flip = { before: n.before, after: n.e.id };
      }
  };
  const findings = (ps: ProofState | undefined): ProofFinding[] => {
    const out: ProofFinding[] = [];
    for (const [path, hatch, e] of open.entries())
      if ((ps?.files?.get(path)?.sites?.get(hatch) ?? 0) > 0) out.push({ e, path, kind: "escape", shape: "escape", hatch, high: true, flippedGreen: false });
    if (ps?.bypass && bypass)
      out.push({ e: bypass.e, path: "", kind: "escape", shape: "escape", hatch: bypass.flag, high: true, flippedGreen: true, before: bypass.before, after: bypass.e.id });
    for (const [path, key, list] of changes.entries()) {
      const f = ps?.files?.get(path);
      const now = !!f && proofTampered(f, key);
      const lastFlip = list.findLastIndex((x) => !!x.flip);
      list.forEach((x, i) => {
        if (!x.flip && !now) return;
        const found: ProofFinding = { e: x.e, path, kind: key === "#lines" ? "spec" : "statement", shape: x.shape, high: i === lastFlip && !!f?.flipped?.has(key), flippedGreen: !!x.flip };
        if (!key.startsWith("#") && key !== "") found.theorem = key;
        if (x.flip) {
          found.before = x.flip.before;
          found.after = x.flip.after;
        }
        out.push(found);
      });
    }
    return out;
  };
  return { note, findings };
}
