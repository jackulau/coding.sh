// What an agent's closing words say about a failing check. The premature-completion
// flag (core/sessions.ts) asks this of the agent's last text before it ends a turn
// while the latest test run fails: an agent that says plainly that tests still
// fail, or asks how to go on, reported the failure; one that says it is done,
// fixed or passing, or says nothing about the failure, ended early.
// A few regexes over one short text per turn end: cheap enough for every session build.

/** A failure that is gone: "fixed the failing test", "no longer fails", "the test that was failing". Removed before looking for a report. */
const FAILURE_GONE = new RegExp(
  [
    String.raw`(?:\b(?:no longer|not|never|stopped)|n't)\s+(?:\w+\s+)?(?:fail\w*|broken)`,
    String.raw`\b(?:fix\w*|resolv\w*|address\w*|repair\w*|was|were|had been|used to)\s+(?:(?:the|a|an|all|both|every|each|that|those|these|its|their|remaining|last|previously|\d+|one|two|three)\s+)*(?:fail\w*|broken)`,
  ].join("|"),
  "gi",
);

/** Says the failure stands, wherever it appears: "still fails", "couldn't get test_x to pass", "not done yet", "isn't passing". */
const FAILURE_STANDS = new RegExp(
  [
    String.raw`\bstill\b[^.!?\n]{0,40}?\b(?:fail\w*|broken|red|erroring)\b`,
    String.raw`\b(?:could(?:n't| not)|can(?:'t|not)|was(?:n't| not) able to|were(?:n't| not) able to|unable to|failed to|did(?:n't| not) manage to)\s+(?:\w+\s+)?(?:get|make|fix|resolve|pass|solve)\b`,
    String.raw`\bnot\s+(?:yet\s+)?(?:done|finished|complete|fixed|passing|resolved|green)\b`,
    String.raw`\b(?:is|are|does|do)(?:n't| not)\s+(?:yet\s+)?pass\w*`,
    String.raw`\bpass\w*\s+except\b`,
  ].join("|"),
  "i",
);

/** Says a check fails now, in a sentence that names the check: "One test fails: test_div", "the build is broken". */
const FAILS_NOW = /\b(?:fails|fail(?:ing)?:|(?:is|are) (?:still )?(?:failing|broken|red)|remains? (?:red|broken|failing)|(?:is|are|does|do)(?:n't| not) (?:yet )?work\w*)|\b(?:\d+|one|two|three|four|five|several|some|a few)\s+(?:\w+\s+)?(?:tests?|specs?|checks?|cases?)\s+fail(?:ed)?\b/i;

/** A failure word (after FAILURE_GONE) and a word that names a test or check. */
const FAILURE_WORD = /\b(?:fail\w*|broken)\b|\b(?:is|are|still|stays?|remains?)\s+red\b|\b(?:[1-9]\d*|one|two|three|several|some)\s+(?:\w+\s+)?errors?\b/i;
const CHECK_WORD = /test|spec|check|build|lint|tsc|compil|suite|assert|\bci\b/i;
/** A runner's tally, "1 failed, 5 passed": names the check by itself. */
const TALLY_FAILED = /\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failing|failures?)\b/i;
const TALLY_PASSED = /\b\d+\s+(?:tests?\s+)?passed\b/gi;

/** Says the work is finished or green. */
const SUCCESS_CLAIM = /\b(?:done|fixed|complete[ds]?|finished|resolved|succeed\w*|successful\w*|works|green|all set)\b|\bpass(?:es|ed|ing)?\b|✅/i;

const sentences = (text: string): string[] => text.split(/(?<=[.!?:;])\s+|\n+/);

/**
 * The text says plainly that a test or check still fails: the failure stands
 * ("still fails", "couldn't get it to pass", "not done yet"), a named check
 * fails now ("One test fails: test_div"), it asks how to go on about a
 * failure, or it names a failing check and does not also say the work is done.
 */
export function reportsFailure(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.replace(FAILURE_GONE, " ");
  if (FAILURE_STANDS.test(t)) return true;
  let named = false;
  for (const s of sentences(t)) {
    if (!FAILURE_WORD.test(s)) continue;
    if (s.trimEnd().endsWith("?")) return true;
    if (!CHECK_WORD.test(s) && !TALLY_FAILED.test(s)) continue;
    if (FAILS_NOW.test(s)) return true;
    named = true;
  }
  return named && !SUCCESS_CLAIM.test(t.replace(TALLY_PASSED, " "));
}

/** The text says the work is done, fixed or passing. */
export function claimsSuccess(text: string | undefined): boolean {
  return !!text && SUCCESS_CLAIM.test(text.replace(FAILURE_STANDS, " "));
}
