import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkOutcome,
  compareStatements,
  isProofConfig,
  outText,
  proofCheck,
  proofLang,
  readProofDiff,
  scanProof,
  statements,
  strengthens,
  syntaxOf,
  textKey,
  weakens,
  type ProofLang,
} from "../../src/core/proof.ts";

/** A one-hunk diff of `path`; each line starts with " ", "-" or "+". */
const diff = (path: string, ...lines: string[]) => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;
const hatches = (path: string, lang: ProofLang | undefined, ...lines: string[]) => Object.fromEntries(readProofDiff(path, lang, diff(path, ...lines)).hatches);
const stmts = (lang: ProofLang, text: string) => {
  const { code, bare } = scanProof(text, syntaxOf(`x.${lang}`, lang));
  return statements(lang, code, bare);
};

describe("proofLang", () => {
  it("knows proof files by extension, and Rust, .cfg and .v files by their text", () => {
    assert.equal(proofLang("src/Foo.lean"), "lean");
    assert.equal(proofLang("theories/Add.v"), "rocq");
    assert.equal(proofLang("rtl/alu.v", "module alu(input a, output b);\nendmodule"), undefined);
    assert.equal(proofLang("src/Main.dfy"), "dafny");
    assert.equal(proofLang("Thy/Base.thy"), "isabelle");
    assert.equal(proofLang("spec/Raft.tla"), "tla");
    assert.equal(proofLang("spec/Raft.cfg", "SPECIFICATION Spec\nINVARIANT TypeOK"), "tlc");
    assert.equal(proofLang("setup.cfg", "[metadata]\nname = x"), undefined);
    assert.equal(proofLang("src/lib.rs", "verus! {\nproof fn lemma_x() {}\n}"), "verus");
    assert.equal(proofLang("src/lib.rs", "// verus! {\nfn main() {}"), undefined);
    assert.equal(proofLang("src/lib.rs", "", "verus"), "verus");
    assert.equal(proofLang("src/app.ts", "axiom sorry Admitted"), undefined);
  });

  it("reads the text of a diff with no context lines", () => {
    assert.equal(proofLang("MC.cfg", diff("MC.cfg", "-INVARIANT TypeOK Safe", "+INVARIANT TypeOK")), "tlc");
    assert.equal(proofLang("rtl/top.v", diff("rtl/top.v", "+module top(input clk);", "+  assume property (ok);")), undefined);
    assert.equal(proofLang("theories/Add.v", diff("theories/Add.v", "+Lemma add_0 : forall n, n + 0 = n.")), "rocq");
  });

  it("reads a .v file with a Verilog assign or declaration as Verilog", () => {
    assert.equal(proofLang("rtl/arb.v", "assign admit = req & ~busy;"), undefined);
    assert.equal(proofLang("rtl/arb.v", diff("rtl/arb.v", "+  // Definition of the grant logic", "+  assign admit = req & ~busy;")), undefined);
  });

  it("knows the build files that choose what a checker reads", () => {
    for (const p of ["_CoqProject", "theories/_RocqProject", "lakefile.lean", "lakefile.toml", "ROOT", "dfyconfig.toml"]) assert.ok(isProofConfig(p), p);
    for (const p of ["package.json", "Makefile", "ROOT.md", "mylakefile.lean"]) assert.ok(!isProofConfig(p), p);
  });
});

describe("scanProof", () => {
  it("blanks comments in code, and comments and strings in bare, keeping the length and the lines", () => {
    const text = 'a -- sorry\n/- x /- nested -/ sorry -/ b "sorry" c';
    const { code, bare } = scanProof(text, syntaxOf("A.lean", "lean"));
    assert.equal(code.length, text.length);
    assert.equal(bare.length, text.length);
    assert.equal(code.split("\n").length, 2);
    assert.deepEqual(code.match(/sorry/g), ["sorry"]);
    assert.equal(bare.match(/sorry/g), null);
    assert.match(bare, /^a {9}\n {27}b {9}c$/);
  });

  it("reads Rocq strings without backslash escapes", () => {
    assert.match(scanProof('"a\\" Admitted "', syntaxOf("A.v", "rocq")).bare, /Admitted/);
    assert.doesNotMatch(scanProof('"a\\" sorry "', syntaxOf("A.lean", "lean")).bare, /sorry/);
    assert.doesNotMatch(scanProof('(* Admitted. (* nested *) Admitted. *) "Admitted"', syntaxOf("A.v", "rocq")).bare, /Admitted/);
  });

  it("blanks Isabelle cartouches in bare only", () => {
    const { code, bare } = scanProof("text \\<open>sorry\\<close> ‹sorry› lemma x: \"True\" by simp", syntaxOf("A.thy", "isabelle"));
    assert.equal(code.match(/sorry/g)?.length, 2);
    assert.doesNotMatch(bare, /sorry/);
    assert.match(bare, /lemma x: {8}by simp/);
  });

  it("tells a char literal from a prime in a name", () => {
    assert.equal(scanProof("x' 'a' sorry", syntaxOf("A.lean", "lean")).bare, "x'     sorry");
  });

  it("blanks what comes before a close with no open: the hunk started inside a comment", () => {
    assert.equal(scanProof("sorry inside -/ sorry", syntaxOf("A.lean", "lean")).bare.trim(), "sorry");
  });
});

describe("escape hatches", () => {
  it("counts hatches put in and taken out of code, not of comments or strings", () => {
    assert.deepEqual(hatches("A.lean", "lean", "+theorem t : 1 = 1 := by sorry"), { sorry: 1 });
    assert.deepEqual(hatches("A.lean", "lean", "+-- sorry, fix later", '+#eval "sorry"', "+/- admit -/"), {});
    assert.deepEqual(hatches("A.lean", "lean", "-  sorry", "+  simp"), { sorry: -1 });
    assert.deepEqual(hatches("A.lean", "lean", "-  sorry", "+  sorry"), {});
    assert.deepEqual(hatches("A.lean", "lean", "+axiom choice' : True"), { axiom: 1 });
    assert.deepEqual(hatches("A.lean", "lean", "+set_option debug.skipKernelTC true"), { "debug.skipKernelTC": 1 });
    assert.deepEqual(hatches("A.v", "rocq", "+Admitted.", "+(* Admitted. *)", "+Axiom ax : False."), { Admitted: 1, Axiom: 1 });
    assert.deepEqual(hatches("A.v", "rocq", "+Unset Guard Checking."), { "Unset Checking": 1 });
    assert.deepEqual(hatches("A.dfy", "dafny", "+  assume false;", "+  // assume false;"), { assume: 1 });
    assert.deepEqual(hatches("A.dfy", "dafny", "+method {:verify false} M() {"), { "{:verify false}": 1 });
    assert.deepEqual(hatches("src/lib.rs", "verus", "+#[verifier::external_body]", "+    assume(x > 0);", "+// admit()"), { external_body: 1, assume: 1 });
    assert.deepEqual(hatches("A.thy", "isabelle", "+  sorry", "+text \\<open>sorry\\<close>"), { sorry: 1 });
    assert.deepEqual(hatches("Raft.tla", "tla", "+THEOREM Safety == Spec => []Inv OMITTED"), { OMITTED: 1 });
  });

  it("does not count a hatch word in a hyphenated word, a Rocq hatch that does not start a sentence, or a Verus method of that name", () => {
    assert.deepEqual(hatches("A.lean", "lean", "+All lemmas below are sorry-free."), {});
    assert.deepEqual(hatches("A.v", "rocq", "+  Nothing here is Admitted."), {});
    assert.deepEqual(hatches("A.v", "rocq", "+Local Axiom x : False."), { Axiom: 1 });
    assert.deepEqual(hatches("A.v", "rocq", "+Proof. admit. Admitted."), { admit: 1, Admitted: 1 });
    assert.deepEqual(hatches("src/lib.rs", "verus", "+if !self.admit(req) {", "+fn assume(x: bool) {}"), {});
    assert.deepEqual(hatches("dfyconfig.toml", undefined, "+no-verify = false"), {});
  });

  it("does not count an Axiom inside a Rocq Module Type", () => {
    assert.deepEqual(hatches("A.v", "rocq", "+Module Type STACK.", "+  Axiom t : Type.", "+End STACK.", "+Axiom cheat : False."), { Axiom: 1 });
  });

  it("reads build files with their strings kept", () => {
    assert.deepEqual(hatches("ROOT", undefined, "+  options [quick_and_dirty]"), { quick_and_dirty: 1 });
    assert.deepEqual(hatches("ROOT", undefined, "+  options [quick_and_dirty = false]"), {});
    assert.deepEqual(hatches("_CoqProject", undefined, "+-arg -type-in-type", "+# -arg -type-in-type"), { "-type-in-type": 1 });
    assert.deepEqual(hatches("lakefile.lean", undefined, '+  moreLeanArgs := #["-Ddebug.skipKernelTC=true"]'), { "debug.skipKernelTC": 1 });
    assert.deepEqual(hatches("lakefile.lean", undefined, '+  moreLeanArgs := #["-Ddebug.skipKernelTC=false"]'), {});
    assert.deepEqual(hatches("dfyconfig.toml", undefined, "+no-verify = true", "+# no-verify = true"), { "no-verify": 1 });
  });

  it("drops the last hunk of a clipped diff unless it only adds lines", () => {
    const two = `${diff("A.lean", "-  simp", "+  sorry")}@@ -9 +9 @@\n-  omega\n+  sorry\n`;
    assert.deepEqual(Object.fromEntries(readProofDiff("A.lean", "lean", two, true).hatches), { sorry: 1 });
    assert.deepEqual(Object.fromEntries(readProofDiff("A.lean", "lean", two).hatches), { sorry: 2 });
    const adds = `${diff("A.lean", "-  simp", "+  sorry")}@@ -9 +9 @@\n+  sorry\n`;
    assert.deepEqual(Object.fromEntries(readProofDiff("A.lean", "lean", adds, true).hatches), { sorry: 2 });
  });

  it("tells a Rocq file from its added lines", () => {
    assert.equal(readProofDiff("A.v", undefined, diff("A.v", "+Lemma x : True.", "+Proof. auto. Qed.")).rocq, true);
    assert.equal(readProofDiff("A.v", undefined, diff("A.v", "+assign y = a & b;")).rocq, false);
  });
});

describe("statements", () => {
  it("reads a Lean theorem up to its proof", () => {
    assert.deepEqual(stmts("lean", "theorem add_comm (a b : Nat) : a + b = b + a := by\n  omega"), [{ name: "add_comm", text: "theoremadd_comm(ab:Nat):a+b=b+a", spec: true }]);
    assert.deepEqual(stmts("lean", "@[simp] private lemma two : 1 + 1 = 2 := rfl\n-- theorem gone : False := sorry"), [{ name: "two", text: "@[simp]privatelemmatwo:1+1=2", spec: true }]);
    assert.deepEqual(stmts("lean", "def f (n : Nat) : Nat := n"), []);
  });

  it("reads a Rocq theorem up to its first full stop", () => {
    assert.deepEqual(stmts("rocq", "Theorem add_0 : forall n, n + 0 = n.\nProof. induction n; auto. Qed."), [{ name: "add_0", text: "Theoremadd_0:foralln,n+0=n.", spec: true }]);
  });

  it("splits Dafny and Verus specs into a signature and clauses", () => {
    const [sum] = stmts("dafny", "lemma Sum(n: nat)\n  requires n > 0\n  decreases n\n  ensures Total(n) == n * (n + 1) / 2\n{\n  assert true;\n}");
    assert.deepEqual(sum, { name: "Sum", text: "lemmaSum(n:nat)requires:n>0ensures:Total(n)==n*(n+1)/2", spec: true, sig: "lemmaSum(n:nat)", clauses: ["requires:n>0", "ensures:Total(n)==n*(n+1)/2"] });
    const [total] = stmts("dafny", "function Total(n: nat): nat { if n == 0 then 0 else n + Total(n - 1) }");
    assert.equal(total?.spec, false);
    assert.equal(total?.sig, "functionTotal(n:nat):nat");
    const [add] = stmts("verus", "pub proof fn lemma_add(a: int, b: int)\n    requires a > 0, b > 0,\n    ensures a + b > 0,\n{\n}");
    assert.deepEqual(add?.clauses, ["requires:a>0", "requires:b>0", "ensures:a+b>0"]);
    assert.equal(add?.spec, true);
  });

  it("pairs statements by name and keeps only claims and specified functions", () => {
    const before = stmts("lean", "theorem a : P := x\ntheorem b : Q := y\ntheorem c : R := z");
    const after = stmts("lean", "theorem a : P := x\ntheorem b : True := y\ntheorem d : S := w");
    const d = compareStatements(before, after);
    assert.deepEqual(d.changed.map(([x, y]) => [x.name, y.text]), [["b", "theoremb:True"]]);
    assert.deepEqual(d.removed.map((x) => x.name), ["c"]);
    assert.deepEqual(d.added.map((x) => x.name), ["d"]);
    const fns = compareStatements(stmts("dafny", "function F(): int { 1 }"), stmts("dafny", "function F(): nat { 1 }"));
    assert.deepEqual(fns, { changed: [], removed: [], added: [] });
  });

  const one = (s: string) => stmts("dafny", `lemma L(n: nat)\n${s}{\n}`)[0]!;
  it("counts an added ensures as stronger, and a dropped or changed clause as not", () => {
    const p = one("  ensures P(n)\n");
    assert.ok(strengthens(p, one("  ensures P(n)\n  ensures Q(n)\n")));
    assert.ok(!strengthens(one("  ensures P(n)\n  ensures Q(n)\n"), p));
    assert.ok(!strengthens(p, one("  requires n > 0\n  ensures P(n)\n")));
    assert.ok(!strengthens(p, stmts("dafny", "lemma L(n: int)\n  ensures P(n)\n  ensures Q(n)\n{\n}")[0]!));
    assert.ok(!strengthens(stmts("lean", "theorem L : P := x")[0]!, stmts("lean", "theorem L : Q := x")[0]!));
  });

  it("counts a dropped ensures or an added requires as weaker, and any other change as not", () => {
    const p = one("  ensures P(n)\n");
    assert.ok(weakens(one("  ensures P(n)\n  ensures Q(n)\n"), p));
    assert.ok(weakens(p, one("  requires n > 0\n  ensures P(n)\n")));
    assert.ok(!weakens(p, one("  ensures P(n)\n  ensures Q(n)\n")));
    assert.ok(!weakens(p, one("  ensures R(n)\n")));
    assert.ok(!weakens(p, p));
    assert.ok(!weakens(p, stmts("dafny", "lemma L(n: int)\n{\n}")[0]!));
    assert.ok(!weakens(stmts("lean", "theorem L : P := x")[0]!, stmts("lean", "theorem L : True := x")[0]!));
  });

  it("keys a statement's text by its length and hash", () => {
    assert.equal(textKey("theorema:P"), textKey("theorema:P"));
    assert.notEqual(textKey("theorema:P"), textKey("theorema:Q"));
    assert.match(textKey(""), /^0:[0-9a-z]+$/);
  });
});

describe("proofCheck", () => {
  it("reads the checker a command runs, through timeout and opam exec", () => {
    assert.deepEqual(proofCheck("coqc -Q theories Foo theories/B.v theories/A.v"), { lang: "rocq", path: "theories/A.v theories/B.v", exit: "both" });
    assert.deepEqual(proofCheck("timeout 600 lake build"), { lang: "lean", exit: "both" });
    assert.deepEqual(proofCheck("opam exec -- coqc A.v"), { lang: "rocq", path: "A.v", exit: "both" });
    assert.deepEqual(proofCheck("cargo verus verify"), { lang: "verus", exit: "both" });
    assert.deepEqual(proofCheck("dafny verify src/A.dfy"), { lang: "dafny", target: "verify", path: "src/A.dfy", exit: "both" });
    assert.deepEqual(proofCheck("isabelle build -d . Main"), { lang: "isabelle", exit: "both" });
    assert.deepEqual(proofCheck("java -cp tla2tools.jar tlc2.TLC MC.tla"), { lang: "tlc", path: "MC.tla", exit: "both" });
    assert.equal(proofCheck("make -j4")?.lang, "make");
    assert.equal(proofCheck("dune build @all")?.lang, "dune");
  });

  it("is undefined for commands that check nothing", () => {
    for (const c of ["echo hi", "lake --version", "coqc --help", "make clean", "lean --run Main.lean -h", "cat A.v", "git commit -m lean", "dafny format A.dfy", "lake update"]) assert.equal(proofCheck(c), undefined, c);
  });

  it("keeps quoted words whole: a commit message that names a checker runs no check", () => {
    assert.equal(proofCheck('git commit -am "WIP; lake build still fails"'), undefined);
  });

  it("keys make by its targets, dune by its aliases and Dafny by its subcommand; make help is no check and make has no bypass", () => {
    assert.equal(proofCheck("make help"), undefined);
    assert.deepEqual(proofCheck("make -j4 all"), { lang: "make", target: "all", exit: "both" });
    assert.deepEqual(proofCheck("make -j 4"), { lang: "make", exit: "both" });
    assert.equal(proofCheck('make release GIT_FLAGS="--no-verify"')?.bypass, undefined);
    assert.deepEqual(proofCheck("dune build @fmt"), { lang: "dune", target: "build @fmt", exit: "both" });
    assert.deepEqual(proofCheck("dafny run --no-verify A.dfy"), { lang: "dafny", target: "run", path: "A.dfy", bypass: "--no-verify", exit: "both" });
  });

  it("counts tail as a filter of the output", () => {
    assert.deepEqual(proofCheck("lake build 2>&1 | tail -2"), { lang: "lean", filtered: true });
  });

  it("joins files to the directory a cd moved to", () => {
    assert.equal(proofCheck("cd proofs && coqc A.v")?.path, "proofs/A.v");
    assert.equal(proofCheck("cd proofs && coqc /abs/A.v")?.path, "/abs/A.v");
  });

  it("finds bypass flags", () => {
    assert.equal(proofCheck("dafny verify --no-verify A.dfy")?.bypass, "--no-verify");
    assert.equal(proofCheck("dafny /noVerify A.dfy")?.bypass, "/noVerify");
    assert.equal(proofCheck("coqc -type-in-type A.v")?.bypass, "-type-in-type");
    assert.equal(proofCheck("isabelle build -o quick_and_dirty -d . Main")?.bypass, "-o quick_and_dirty");
    assert.equal(proofCheck("isabelle build -o quick_and_dirty=false Main")?.bypass, undefined);
    assert.equal(proofCheck("lean -Ddebug.skipKernelTC=true A.lean")?.bypass, "debug.skipKernelTC");
    assert.equal(proofCheck("tlc -deadlock MC.tla")?.bypass, "-deadlock");
    assert.equal(proofCheck("dafny verify A.dfy")?.bypass, undefined);
  });

  it("knows what the exit status covers, and when output is filtered or the run is in the background", () => {
    assert.equal(proofCheck("lake build && echo ok")?.exit, "green");
    assert.equal(proofCheck("lake build; echo done")?.exit, undefined);
    assert.equal(proofCheck("lake build || true")?.exit, undefined);
    assert.equal(proofCheck("echo start; lake build")?.exit, "both");
    assert.deepEqual(proofCheck("lake build 2>&1 | grep error"), { lang: "lean", filtered: true });
    assert.equal(proofCheck("lake build | tee build.log")?.filtered, undefined);
    assert.equal(proofCheck("lake build &")?.background, true);
    assert.equal(proofCheck("lake build", { command: "lake build", run_in_background: true })?.background, true);
    assert.equal(proofCheck("lake build", { command: "lake build" })?.background, undefined);
    assert.equal(proofCheck("coqc A.v && coqc B.v")?.path, "B.v");
  });
});

describe("checkOutcome", () => {
  const lake = proofCheck("lake build")!;
  const piped = proofCheck("lake build | tee build.log")!;
  const make = proofCheck("make")!;
  it("goes by the exit status when it covers the checker", () => {
    assert.equal(checkOutcome(lake, { ok: false, output: "" }), "red");
    assert.equal(checkOutcome(lake, { ok: true, output: "Build completed successfully." }), "green");
    assert.equal(checkOutcome(lake, { ok: true, output: "warning: A.lean:3:8: declaration uses 'sorry'" }), "green");
    assert.equal(checkOutcome(proofCheck("lake build && echo ok")!, { ok: false }), undefined);
  });

  it("reads errors in the output, whatever the exit status", () => {
    assert.equal(checkOutcome(piped, { ok: true, output: "error: A.lean:3:2: unsolved goals" }), "red");
    assert.equal(checkOutcome(piped, { ok: true, output: 'File "./A.v", line 3, characters 0-7:\nError: Unable to unify' }), "red");
    assert.equal(checkOutcome(piped, { ok: true, output: "Dafny program verifier finished with 2 verified, 1 error" }), "red");
    assert.equal(checkOutcome(piped, { ok: true, output: "*** Failed to finish proof" }), "red");
    assert.equal(checkOutcome(piped, { ok: true, output: "Error: Invariant TypeOK is violated." }), "red");
    assert.equal(checkOutcome(piped, { ok: true, output: { stdout: "", stderr: "make: *** [all] Error 1" } }), "red");
  });

  it("counts output with no error as a pass unless it is filtered, clipped or empty", () => {
    assert.equal(checkOutcome(piped, { ok: true, output: "Dafny program verifier finished with 3 verified, 0 errors" }), "green");
    assert.equal(checkOutcome(piped, { ok: true, output: "" }), undefined);
    assert.equal(checkOutcome(piped, { ok: true, output: "Building A…" }), undefined);
    assert.equal(checkOutcome(piped, { ok: true, output: "Building A", cut: { bytes: 90000 } }), undefined);
    assert.equal(checkOutcome(proofCheck("lake build | grep -v warning")!, { ok: true, output: "Build completed" }), undefined);
  });

  it("has nothing to go on for a run in the background, an interrupted run or a timeout", () => {
    assert.equal(checkOutcome(proofCheck("lake build &")!, { ok: false }), undefined);
    assert.equal(checkOutcome(lake, { ok: false, interrupted: true }), undefined);
    assert.equal(checkOutcome(lake, { ok: false, output: "Command timed out after 2m 0s" }), undefined);
    assert.equal(checkOutcome(lake, { ok: true, output: "Command running in background with ID: b1" }), undefined);
  });

  it("has nothing to go on when the checker never ran: not found, exit status 126 or 127, or turned down", () => {
    assert.equal(checkOutcome(lake, { ok: false, output: "bash: line 1: lake: command not found" }), undefined);
    assert.equal(checkOutcome(lake, { ok: false, output: "The user doesn't want to proceed with this tool use. The tool use was rejected." }), undefined);
    assert.equal(checkOutcome(lake, { ok: false, exitCode: 127 }), undefined);
    assert.equal(checkOutcome(lake, { ok: false, exitCode: 126 }), undefined);
    assert.equal(checkOutcome(lake, { ok: false, output: "Exit code 127" }), undefined);
    assert.equal(checkOutcome(lake, { ok: false, exitCode: 1 }), "red");
    for (const line of [
      "zsh: command not found: lake",
      "/bin/sh: 1: lake: not found",
      "lake : The term 'lake' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      "'lake' is not recognized as an internal or external command,",
    ])
      assert.equal(checkOutcome(lake, { ok: false, output: line }), undefined, line);
    assert.equal(checkOutcome(proofCheck("timeout 600 lake build")!, { ok: false, output: "bash: timeout: command not found" }), undefined);
    assert.equal(checkOutcome(make, { ok: false, output: "COQC theories/Add.v\n/bin/sh: 1: coqc: not found\nmake[1]: *** [CoqMakefile:801: theories/Add.vo] Error 127\nmake: *** [Makefile:5: all] Error 2" }), undefined);
    assert.equal(checkOutcome(make, { ok: false, output: "make: coqc: No such file or directory\nmake: *** [Makefile:2: all] Error 127" }), undefined);
  });

  it("reads the error lines first, and takes only a line about the checker itself to mean it never ran", () => {
    assert.equal(checkOutcome(lake, { ok: false, output: "/home/user/.bashrc: line 5: pyenv: command not found\nerror: ./Foo.lean:3:2: unsolved goals" }), "red");
    assert.equal(checkOutcome(lake, { ok: true, output: "zsh:1: command not found: rbenv\nBuild completed successfully." }), "green");
    assert.equal(checkOutcome(lake, { ok: false, output: "error: ./Foo.lean:1:0: unknown module prefix 'Mathlib'\nerror: Mathlib.olean: not found" }), "red");
    assert.equal(checkOutcome(lake, { ok: false, output: "error: ./Foo.lean:3:2: unsolved goals\nCommand timed out after 2m 0s" }), "red");
    assert.equal(checkOutcome(make, { ok: true, output: "/bin/sh: 1: ocamlfind: not found\nCOQC theories/Add.v" }), "green");
    assert.equal(checkOutcome(proofCheck("lake build; ./notify")!, { ok: false, exitCode: 127, output: "error: ./Foo.lean:3:2: unsolved goals" }), "red");
    assert.equal(checkOutcome(lake, { ok: true, output: "info: ./Foo.lean:1:0: the call was rejected by the user\nBuild completed successfully." }), "green");
    assert.equal(checkOutcome(lake, { ok: true, output: "info: ./Foo.lean:1:0: command timed out\nBuild completed successfully." }), "green");
  });

  it("reads a tool's output from a string or an object", () => {
    assert.equal(outText("x"), "x");
    assert.equal(outText({ stdout: "a", stderr: "b", exitCode: 1 }), "a\nb");
    assert.equal(outText(undefined), "");
  });
});
