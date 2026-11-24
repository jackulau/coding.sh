// Follow-up prompts that push back on the agent's last turn.
//
// isPushback is the broad test the MCP `failures` tool and the eval candidate ranking use: any
// prompt that opens with "no", "wait", "actually" and the like counts.
//
// pushbackKind is narrower, for rates that compare models (stats --scorecard). It names one kind
// per prompt, so the kinds add up to the prompts that pushed back:
// - intent: the agent did something other than what was asked ("not what I meant", "you
//   misunderstood", "I meant the other file", "you edited the wrong file").
// - undo: take the work out ("undo that", "revert your changes", "remove that", "put it back").
// - redo: do it again ("try again", "redo it", "start over", "I don't like it").
// - broken: the work does not work ("still failing", "that didn't work", "you broke the build",
//   "same error", "you made it worse", "nothing changed").
// A prompt that matches two kinds takes the first in that order. Other corrections ("you forgot
// the docs", "why did you delete that?") name no kind. "no", "wait", "stop" or "actually" alone
// name none either: "no problem", "wait for the build" and "actually, also add a test" are not
// pushback. Nor is a phrase that names a feature ("add an undo button", "a retry loop that will
// try again"), a condition or a check ("if that doesn't work, use the fallback", "make sure the
// test still fails without the fix"), a question ("is it still failing?") or praise ("you broke
// it into smaller functions"). Nor is work the prompt places outside the agent's last turn: a
// deploy, release or migration, a commit or version by name, the person's own change ("roll back
// the prod deploy to v1.2", "revert commit abc123", "undo my last commit"), a failure from before
// the agent's change or in someone else's code ("the upstream API still fails on 429s"), or a
// feature not built yet ("it doesn't work offline yet"). Such work still counts when the prompt
// says the agent made it ("roll back the migration you added").
import type { PushbackKind } from "../schema/index.ts";

export type { PushbackKind };

const PUSHBACK_START = /^(?:no\b|nope\b|stop\b|wait\b|don'?t\b|do not\b|undo\b|revert\b|wrong\b|why did you\b|that'?s (?:not|wrong)\b|this is (?:not|wrong)\b|not what\b|you (?:broke|didn'?t|forgot|missed)\b|still (?:fail|broken|not)\w*\b|it (?:still )?(?:doesn'?t|didn'?t) work\b|actually\b)/i;
const PUSHBACK_ANY = /\b(?:that'?s wrong|you broke|not what i (?:asked|wanted)|didn'?t work|still (?:failing|fails|broken)|try again|please revert|undo (?:that|this|it)|that is wrong)\b/i;

/** True when a follow-up prompt reads as the user correcting the agent. */
export function isPushback(text: string): boolean {
  const t = text.trim().slice(0, 400);
  return PUSHBACK_START.test(t) || PUSHBACK_ANY.test(t);
}

/** Every kind, in the order a prompt that matches two takes the first. */
export const PUSHBACK_KINDS = ["intent", "undo", "redo", "broken"] as const satisfies readonly PushbackKind[];

/** Words a prompt can open with before the part that names the kind: "no, undo that", "ok, try again". */
const LEAD = String.raw`^(?:(?:no|nope|nah|ok|okay|hmm+|ugh+|um+|uh+|please|pls|wait|sorry|actually|well|so|hey|stop)\b[\s,.!:;-]*)*`;
/** At least one word that reacts to the last turn: "no, start over on the parser". */
const REACT = String.raw`^(?:(?:no|nope|nah|hmm+|ugh+|wait|stop|actually)\b[\s,.!:;-]*)+`;
/** Not when the clause so far makes it a condition or a check: "if that doesn't work", "make sure it still fails". */
const GUARD = String.raw`(?<!\b(?:if|when|unless|whether|until|in case|check|checks|verify|verifies|ensure|ensures|confirm|make sure|be sure)\b[^.!?,;\n]{0,40})`;
/** Not in a sentence that sets a condition: "if the request fails, try again". */
const COND = String.raw`(?<!\b(?:if|when|unless|whether|until|in case)\b[^.!?\n]{0,80})`;
/** Not a question that opens with its verb: "is it still failing?". */
const ASKED = String.raw`(?<!(?:^|[.!?]\s*)(?:is|are|was|were|does|do|did)\s+(?:it|that|this|they|the\s+\w+)\s+)`;
/** Not the name of a feature: "an undo button", "a revert command". */
const FEATURE = String.raw`(?!\s+(?:button|command|feature|function|option|support|stack|history|log|logic|script|tool|key|shortcut|endpoint|api|operation|action|mechanism|handler)s?\b)`;
/** Not what a feature does: "a button to go back to the previous step". */
const FEATURE_BEFORE = String.raw`(?<!\b(?:button|link|command|feature|function|option|tool|key|shortcut|menu|control|action|mode|endpoint|handler|setting|way|ability)s?\b[^.!?,;\n]{0,30})`;
/** The clause names the agent's work: "the migration you added", "your commit". */
const OWNED = String.raw`(?=[^.!?;\n]{0,80}?\b(?:your|you(?:'ve| have)? (?:just |already )?(?:added|made|wrote|did|changed|created|pushed|committed|ran|applied|introduced|deployed|merged|shipped|put|moved|removed|deleted|renamed))\b)`;
/**
 * The clause, up to a comma, places the work nowhere else: not prod, a deploy, release or
 * migration, a pull request, a commit or version by name, or the person's own change.
 */
const NOT_ELSEWHERE = String.raw`(?![^.!?;,\n]{0,80}?(?:\b(?:prod|production|staging|deploys?|deployments?|releases?|migrations?|pull requests?|i (?:made|wrote|added|pushed|committed|deployed|did)|my (?:own |last |latest |previous |recent )?(?:changes?|commits?|edits?|work|fix|patch|pr|branch))\b|\bv\d+(?:\.\d+)+\b|\bcommit (?=[0-9a-f]*\d)[0-9a-f]{4,40}\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|#\d+\b))`;
/** A named object is the agent's work: the clause says so, or places it nowhere else. */
const AGENTS = `(?:${OWNED}|${NOT_ELSEWHERE})`;
/** Not a failure the prompt says came first: "still failing on main from before your change", "pre-existing". */
const BEFORE_YOU = String.raw`(?![^.!?;\n]{0,60}?\b(?:(?:from|since) before|before (?:your|you)\b[^.!?;\n]{0,30}?\b(?:too|as well)|pre-?existing|unrelated to (?:your|you|the|this))\b)`;
/** Not someone else's code: "the upstream API still fails". */
const OUTSIDE = String.raw`(?<!\b(?:upstream|third[- ]party|vendor|external|remote|their|legacy)\b[^.!?,;\n]{0,40})`;
/** Not a feature not built yet: "it doesn't work offline yet". */
const NOT_YET = String.raw`(?!(?:\s+[\w-]+){1,2}\s+yet\b)`;
/** Not splitting code up: "you broke it into smaller functions", "you broke down the parser". */
const SPLIT = String.raw`(?!\s+(?:(?:it|this|that|them|things|everything|the\s+\w+(?:\s+\w+)?)\s+)?(?:down|into|up|apart|out)\b)`;
/** Not "same error" inside another name, or the same as something named: "the same error handling", "the same error as v1" ("as before" still counts). */
const SAME_AS = String.raw`(?!\s+(?:handling|handler|handlers|class|classes|format|formatting|shape|logic|reporting|path|paths|wrapper|helper|helpers|pattern|style|semantics|contract|object|boundary|boundaries)\b)(?!(?:\s+\w+)?\s+as\s+(?!(?:before|earlier|previously|then|yesterday|last time|the last|the previous|the first)\b))`;

const any = (parts: string[]): RegExp => new RegExp(parts.join("|"), "i");

const KIND_PATTERNS: [PushbackKind, RegExp][] = [
  ["intent", any([
    String.raw`\bnot what (?:i|we)(?:'m| am|'re| are| was| were)? (?:meant|mean|asked|asking|wanted|want|said|requested|intended|had in mind|discussed|agreed|described|expected|expecting|looking for|needed(?! to\b)|need(?! to\b))\b`,
    String.raw`\byou (?:misunderstood|misread|misinterpreted|misheard|got (?:it|me|that) wrong)\b`,
    String.raw`\bi (?:didn'?t|did not|never) (?:ask(?:ed)? (?:for|you)|want(?:ed)? (?:you|that|this|it|a|an|the|those|these)|(?:say|said) (?:that|this|to|you|it)|mean(?:t)? (?:that|this|it|the))\b`,
    LEAD + String.raw`i (?:meant|said)\b(?! to (?:mention|say|ask|add)\b)`,
    LEAD + String.raw`(?:that'?s|that is|this is) not it\b`,
    LEAD + String.raw`wrong (?:file|one|function|method|class|component|page|place|branch|repo|folder|directory|thing|direction)\b`,
    String.raw`\byou (?:\w+ )?(?:edited|changed|modified|touched|updated|fixed|used|picked|deleted|removed|opened|read) the wrong\b`,
    String.raw`\b(?:that'?s|that is|this is) the wrong (?:file|one|function|method|class|component|page|place|branch|repo|folder|directory|thing)\b`,
  ])],
  ["undo", any([
    LEAD + String.raw`(?:undo|revert|roll ?back|back out)\b` + FEATURE + AGENTS,
    GUARD + String.raw`\b(?:undo|revert|roll ?back|back out|reverse)\s+(?:it|them|everything|your|all (?:of )?(?:it|them|your))\b`,
    GUARD + String.raw`\b(?:undo|revert|roll ?back|back out|reverse)\s+(?:that|this|those|these|all (?:of )?(?:that|this|those|these|the)|the (?:last|previous|latest|recent)|the (?:changes?|edits?|commits?))\b` + AGENTS,
    GUARD + FEATURE_BEFORE + String.raw`\b(?:revert|roll ?back|go back) to (?:the )?(?:previous|original|old|last|earlier|prior)\b` + AGENTS,
    String.raw`\bput (?:it|that|this|them|those|these|everything|the \w+(?: \w+)?) back\b`,
    String.raw`\b(?:change|set|switch|turn|move) (?:it|that|this|them) back\b`,
    String.raw`\bremove (?:that|those)\b(?=\s*(?:[.!?,;:]|$|again\b|please\b|too\b|now\b|entirely\b|completely\b))`,
    String.raw`\bremove (?:it|this|them|these) again\b`,
    String.raw`\bremove (?:what|everything|all) you (?:added|wrote|did|changed|made|put)\b`,
    String.raw`\bremove (?:all )?(?:of )?your (?:changes?|edits?|additions?|code)\b`,
    String.raw`\brestore (?:it|that|this|the (?:original|old|previous))\b`,
    String.raw`\bback to (?:how|what|the way) it was\b`,
  ])],
  ["redo", any([
    LEAD + String.raw`(?:try (?:it |that |this )?again|redo\b${FEATURE}|start (?:over|again|from scratch)\b${FEATURE}(?!\s+(?:on|for)\b)|do (?:it|that|this) over)`,
    REACT + String.raw`start (?:over|again|from scratch)\b`,
    COND + String.raw`\b(?:please|pls|can you|could you|let'?s|just) try (?:it |that |this )?again\b`,
    COND + String.raw`\btry (?:it |that |this )?again[\s.!]*$`,
    String.raw`\bredo (?:it|that|this|them|those|everything|the (?:whole|entire)\b|the (?:changes?|edits?|work|implementation|fix|refactor|design|layout|thing|code|tests?|function|file|page|ui)\b)`,
    COND + String.raw`\bstart (?:over|from scratch)\b` + FEATURE + String.raw`(?!\s+(?:on|for)\b)`,
    String.raw`\bgive it another (?:try|shot|go|attempt)\b`,
    String.raw`\bi (?:don'?t|do not) like (?:it|them|(?:that|this|those|these)(?=\s*(?:[.!?,;:)]|$|(?:at all|either|one|ones|much|very much|so much|anymore|any more)\b))|(?:the|this|that|these|those|your) (?:result|results|change|changes|approach|way|design|look|output|names?|naming|style|implementation|fix|solution|code|answer|ui|layout|wording|version))\b(?!\s+(?:when|if|how|because)\b)`,
    String.raw`\bnot (?:happy|satisfied) with (?:it|that|this|the (?:result|results|change|changes|approach|output|fix|solution))\b`,
  ])],
  ["broken", any([
    GUARD + ASKED + OUTSIDE + String.raw`\bstill (?:broken|failing|fails|failed|crashing|crashes|crashed|erroring|errors out|throwing|throws|hangs|hanging|red|wrong|not (?:working|work|fixed|passing|compiling|building|right)|(?:doesn'?t|does not|won'?t|will not) (?:work|pass|compile|build|start|run))\b` + BEFORE_YOU,
    // Not the person's own "I didn't fix it".
    GUARD + String.raw`(?<!\bi (?:\w+ )?)\b(?:didn'?t|did not) (?:work(?! on\b)|fix|help|solve|change anything|do anything)\b`,
    GUARD + String.raw`\b(?:it|that|this|they) (?:still )?(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not) (?:work|working|fixed|compile|compiling)\b` + NOT_YET,
    GUARD + String.raw`\b(?:it'?s|it is|that'?s|that is|this is) (?:still )?not (?:working|fixed|compiling)\b` + NOT_YET,
    LEAD + String.raw`(?:still )?(?:doesn'?t|does not|not|isn'?t|is not) (?:work|working)\b(?=\s*(?:[.!?,;:]|$|(?:for me|either|now|at all)\b))`,
    GUARD + String.raw`\byou(?:'ve| have| just)? (?:broke|broken)\b` + SPLIT,
    GUARD + String.raw`\b(?:that|this|it|your (?:change|edit|fix|commit|code|patch|update)s?) (?:broke|has broken|have broken)\b` + SPLIT,
    GUARD + String.raw`\b(?:you(?:'ve| have)?|that|this|it|your (?:change|edit|fix|commit|code|patch|update)s?) (?:just )?(?:made|has made|have made) (?:it|things|this|that|everything|the \w+) worse\b`,
    GUARD + String.raw`\bnothing (?:has |have )?changed\b(?=\s*(?:[.!?,;:]|$))`,
    GUARD + String.raw`\b(?:get|getting|got|see|seeing|saw|have|having|has|had|hit|hitting|throws|throwing|threw|shows|showing|showed|gives|giving|gave|returns|returning|returned)\s+(?:the\s+)?same (?:error|errors|failure|failures|exception|crash|problem|issue)\b` + SAME_AS,
    LEAD + String.raw`(?:the )?same (?:error|errors|failure|failures|exception|crash)\b` + SAME_AS,
    GUARD + String.raw`\bsame (?:error|errors|failure|exception|crash) (?:as before|again)\b`,
    GUARD + ASKED + OUTSIDE + String.raw`\bstill (?:get|getting|see|seeing|have|having)(?: (?:the|an|this|that|a))? (?:error|errors|failure|failures|exception|crash)\b` + BEFORE_YOU,
    GUARD + String.raw`\b(?:fails|failing|failed|broken|crashing|crashes|crashed) again\b`,
  ])],
];

/**
 * The kind of pushback a follow-up prompt is, or undefined when it is none of them. Reads the
 * first 400 characters, as isPushback does.
 */
export function pushbackKind(text: string): PushbackKind | undefined {
  const t = text.trim().slice(0, 400).replace(/[‘’]/g, "'");
  if (!t) return undefined;
  for (const [kind, re] of KIND_PATTERNS) if (re.test(t)) return kind;
  return undefined;
}
