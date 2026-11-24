// Follow-up prompts that push back on the agent's last turn.
//
// isPushback is the broad test the MCP `failures` tool and the eval candidate ranking use: any
// prompt that opens with "no", "wait", "actually" and the like counts.
//
// pushbackKind is narrower, for rates that compare models (stats --scorecard). It names at most
// one kind per prompt, so the kinds add up to the prompts that name one:
// - intent: the agent did something other than what was asked ("not what I meant", "that's
//   wrong", "I asked for a bar chart, not a pie chart", "you edited the wrong file").
// - undo: take the work out ("undo that", "revert your changes", "remove that", "put it back").
// - redo: do it again ("try again", "retry", "start over", "I don't like it").
// - broken: the work does not work ("still failing", "that didn't work", "the build broke",
//   "same error", "it's worse now", "nothing changed").
// A prompt that matches two kinds takes the first in that order. Other corrections ("you forgot
// the docs", "why did you delete that?", "no, use the other helper") name no kind. "no", "wait",
// "stop" or "actually" alone name none either: "no problem", "wait for the build" and "actually,
// also add a test" are not pushback.
//
// Nor is a phrase that names a feature ("add an undo button", "undo is broken in the editor"), a
// condition, a time or a check ("if that doesn't work, use the fallback", "set it back after the
// test", "roll back the transaction on error", "make sure the test still fails"), a check that
// passed ("ran the formatter, nothing changed"), a question ("is it still failing?", "did you
// remove that?") or praise ("you broke it into smaller functions").
//
// Nor is work the prompt places outside the agent's last turn: a deploy, release or migration, a
// commit, version or day by name, the person's own change or another's ("roll back the prod deploy
// to v1.2", "revert commit abc123", "undo my last commit", "revert Bob's change", "undo the changes
// the linter made"), a failure from before the agent's change, in someone else's code or put down
// to something known ("the upstream API still fails on 429s", "CI is still red because of the
// flaky test"), or a feature not built yet ("it doesn't work offline yet"). Such work still counts
// when the prompt says the agent made it ("roll back the migration you added").
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
/** An event code reacts to: "on failure", "on startup". Not a file or path: "the changes on login.ts". */
const EVENT = String.raw`on (?:failures?|errors?|exit|crash|shutdown|teardown|start-?up|start|boot|load|reload|restart|resume|launch|init|open|close|login|logout|mount|unmount)\b(?![./-]\w)`;
/** Not in a sentence that sets a condition or a time first: "on failure, restore the config", "after the test, set it back". */
const TIMED = String.raw`(?<!\b(?:if|when|whenever|unless|whether|until|in case|after|once|${EVENT})\b[^.!?\n]{0,80})`;
/** Not followed in its clause by a condition, a time or a backup: "turn it back on after the migration", "restore it from the backup" ("if you can" still counts). */
const TIMED_AFTER = String.raw`(?![^.!?,;\n]{0,60}?\b(?:if(?! (?:you can|you could|possible|needed|necessary|you want)\b)|when|whenever|unless|until|in case|after|once|${EVENT}|from (?:the |a |an )?(?:backups?|snapshots?|dumps?|archives?))\b)`;
/** Not followed in its clause by a failure the code reacts to: "roll back on error", "revert the state if the write fails". */
const ON_FAIL = String.raw`(?![^.!?,;\n]{0,60}?\b(?:${EVENT}|(?:if|when|whenever|once|after) (?:the |a |an |any |it |that |this |they )?(?:[\w-]+ )?(?:fails?|failed|errors?|errored|throws?|threw|crash(?:es|ed)?|times? out|timed out|aborts?|aborted))\b)`;
/** Not a question that opens with its verb: "is it still failing?". */
const ASKED = String.raw`(?<!(?:^|[.!?]\s*)(?:is|are|was|were|does|do|did)\s+(?:it|that|this|they|the\s+\w+)\s+)`;
/** Not a question or a request put to the agent: "why did you remove that?", "can you take it out?". */
const ASK_YOU = String.raw`(?<!\b(?:why|why'?d|did|do|does|didn'?t|don'?t|can|could|should|would|will)\s+you\s+)`;
/** Not the name of a feature: "an undo button", "a revert command". */
const FEATURE = String.raw`(?!\s+(?:button|command|feature|function|option|support|stack|history|log|logic|script|tool|key|shortcut|endpoint|api|operation|action|mechanism|handler)s?\b)`;
/** Not what a feature does: "a button to go back to the previous step". */
const FEATURE_BEFORE = String.raw`(?<!\b(?:button|link|command|feature|function|option|tool|key|shortcut|menu|control|action|mode|endpoint|handler|setting|way|ability)s?\b[^.!?,;\n]{0,30})`;
/** The end of the clause after a verb that opens the prompt: "undo.", "please revert", "redo, but faster". */
const DONE = String.raw`(?=\s*(?:[.!?,;:)]|$|please\b|pls\b|now\b|again\b))`;
/** An object after a verb that opens the prompt, so a noun use does not match: "undo the rename", not "undo is broken". */
const OBJECT = String.raw`(?=\s+(?:it|that|this|those|these|them|everything|all|your|the|whatever|what\b(?!\s*\?))\b)`;
/** Not a retry put off or made a condition: "try again later", "try again if the registry is down". */
const LATER = String.raw`(?!\s+(?:later|tomorrow|tonight|next (?:week|time)|in (?:a (?:bit|minute|moment|while|few)|an hour|\d+)|after|once|if|when|whenever|unless|until|in case)\b)`;
/** The clause names the agent's work: "the migration you added", "your commit". */
const OWNED = String.raw`(?=[^.!?;\n]{0,80}?\b(?:your|you(?:'ve| have)? (?:just |already )?(?:added|made|wrote|did|changed|created|pushed|committed|ran|applied|introduced|deployed|merged|shipped|put|moved|removed|deleted|renamed))\b)`;
/**
 * The clause, up to a comma, places the work nowhere else: not prod, a deploy, release or
 * migration, a pull request, upstream, a commit, version or earlier day by name, the person's own
 * change, someone else's ("Bob's change") or a tool's ("the changes the linter made").
 */
const NOT_ELSEWHERE = String.raw`(?![^.!?;,\n]{0,80}?(?:\b(?:prod|production|staging|deploys?|deployments?|releases?|migrations?|transactions?|pull requests?|upstream|yesterday|last (?:week|month|year|night|sprint|quarter)|(?:\d+|a|an|two|three|a few) (?:days?|weeks?|months?|years?) ago|the (?:linter|formatter|bot|codemod|generator)|i (?:made|wrote|added|pushed|committed|deployed|did)|my (?:own |last |latest |previous |recent )?(?:changes?|commits?|edits?|work|fix|patch|pr|branch))\b|\b(?!(?:let|that|it|what|here|there|who|he|she)'s\b)\w+'s (?:changes?|commits?|edits?|work|code|fix(?:es)?|patch(?:es)?|prs?|branch(?:es)?|refactors?|versions?)\b|\bv\d+(?:\.\d+)+\b|\bcommit (?=[0-9a-f]*\d)[0-9a-f]{4,40}\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|#\d+\b))`;
/** A named object is the agent's work: the clause says so, or places it nowhere else. */
const AGENTS = `(?:${OWNED}|${NOT_ELSEWHERE})`;
/** Not a failure the prompt says came first: "still failing on main from before your change", "pre-existing". */
const BEFORE_YOU = String.raw`(?![^.!?;\n]{0,60}?\b(?:(?:from|since) before|before (?:your|you)\b[^.!?;\n]{0,30}?\b(?:too|as well)|pre-?existing|unrelated to (?:your|you|the|this))\b)`;
/** Not someone else's code, or code the prompt calls old or known: "the upstream API still fails", "the old parser still fails". */
const OUTSIDE = String.raw`(?<!\b(?:upstream|third[- ]party|vendor|external|remote|their|legacy|old|flaky|existing|known|pre-?existing)\b[^.!?,;\n]{0,40})`;
/** Not a failure the sentence puts down to something known, or tells the agent to leave: "because of the flaky test", "for the vendor endpoint", "ignore it". */
const KNOWN = String.raw`(?![^.!?;\n]{0,80}?\b(?:(?:because of|due to|caused by|that'?s|it'?s|that is|it is) (?:the |an? )?(?:flaky|flake|old|known|existing|pre-?existing|unrelated|upstream|vendor|third[- ]party|external|legacy)\b|(?:for|from|on|in|at|with) the (?:vendor|upstream|third[- ]party|external|legacy)\b|ignore (?:it|that|this|them)\b|move on\b))`;
/** Not a failure the prompt expected: "now the tests fail, good". */
const UNEXPECTED = String.raw`(?![^.!?;\n]{0,40}?\b(?:as expected|as intended|expected|good|great|nice|perfect)\b)`;
/** Not a feature not built yet: "it doesn't work offline yet". */
const NOT_YET = String.raw`(?!(?:\s+[\w-]+){1,2}\s+yet\b)`;
/** Not splitting code up: "you broke it into smaller functions", "you broke down the parser". */
const SPLIT = String.raw`(?!\s+(?:(?:it|this|that|them|things|everything|the\s+\w+(?:\s+\w+)?)\s+)?(?:down|into|up|apart|out)\b)`;
/** Not "same error" inside another name, or the same as something named: "the same error handling", "the same error as v1" ("as before" still counts). */
const SAME_AS = String.raw`(?!\s+(?:handling|handler|handlers|class|classes|format|formatting|shape|logic|reporting|path|paths|wrapper|helper|helpers|pattern|style|semantics|contract|object|boundary|boundaries)\b)(?!(?:\s+\w+)?\s+as\s+(?!(?:before|earlier|previously|then|yesterday|last time|the last|the previous|the first)\b))`;
/** Words that can stand for the work at the start of a report: "the build broke", "now the tests fail". */
const WORK = String.raw`(?:the |all the |all )?(?:build|builds|tests?|ci|checks|app|page|site|server|everything)`;

const any = (parts: string[]): RegExp => new RegExp(parts.join("|"), "i");

const KIND_PATTERNS: [PushbackKind, RegExp][] = [
  ["intent", any([
    String.raw`\bnot what (?:i|we)(?:'m| am|'re| are| was| were)? (?:meant|mean|asked|asking|wanted|want|said|requested|intended|had in mind|discussed|agreed|described|expected|expecting|looking for|needed(?! to\b)|need(?! to\b))\b(?!,?\s+but\s+(?:it|that|this)(?:'s|\s+is)?\s+(?:works?|worked|fine|ok|okay|good|nice|better)\b)`,
    String.raw`\byou (?:misunderstood|misread|misinterpreted|misheard|got (?:it|me|that) wrong)\b`,
    String.raw`\bi (?:didn'?t|did not|never) (?:ask(?:ed)? (?:for|you)|want(?:ed)? (?:you|that|this|it|a|an|the|those|these)|(?:say|said) (?:that|this|to|you|it)|mean(?:t)? (?:that|this|it|the))\b`,
    // Not "I said thanks" or "I said I'd look later".
    LEAD + String.raw`i (?:meant|said)\b(?! to (?:mention|say|ask|add)\b)(?!\s+(?:thanks|thank you|thx|ty|ok|okay|yes|yeah|yep|sure|hi|hello|hey|please|lgtm|good|great|nice|i'd|i'll|i will|i would|i'm|i am|i was|i have|i've|we'd|we'll|we will|we would|maybe|later)\b)`,
    LEAD + String.raw`(?:that'?s|that is|this is) not it\b`,
    // "that's wrong", "no, that's not right."; not "that's not right now", "that's not correct English" or a question.
    LEAD + String.raw`(?:that'?s|that is|this is|it'?s|it is) (?:(?:all|completely|totally|just|still|also) )?(?:wrong|incorrect|not (?:right|correct))\b(?=\s*(?:[.!,;:)-]|$|either\b|again\b|too\b|though\b))(?![\s.!]*\?)`,
    LEAD + String.raw`wrong (?:file|one|function|method|class|component|page|place|branch|repo|folder|directory|thing|direction)\b`,
    LEAD + String.raw`not (?:that|this) one\b(?!\s+yet\b)`,
    String.raw`\byou (?:\w+ )?(?:edited|changed|modified|touched|updated|fixed|used|picked|deleted|removed|opened|read) the wrong\b`,
    String.raw`\b(?:that'?s|that is|this is) the wrong (?:file|one|function|method|class|component|page|place|branch|repo|folder|directory|thing)\b`,
    // "I asked for a bar chart, not a pie chart"; not "I wanted to add a test, not a big deal".
    String.raw`\bi (?:asked(?: you)?(?: for| to)?|wanted|said|meant) [^.!?;\n]{1,60}?, not (?!(?:a )?(?:big deal|problem|issue|priority|blocker|rush|worry)\b)(?:a|an|the|to)\b`,
    String.raw`\b(?:you did|that'?s|that is|this is|it'?s|it is) (?:the )?(?:exact )?opposite of what (?:i|we)\b`,
    GUARD + String.raw`\byou (?:were|weren'?t|were not) supposed to\b`,
  ])],
  ["undo", any([
    LEAD + String.raw`(?:undo|revert|roll ?back|back out)\b(?:${DONE}|${OBJECT})` + ON_FAIL + AGENTS,
    GUARD + String.raw`\b(?:undo|revert|roll ?back|back out)\s+(?:it|them|everything|your|all (?:of )?(?:it|them|your))\b` + ON_FAIL + AGENTS,
    GUARD + String.raw`\b(?:undo|revert|roll ?back|back out)\s+(?:that|this|those|these|all (?:of )?(?:that|this|those|these|the)|the (?:last|previous|latest|recent)|the (?:changes?|edits?|commits?))\b` + ON_FAIL + AGENTS,
    // "reverse your changes"; not "then reverse it so the newest is first".
    GUARD + String.raw`\breverse\s+(?:it|them|that|this|those|these|everything|all|the|what|your)\b` + OWNED,
    GUARD + FEATURE_BEFORE + String.raw`\b(?:revert|roll ?back|go back) to (?:the )?(?:previous|original|old|last|earlier|prior)\b` + ON_FAIL + AGENTS,
    GUARD + TIMED + FEATURE_BEFORE + String.raw`\bput (?:it|that|this|them|those|these|everything|the \w+(?: \w+)?) back\b` + TIMED_AFTER,
    GUARD + TIMED + FEATURE_BEFORE + String.raw`\b(?:change|set|switch|turn|move) (?:it|that|this|them) back\b` + TIMED_AFTER,
    ASK_YOU + String.raw`\b(?:remove (?:that|those)|take (?:that|those|it|them|this|these) out)\b(?=\s*(?:[.!?,;:]|$|again\b|please\b|too\b|now\b|entirely\b|completely\b))`,
    ASK_YOU + String.raw`\bremove (?:it|this|them|these) again\b`,
    String.raw`\b(?:remove|delete|drop|discard|undo|revert|get rid of|take out|throw away|back out) (?:what|everything|all|whatever) you (?:just |already )?(?:added|wrote|did|changed|made|put|created)\b`,
    String.raw`\b(?:remove|delete|drop|discard|get rid of|throw away) (?:all )?(?:of )?(?:your (?:changes?|edits?|additions?|code)|the (?:changes?|edits?|additions?|code|lines?) you (?:just |already )?(?:made|added|did|wrote|put))\b`,
    GUARD + TIMED + FEATURE_BEFORE + String.raw`\brestore (?:it|that|this|the (?:original|old|previous))\b` + TIMED_AFTER,
    GUARD + TIMED + FEATURE_BEFORE + String.raw`\bback to (?:how|what|the way) it was\b` + TIMED_AFTER,
  ])],
  ["redo", any([
    LEAD + String.raw`(?:try (?:it |that |this )?again${LATER}|redo${DONE}|retry${DONE}|start (?:over|again|from scratch)\b${FEATURE}(?!\s+(?:on|for)\b)|do (?:it|that|this) over)`,
    REACT + String.raw`start (?:over|again|from scratch)\b`,
    COND + String.raw`\b(?:please|pls|can you|could you|let'?s|just) try (?:it |that |this )?again\b` + LATER,
    COND + String.raw`\btry (?:it |that |this )?again[\s.!]*$`,
    String.raw`\bredo (?:it|that|this|them|those|everything|the (?:whole|entire)\b|the (?:changes?|edits?|work|implementation|fix|refactor|design|layout|thing|code|tests?|function|file|page|ui)\b)`,
    COND + String.raw`\bstart (?:over|from scratch)\b` + FEATURE + String.raw`(?!\s+(?:on|for)\b)`,
    // "do it again but with tabs"; not "do that again for the users table".
    LEAD + String.raw`do (?:it|that|this) again\b(?=\s*(?:[.!?,;:]|$|but\b|please\b|properly\b|correctly\b|right\b))`,
    String.raw`\bgive it another (?:try|shot|go|attempt)\b`,
    String.raw`\bi (?:don'?t|do not) like (?:it|them|(?:that|this|those|these)(?=\s*(?:[.!?,;:)]|$|(?:at all|either|one|ones|much|very much|so much|anymore|any more)\b))|(?:the|this|that|these|those|your) (?:result|results|change|changes|approach|way|design|look|output|names?|naming|style|implementation|fix|solution|code|answer|ui|layout|wording|version))\b(?!\s+(?:when|if|how)\b)`,
    LEAD + String.raw`(?:don'?t|do not) like (?:it|this|that|them)\b(?=\s*(?:[.!?,;:]|$|at all\b|much\b|either\b))`,
    String.raw`\bnot (?:happy|satisfied) with (?:it|that|this|the (?:result|results|change|changes|approach|output|fix|solution))\b`,
  ])],
  ["broken", any([
    GUARD + ASKED + OUTSIDE + String.raw`\bstill (?:broken|failing|fails|failed|crashing|crashes|crashed|erroring|errors out|throwing|throws|hangs|hanging|red|wrong|not (?:working|work|fixed|passing|compiling|building|right)|(?:doesn'?t|does not|won'?t|will not) (?:work|pass|compile|build|start|run))\b` + BEFORE_YOU + KNOWN,
    // Not the person's own "I didn't fix it".
    GUARD + String.raw`(?<!\bi (?:\w+ )?)\b(?:didn'?t|did not) (?:work(?! on\b)|fix|help|solve|change anything|do anything)\b`,
    GUARD + String.raw`\b(?:it|that|this|they) (?:still )?(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not) (?:work|working|fixed|compile|compiling)\b` + NOT_YET,
    GUARD + String.raw`\b(?:it'?s|it is|that'?s|that is|this is) (?:still )?not (?:working|fixed|compiling)\b` + NOT_YET,
    LEAD + String.raw`(?:still )?(?:doesn'?t|does not|not|isn'?t|is not) (?:work|working)\b(?=\s*(?:[.!?,;:]|$|(?:for me|either|now|at all)\b))`,
    GUARD + String.raw`\byou(?:'ve| have| just)? (?:broke|broken)\b` + SPLIT,
    // "that broke the build" opens its clause; "the change that broke login" names a change.
    GUARD + String.raw`(?:(?<=^|[.!?,;:]\s*|\b(?:and|but|so|now|ok|okay|no|nope|hmm+|ugh+|well|actually|wait|sorry)\s+)that|\b(?:this|it|your (?:change|edit|fix|commit|code|patch|update)s?)) (?:broke|has broken|have broken)\b` + SPLIT,
    GUARD + String.raw`\b(?:you(?:'ve| have)?|that|this|it|your (?:change|edit|fix|commit|code|patch|update)s?) (?:just )?(?:made|has made|have made) (?:it|things|this|that|everything|the \w+(?: \w+)?) worse\b`,
    LEAD + String.raw`(?:it'?s|it is|that'?s|that is|this is|things are|everything is) (?:even |much |way |a lot |now )?worse\b(?=\s*(?:[.!?,;:]|$|now\b|than (?:before|it was)\b))`,
    // Only at the start: mid-sentence it is usually a check that passed ("ran the formatter, nothing changed").
    LEAD + String.raw`(?:still )?nothing (?:has |have )?(?:changed|happened)\b(?=\s*(?:[.!?,;:]|$))(?![\s,.!;:-]*(?:great|good|nice|perfect|awesome|excellent|as expected|as intended|which is (?:good|great|fine|expected)|so (?:the|it|that|we)\b))`,
    GUARD + String.raw`\b(?:get|getting|got|see|seeing|saw|have|having|has|had|hit|hitting|throws|throwing|threw|shows|showing|showed|gives|giving|gave|returns|returning|returned)\s+(?:the\s+)?same (?:error|errors|failure|failures|exception|crash|problem|issue)\b` + SAME_AS,
    LEAD + String.raw`(?:still )?(?:the )?same (?:error|errors|failure|failures|exception|crash)\b` + SAME_AS,
    LEAD + String.raw`(?:still )?(?:the )?same (?:issue|problem)\b(?=\s*(?:[.!?;:]|$|again\b|as before\b))`,
    GUARD + String.raw`\bsame (?:error|errors|failure|exception|crash) (?:as before|again)\b`,
    GUARD + ASKED + OUTSIDE + String.raw`\bstill (?:get|getting|see|seeing|have|having)(?: (?:the|an|this|that|a))? (?:error|errors|failure|failures|exception|crash)\b` + BEFORE_YOU + KNOWN,
    GUARD + String.raw`\b(?:fails|failing|failed|broken|crashing|crashes|crashed) again\b`,
    // "the build broke", "now the tests fail", "tests are failing now", "getting a 500 now".
    LEAD + WORK + String.raw` broke\b(?=\s*(?:[.!?,;:]|$|again\b|now\b))`,
    LEAD + String.raw`now,? (?:${WORK}|it|they) (?:fails?|failing|crash(?:es|ing)?|breaks|broke|errors(?: out)?|throws|hangs|(?:is|are) (?:failing|crashing|broken|erroring))\b` + UNEXPECTED,
    LEAD + String.raw`(?:${WORK}|it|they)(?:'s|'re|\s+is|\s+are)?\s+(?:failing|crashing|broken|erroring|fails|crashes) now\b` + UNEXPECTED,
    LEAD + String.raw`(?:now )?(?:i'?m )?(?:getting|seeing) (?:a |an )?(?:[45]\d\d|error|errors|exception|crash|blank page|white screen)\b(?: \w+)? now\b(?! and then\b)` + UNEXPECTED,
    LEAD + String.raw`(?:the )?(?:page|screen|app|site|window|output) is (?:blank|empty|white) now\b` + UNEXPECTED,
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
