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
//   "same error").
// A prompt that matches two kinds takes the first in that order. Other corrections ("you forgot
// the docs", "why did you delete that?") name no kind. "no", "wait", "stop" or "actually" alone
// name none either: "no problem", "wait for the build" and "actually, also add a test" are not
// pushback. Nor is a phrase that names a feature ("add an undo button", "a retry loop that will
// try again"), a condition or a check ("if that doesn't work, use the fallback", "make sure the
// test still fails without the fix"), or a question ("is it still failing?").
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
/** Not when the clause so far makes it a condition or a check: "if that doesn't work", "make sure it still fails". */
const GUARD = String.raw`(?<!\b(?:if|when|unless|whether|until|in case|check|checks|verify|verifies|ensure|ensures|confirm|make sure|be sure)\b[^.!?,;\n]{0,40})`;
/** Not in a sentence that sets a condition: "if the request fails, try again". */
const COND = String.raw`(?<!\b(?:if|when|unless|whether|until|in case)\b[^.!?\n]{0,80})`;
/** Not a question that opens with its verb: "is it still failing?". */
const ASKED = String.raw`(?<!(?:^|[.!?]\s*)(?:is|are|was|were|does|do|did)\s+(?:it|that|this|they|the\s+\w+)\s+)`;
/** Not the name of a feature: "an undo button", "a revert command". */
const FEATURE = String.raw`(?!\s+(?:button|command|feature|function|option|support|stack|history|log|logic|script|tool|key|shortcut|endpoint|api|operation|action|mechanism|handler)s?\b)`;

const any = (parts: string[]): RegExp => new RegExp(parts.join("|"), "i");

const KIND_PATTERNS: [PushbackKind, RegExp][] = [
  ["intent", any([
    String.raw`\bnot what (?:i|we) (?:meant|asked|wanted|said|requested|intended|had in mind|discussed|agreed|described)\b`,
    String.raw`\byou (?:misunderstood|misread|got (?:it|me|that) wrong)\b`,
    String.raw`\bi (?:didn'?t|did not|never) (?:ask(?:ed)? (?:for|you)|want(?:ed)? (?:you|that|this|it|a|an|the|those|these)|(?:say|said) (?:that|this|to|you|it)|mean(?:t)? (?:that|this|it|the))\b`,
    LEAD + String.raw`i (?:meant|said)\b(?! to (?:mention|say|ask|add)\b)`,
    LEAD + String.raw`(?:that'?s|that is|this is) not it\b`,
    LEAD + String.raw`wrong (?:file|one|function|method|class|component|page|place|branch|repo|folder|directory|thing|direction)\b`,
    String.raw`\byou (?:\w+ )?(?:edited|changed|modified|touched|updated|fixed|used|picked|deleted|removed|opened|read) the wrong\b`,
    String.raw`\b(?:that'?s|that is|this is) the wrong (?:file|one|function|method|class|component|page|place|branch|repo|folder|directory|thing)\b`,
  ])],
  ["undo", any([
    LEAD + String.raw`(?:undo|revert|roll ?back|back out)\b` + FEATURE,
    GUARD + String.raw`\b(?:undo|revert|roll ?back|back out|reverse)\s+(?:that|this|it|those|these|them|your|everything|all (?:of )?(?:that|this|it|those|these|your|the)\b|the (?:last|previous|latest|recent)\b|the (?:changes?|edits?|commits?)\b)`,
    GUARD + String.raw`\b(?:revert|roll ?back|go back) to (?:the )?(?:previous|original|old|last|earlier|prior)\b`,
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
    LEAD + String.raw`(?:try (?:it |that |this )?again|redo\b${FEATURE}|start (?:over|again|from scratch)|do (?:it|that|this) over)`,
    COND + String.raw`\b(?:please|pls|can you|could you|let'?s|just) try (?:it |that |this )?again\b`,
    COND + String.raw`\btry (?:it |that |this )?again[\s.!]*$`,
    String.raw`\bredo (?:it|that|this|them|those|everything|the (?:whole|entire)\b|the (?:changes?|edits?|work|implementation|fix|refactor|design|layout|thing|code|tests?|function|file|page|ui)\b)`,
    String.raw`\bstart (?:over|from scratch)\b`,
    String.raw`\bgive it another (?:try|shot|go|attempt)\b`,
    String.raw`\bi (?:don'?t|do not) like (?:it|that|this|those|these|them|the (?:result|results|change|changes|approach|way|design|look|output|names?|naming|style|implementation|fix|solution|code|answer|ui|layout|wording|version))\b(?!\s+(?:when|if|how|because)\b)`,
    String.raw`\bnot (?:happy|satisfied) with (?:it|that|this|the (?:result|results|change|changes|approach|output|fix|solution))\b`,
  ])],
  ["broken", any([
    GUARD + ASKED + String.raw`\bstill (?:broken|failing|fails|failed|crashing|crashes|crashed|erroring|errors out|throwing|throws|hangs|hanging|red|wrong|not (?:working|work|fixed|passing|compiling|building|right)|(?:doesn'?t|does not|won'?t|will not) (?:work|pass|compile|build|start|run))\b`,
    GUARD + String.raw`\b(?:didn'?t|did not) (?:work(?! on\b)|fix|help|solve|change anything|do anything)\b`,
    GUARD + String.raw`\b(?:it|that|this|they) (?:still )?(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not) (?:work|working|fixed|compile|compiling)\b`,
    GUARD + String.raw`\b(?:it'?s|it is|that'?s|that is|this is) (?:still )?not (?:working|fixed|compiling)\b`,
    GUARD + String.raw`\byou(?:'ve| have| just)? (?:broke|broken)\b`,
    GUARD + String.raw`\b(?:that|this|it|your (?:change|edit|fix|commit|code|patch|update)s?) (?:broke|has broken|have broken)\b`,
    GUARD + String.raw`\b(?:get|getting|got|see|seeing|saw|have|having|has|had|hit|hitting|throws?|throwing|shows?|showing|gives?|giving|returns?|returning)\s+(?:the\s+)?same (?:error|errors|failure|failures|exception|crash|problem|issue)\b`,
    LEAD + String.raw`(?:the )?same (?:error|errors|failure|failures|exception|crash)\b`,
    GUARD + String.raw`\bsame (?:error|errors|failure|exception|crash) (?:as before|again)\b`,
    GUARD + ASKED + String.raw`\bstill (?:get|getting|see|seeing|have|having)(?: (?:the|an|this|that|a))? (?:error|errors|failure|failures|exception|crash)\b`,
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
