// Pushback kinds (core/pushback.ts pushbackKind). An alternative that opens with a lookbehind (a
// condition, a check, a question, a feature, someone else's code) has a lookahead on its first words
// in front, so the lookbehind runs only where those words start. This file keeps the alternatives as
// they were without the lookaheads, and checks:
//
// - Each alternative is the one it replaced, or that one with a lookahead in front of its lookbehind.
// - On generated prompts, each alternative matches when the one it replaced does, and pushbackKind
//   gives the kind the old alternatives give.
//
// A prompt is built from pieces: the start of each alternative that opens with a lookbehind (its
// first words, then what may follow them, sometimes cut at a word), the words the lookbehinds look
// for ("if", "make sure", "is it", "can you", "button", "upstream", ...), every word the old
// alternatives name, contractions, paths, versions and hashes. The pieces are joined by spaces,
// punctuation, line ends, brackets and straight and curly quotes, or by nothing. Some are capitalized,
// some have a curly apostrophe, and some prompts run past the 400 characters pushbackKind reads.
//
// The last test shows the check fails on a lookahead of each kind that misses a word its alternative
// starts with. CODING_SH_PROP_RUNS=n runs n cases (default 200); CODING_SH_PROP_SEED=s replays one.
// The last test reads neither.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KIND_ALTERNATIVES, PUSHBACK_KINDS, pushbackKind, type PushbackKind } from "../../src/core/pushback.ts";
import { forAll, gen, PropertyFailure, sample, type ForAllOptions, type Gen } from "../_prop.ts";

const RUNS = 200;
const MUTANT_RUNS = 1000;

type Alternatives = readonly (readonly [PushbackKind, readonly string[]])[];

/** The alternatives as core/pushback.ts had them before the lookaheads, the kinds in the order it tries them. */
function oldAlternatives(): [PushbackKind, string[]][] {
  const LEAD = String.raw`^(?:(?:no|nope|nah|ok|okay|hmm+|ugh+|um+|uh+|please|pls|wait|sorry|actually|well|so|hey|stop)\b[\s,.!:;-]*)*`;
  const REACT = String.raw`^(?:(?:no|nope|nah|hmm+|ugh+|wait|stop|actually)\b[\s,.!:;-]*)+`;
  const GUARD = String.raw`(?<!\b(?:if|when|unless|whether|until|in case|check|checks|verify|verifies|ensure|ensures|confirm|make sure|be sure)\b[^.!?,;\n]{0,40})`;
  const COND = String.raw`(?<!\b(?:if|when|unless|whether|until|in case)\b[^.!?\n]{0,80})`;
  const EVENT = String.raw`on (?:failures?|errors?|exit|crash|shutdown|teardown|start-?up|start|boot|load|reload|restart|resume|launch|init|open|close|login|logout|mount|unmount)\b(?![./-]\w)`;
  const TIMED = String.raw`(?<!\b(?:if|when|whenever|unless|whether|until|in case|after|once|${EVENT})\b[^.!?\n]{0,80})`;
  const TIMED_AFTER = String.raw`(?![^.!?,;\n]{0,60}?\b(?:if(?! (?:you can|you could|possible|needed|necessary|you want)\b)|when|whenever|unless|until|in case|after|once|${EVENT}|from (?:the |a |an )?(?:backups?|snapshots?|dumps?|archives?))\b)`;
  const ON_FAIL = String.raw`(?![^.!?,;\n]{0,60}?\b(?:${EVENT}|(?:if|when|whenever|once|after) (?:the |a |an |any |it |that |this |they )?(?:[\w-]+ )?(?:fails?|failed|errors?|errored|throws?|threw|crash(?:es|ed)?|times? out|timed out|aborts?|aborted))\b)`;
  const ASKED = String.raw`(?<!(?:^|[.!?]\s*)(?:is|are|was|were|does|do|did)\s+(?:it|that|this|they|the\s+\w+)\s+)`;
  const ASK_YOU = String.raw`(?<!\b(?:why|why'?d|did|do|does|didn'?t|don'?t|can|could|should|would|will)\s+you\s+)`;
  const FEATURE = String.raw`(?!\s+(?:button|command|feature|function|option|support|stack|history|log|logic|script|tool|key|shortcut|endpoint|api|operation|action|mechanism|handler)s?\b)`;
  const FEATURE_BEFORE = String.raw`(?<!\b(?:button|link|command|feature|function|option|tool|key|shortcut|menu|control|action|mode|endpoint|handler|setting|way|ability)s?\b[^.!?,;\n]{0,30})`;
  const DONE = String.raw`(?=\s*(?:[.!?,;:)]|$|please\b|pls\b|now\b|again\b))`;
  const OBJECT = String.raw`(?=\s+(?:it|that|this|those|these|them|everything|all|your|the|whatever|what\b(?!\s*\?))\b)`;
  const LATER = String.raw`(?!\s+(?:later|tomorrow|tonight|next (?:week|time)|in (?:a (?:bit|minute|moment|while|few)|an hour|\d+)|after|once|if|when|whenever|unless|until|in case)\b)`;
  const OWNED = String.raw`(?=[^.!?;\n]{0,80}?\b(?:your|you(?:'ve| have)? (?:just |already )?(?:added|made|wrote|did|changed|created|pushed|committed|ran|applied|introduced|deployed|merged|shipped|put|moved|removed|deleted|renamed))\b)`;
  const NOT_ELSEWHERE = String.raw`(?![^.!?;,\n]{0,80}?(?:\b(?:prod|production|staging|deploys?|deployments?|releases?|migrations?|transactions?|pull requests?|upstream|yesterday|last (?:week|month|year|night|sprint|quarter)|(?:\d+|a|an|two|three|a few) (?:days?|weeks?|months?|years?) ago|the (?:linter|formatter|bot|codemod|generator)|i (?:made|wrote|added|pushed|committed|deployed|did)|my (?:own |last |latest |previous |recent )?(?:changes?|commits?|edits?|work|fix|patch|pr|branch))\b|\b(?!(?:let|that|it|what|here|there|who|he|she)'s\b)\w+'s (?:changes?|commits?|edits?|work|code|fix(?:es)?|patch(?:es)?|prs?|branch(?:es)?|refactors?|versions?)\b|\bv\d+(?:\.\d+)+\b|\bcommit (?=[0-9a-f]*\d)[0-9a-f]{4,40}\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b|#\d+\b))`;
  const AGENTS = `(?:${OWNED}|${NOT_ELSEWHERE})`;
  const BEFORE_YOU = String.raw`(?![^.!?;\n]{0,60}?\b(?:(?:from|since) before|before (?:your|you)\b[^.!?;\n]{0,30}?\b(?:too|as well)|pre-?existing|unrelated to (?:your|you|the|this))\b)`;
  const OUTSIDE = String.raw`(?<!\b(?:upstream|third[- ]party|vendor|external|remote|their|legacy|old|flaky|existing|known|pre-?existing)\b[^.!?,;\n]{0,40})`;
  const KNOWN = String.raw`(?![^.!?;\n]{0,80}?\b(?:(?:because of|due to|caused by|that'?s|it'?s|that is|it is) (?:the |an? )?(?:flaky|flake|old|known|existing|pre-?existing|unrelated|upstream|vendor|third[- ]party|external|legacy)\b|(?:for|from|on|in|at|with) the (?:vendor|upstream|third[- ]party|external|legacy)\b|ignore (?:it|that|this|them)\b|move on\b))`;
  const UNEXPECTED = String.raw`(?![^.!?;\n]{0,40}?\b(?:as expected|as intended|expected|good|great|nice|perfect)\b)`;
  const NOT_YET = String.raw`(?!(?:\s+[\w-]+){1,2}\s+yet\b)`;
  const SPLIT = String.raw`(?!\s+(?:(?:it|this|that|them|things|everything|the\s+\w+(?:\s+\w+)?)\s+)?(?:down|into|up|apart|out)\b)`;
  const SAME_AS = String.raw`(?!\s+(?:handling|handler|handlers|class|classes|format|formatting|shape|logic|reporting|path|paths|wrapper|helper|helpers|pattern|style|semantics|contract|object|boundary|boundaries)\b)(?!(?:\s+\w+)?\s+as\s+(?!(?:before|earlier|previously|then|yesterday|last time|the last|the previous|the first)\b))`;
  const WORK = String.raw`(?:the |all the |all )?(?:build|builds|tests?|ci|checks|app|page|site|server|everything)`;
  return [
    ["intent", [
      String.raw`\bnot what (?:i|we)(?:'m| am|'re| are| was| were)? (?:meant|mean|asked|asking|wanted|want|said|requested|intended|had in mind|discussed|agreed|described|expected|expecting|looking for|needed(?! to\b)|need(?! to\b))\b(?!,?\s+but\s+(?:it|that|this)(?:'s|\s+is)?\s+(?:works?|worked|fine|ok|okay|good|nice|better)\b)`,
      String.raw`\byou (?:misunderstood|misread|misinterpreted|misheard|got (?:it|me|that) wrong)\b`,
      String.raw`\bi (?:didn'?t|did not|never) (?:ask(?:ed)? (?:for|you)|want(?:ed)? (?:you|that|this|it|a|an|the|those|these)|(?:say|said) (?:that|this|to|you|it)|mean(?:t)? (?:that|this|it|the))\b`,
      LEAD + String.raw`i (?:meant|said)\b(?! to (?:mention|say|ask|add)\b)(?!\s+(?:thanks|thank you|thx|ty|ok|okay|yes|yeah|yep|sure|hi|hello|hey|please|lgtm|good|great|nice|i'd|i'll|i will|i would|i'm|i am|i was|i have|i've|we'd|we'll|we will|we would|maybe|later)\b)`,
      LEAD + String.raw`(?:that'?s|that is|this is) not it\b`,
      LEAD + String.raw`(?:that'?s|that is|this is|it'?s|it is) (?:(?:all|completely|totally|just|still|also) )?(?:wrong|incorrect|not (?:right|correct))\b(?=\s*(?:[.!,;:)-]|$|either\b|again\b|too\b|though\b))(?![\s.!]*\?)`,
      LEAD + String.raw`wrong (?:file|one|function|method|class|component|page|place|branch|repo|folder|directory|thing|direction)\b`,
      LEAD + String.raw`not (?:that|this) one\b(?!\s+yet\b)`,
      String.raw`\byou (?:\w+ )?(?:edited|changed|modified|touched|updated|fixed|used|picked|deleted|removed|opened|read) the wrong\b`,
      String.raw`\b(?:that'?s|that is|this is) the wrong (?:file|one|function|method|class|component|page|place|branch|repo|folder|directory|thing)\b`,
      String.raw`\bi (?:asked(?: you)?(?: for| to)?|wanted|said|meant) [^.!?;\n]{1,60}?, not (?!(?:a )?(?:big deal|problem|issue|priority|blocker|rush|worry)\b)(?:a|an|the|to)\b`,
      String.raw`\b(?:you did|that'?s|that is|this is|it'?s|it is) (?:the )?(?:exact )?opposite of what (?:i|we)\b`,
      GUARD + String.raw`\byou (?:were|weren'?t|were not) supposed to\b`,
    ]],
    ["undo", [
      LEAD + String.raw`(?:undo|revert|roll ?back|back out)\b(?:${DONE}|${OBJECT})` + ON_FAIL + AGENTS,
      GUARD + String.raw`\b(?:undo|revert|roll ?back|back out)\s+(?:it|them|everything|your|all (?:of )?(?:it|them|your))\b` + ON_FAIL + AGENTS,
      GUARD + String.raw`\b(?:undo|revert|roll ?back|back out)\s+(?:that|this|those|these|all (?:of )?(?:that|this|those|these|the)|the (?:last|previous|latest|recent)|the (?:changes?|edits?|commits?))\b` + ON_FAIL + AGENTS,
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
    ]],
    ["redo", [
      LEAD + String.raw`(?:try (?:it |that |this )?again${LATER}|redo${DONE}|retry${DONE}|start (?:over|again|from scratch)\b${FEATURE}(?!\s+(?:on|for)\b)|do (?:it|that|this) over)`,
      REACT + String.raw`start (?:over|again|from scratch)\b`,
      COND + String.raw`\b(?:please|pls|can you|could you|let'?s|just) try (?:it |that |this )?again\b` + LATER,
      COND + String.raw`\btry (?:it |that |this )?again[\s.!]*$`,
      String.raw`\bredo (?:it|that|this|them|those|everything|the (?:whole|entire)\b|the (?:changes?|edits?|work|implementation|fix|refactor|design|layout|thing|code|tests?|function|file|page|ui)\b)`,
      COND + String.raw`\bstart (?:over|from scratch)\b` + FEATURE + String.raw`(?!\s+(?:on|for)\b)`,
      LEAD + String.raw`do (?:it|that|this) again\b(?=\s*(?:[.!?,;:]|$|but\b|please\b|properly\b|correctly\b|right\b))`,
      String.raw`\bgive it another (?:try|shot|go|attempt)\b`,
      String.raw`\bi (?:don'?t|do not) like (?:it|them|(?:that|this|those|these)(?=\s*(?:[.!?,;:)]|$|(?:at all|either|one|ones|much|very much|so much|anymore|any more)\b))|(?:the|this|that|these|those|your) (?:result|results|change|changes|approach|way|design|look|output|names?|naming|style|implementation|fix|solution|code|answer|ui|layout|wording|version))\b(?!\s+(?:when|if|how)\b)`,
      LEAD + String.raw`(?:don'?t|do not) like (?:it|this|that|them)\b(?=\s*(?:[.!?,;:]|$|at all\b|much\b|either\b))`,
      String.raw`\bnot (?:happy|satisfied) with (?:it|that|this|the (?:result|results|change|changes|approach|output|fix|solution))\b`,
    ]],
    ["broken", [
      GUARD + ASKED + OUTSIDE + String.raw`\bstill (?:broken|failing|fails|failed|crashing|crashes|crashed|erroring|errors out|throwing|throws|hangs|hanging|red|wrong|not (?:working|work|fixed|passing|compiling|building|right)|(?:doesn'?t|does not|won'?t|will not) (?:work|pass|compile|build|start|run))\b` + BEFORE_YOU + KNOWN,
      GUARD + String.raw`(?<!\bi (?:\w+ )?)\b(?:didn'?t|did not) (?:work(?! on\b)|fix|help|solve|change anything|do anything)\b`,
      GUARD + String.raw`\b(?:it|that|this|they) (?:still )?(?:doesn'?t|does not|don'?t|do not|isn'?t|is not|aren'?t|are not) (?:work|working|fixed|compile|compiling)\b` + NOT_YET,
      GUARD + String.raw`\b(?:it'?s|it is|that'?s|that is|this is) (?:still )?not (?:working|fixed|compiling)\b` + NOT_YET,
      LEAD + String.raw`(?:still )?(?:doesn'?t|does not|not|isn'?t|is not) (?:work|working)\b(?=\s*(?:[.!?,;:]|$|(?:for me|either|now|at all)\b))`,
      GUARD + String.raw`\byou(?:'ve| have| just)? (?:broke|broken)\b` + SPLIT,
      GUARD + String.raw`(?:(?<=^|[.!?,;:]\s*|\b(?:and|but|so|now|ok|okay|no|nope|hmm+|ugh+|well|actually|wait|sorry)\s+)that|\b(?:this|it|your (?:change|edit|fix|commit|code|patch|update)s?)) (?:broke|has broken|have broken)\b` + SPLIT,
      GUARD + String.raw`\b(?:you(?:'ve| have)?|that|this|it|your (?:change|edit|fix|commit|code|patch|update)s?) (?:just )?(?:made|has made|have made) (?:it|things|this|that|everything|the \w+(?: \w+)?) worse\b`,
      LEAD + String.raw`(?:it'?s|it is|that'?s|that is|this is|things are|everything is) (?:even |much |way |a lot |now )?worse\b(?=\s*(?:[.!?,;:]|$|now\b|than (?:before|it was)\b))`,
      LEAD + String.raw`(?:still )?nothing (?:has |have )?(?:changed|happened)\b(?=\s*(?:[.!?,;:]|$))(?![\s,.!;:-]*(?:great|good|nice|perfect|awesome|excellent|as expected|as intended|which is (?:good|great|fine|expected)|so (?:the|it|that|we)\b))`,
      GUARD + String.raw`\b(?:get|getting|got|see|seeing|saw|have|having|has|had|hit|hitting|throws|throwing|threw|shows|showing|showed|gives|giving|gave|returns|returning|returned)\s+(?:the\s+)?same (?:error|errors|failure|failures|exception|crash|problem|issue)\b` + SAME_AS,
      LEAD + String.raw`(?:still )?(?:the )?same (?:error|errors|failure|failures|exception|crash)\b` + SAME_AS,
      LEAD + String.raw`(?:still )?(?:the )?same (?:issue|problem)\b(?=\s*(?:[.!?;:]|$|again\b|as before\b))`,
      GUARD + String.raw`\bsame (?:error|errors|failure|exception|crash) (?:as before|again)\b`,
      GUARD + ASKED + OUTSIDE + String.raw`\bstill (?:get|getting|see|seeing|have|having)(?: (?:the|an|this|that|a))? (?:error|errors|failure|failures|exception|crash)\b` + BEFORE_YOU + KNOWN,
      GUARD + String.raw`\b(?:fails|failing|failed|broken|crashing|crashes|crashed) again\b`,
      LEAD + WORK + String.raw` broke\b(?=\s*(?:[.!?,;:]|$|again\b|now\b))`,
      LEAD + String.raw`now,? (?:${WORK}|it|they) (?:fails?|failing|crash(?:es|ing)?|breaks|broke|errors(?: out)?|throws|hangs|(?:is|are) (?:failing|crashing|broken|erroring))\b` + UNEXPECTED,
      LEAD + String.raw`(?:${WORK}|it|they)(?:'s|'re|\s+is|\s+are)?\s+(?:failing|crashing|broken|erroring|fails|crashes) now\b` + UNEXPECTED,
      LEAD + String.raw`(?:now )?(?:i'?m )?(?:getting|seeing) (?:a |an )?(?:[45]\d\d|error|errors|exception|crash|blank page|white screen)\b(?: \w+)? now\b(?! and then\b)` + UNEXPECTED,
      LEAD + String.raw`(?:the )?(?:page|screen|app|site|window|output) is (?:blank|empty|white) now\b` + UNEXPECTED,
    ]],
  ];
}

const OLD = oldAlternatives();
/** An alternative that opens with a lookbehind. */
const BEHIND_FIRST = /^\(\?<[=!]/;
/** The lookahead on an alternative's first words: `(?=\b(?:undo|revert)\b)`. */
const LOOKAHEAD = /^\(\?=\\b\(\?:([^()]+)\)\\b\)/;

/** The text pushbackKind reads: trimmed, its first 400 characters, curly apostrophes made straight. */
function prepared(text: string): string {
  return text.trim().slice(0, 400).replace(/[\u2018\u2019]/g, "'");
}

/** pushbackKind over `alts`: the first kind with an alternative that matches the text it reads. */
function kindFrom(alts: Alternatives): (text: string) => PushbackKind | undefined {
  const res = alts.map(([kind, parts]) => [kind, new RegExp(parts.join("|"), "i")] as const);
  return (text) => {
    const t = prepared(text);
    if (!t) return undefined;
    for (const [kind, re] of res) if (re.test(t)) return kind;
    return undefined;
  };
}

const oldKind = kindFrom(OLD);
const OLD_EACH = OLD.map(([kind, parts]) => [kind, parts.map((p) => new RegExp(p, "i"))] as const);

/** Each of `alts` matches a prompt when the old alternative in its place does, and `kindOf` gives the old kind. */
function check(alts: Alternatives, kindOf: (text: string) => PushbackKind | undefined): (text: string) => void {
  const now = alts.map(([, parts]) => parts.map((p) => new RegExp(p, "i")));
  return (text) => {
    const t = prepared(text);
    OLD_EACH.forEach(([kind, olds], k) => {
      olds.forEach((old, j) => {
        assert.equal(now[k]?.[j]?.test(t), old.test(t), `${kind} alternative ${j + 1} (${old.source.slice(0, 50)}...) on ${JSON.stringify(t)}`);
      });
    });
    assert.equal(kindOf(text), oldKind(text), `the kind of ${JSON.stringify(t)}`);
  };
}

/** The start of each alternative that opens with a lookbehind: its first words, then what may follow them. */
const STARTS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [["you"], ["were supposed to", "weren't supposed to", "werent supposed to", "were not supposed to"]],
  [["undo", "revert", "roll back", "rollback", "back out"], ["it", "them", "everything", "your", "all of it", "all them", "that", "this", "those", "these", "all of that", "all the", "the last", "the previous", "the latest", "the recent", "the change", "the edits", "the commits"]],
  [["reverse"], ["it", "them", "that", "this", "those", "these", "everything", "all", "the", "what", "your"]],
  [["revert", "roll back", "rollback", "go back"], ["to the previous", "to previous", "to the original", "to the old", "to last", "to the earlier", "to prior"]],
  [["put"], ["it back", "that back", "this back", "them back", "those back", "these back", "everything back", "the test back", "the old test back"]],
  [["change", "set", "switch", "turn", "move"], ["it back", "that back", "this back", "them back"]],
  [["remove", "take"], ["that", "those", "that out", "those out", "it out", "them out", "this out", "these out"]],
  [["remove"], ["it again", "this again", "them again", "these again"]],
  [["restore"], ["it", "that", "this", "the original", "the old", "the previous"]],
  [["back"], ["to how it was", "to what it was", "to the way it was"]],
  [["please", "pls", "can you", "could you", "let's", "lets", "just"], ["try again", "try it again", "try that again", "try this again"]],
  [["try"], ["again", "it again", "that again", "this again"]],
  [["start"], ["over", "from scratch"]],
  [["still"], ["broken", "failing", "fails", "failed", "crashing", "crashes", "crashed", "erroring", "errors out", "throwing", "throws", "hangs", "hanging", "red", "wrong", "not working", "not work", "not fixed", "not passing", "not compiling", "not building", "not right", "doesn't work", "does not pass", "won't compile", "will not build", "wont start", "get the error", "getting an error", "see errors", "seeing a failure", "have this exception", "having that crash"]],
  [["didn't", "didnt", "did not"], ["work", "fix", "help", "solve", "change anything", "do anything", "work on"]],
  [["it", "that", "this", "they"], ["doesn't work", "does not work", "don't work", "do not compile", "isn't working", "is not fixed", "aren't compiling", "are not working", "still doesn't work", "still isn't fixed"]],
  [["it's", "its", "it is", "that's", "thats", "that is", "this is"], ["not working", "not fixed", "not compiling", "still not working"]],
  [["you", "you've", "you have", "you just"], ["broke", "broken"]],
  [["that", "this", "it", "your change", "your edits", "your fix", "your commits", "your code", "your patch", "your update"], ["broke", "has broken", "have broken"]],
  [["you", "you've", "you have", "that", "this", "it", "your change", "your edit", "your fixes", "your commit"], ["made it worse", "just made things worse", "has made this worse", "have made that worse", "made everything worse", "made the error message worse", "made the page worse"]],
  [["get", "getting", "got", "see", "seeing", "saw", "have", "having", "has", "had", "hit", "hitting", "throws", "throwing", "threw", "shows", "showing", "showed", "gives", "giving", "gave", "returns", "returning", "returned"], ["the same error", "same errors", "the same failure", "same failures", "the same exception", "same crash", "the same problem", "same issue"]],
  [["same"], ["error as before", "errors again", "failure again", "exception as before", "crash again"]],
  [["fails", "failing", "failed", "broken", "crashing", "crashes", "crashed"], ["again"]],
];

/** Words the lookbehinds look for: a condition, a check, a time, a question, a request, a feature, someone else's code, a reaction. */
const BEHIND = [
  "if", "when", "whenever", "unless", "whether", "until", "in case", "check", "checks", "verify", "verifies", "ensure", "ensures", "confirm", "make sure", "be sure",
  "after", "once", "on failure", "on errors", "on exit", "on startup", "on start-up", "on login", "on login.ts", "on load",
  "is it", "are they", "was that", "were the tests", "does this", "do they", "did the build",
  "why", "why'd", "why did you", "did you", "do you", "does you", "didn't you", "don't you", "can you", "could you", "should you", "would you", "will you",
  "button", "buttons", "link", "command", "feature", "function", "option", "tool", "key", "shortcut", "menu", "control", "action", "mode", "endpoint", "handler", "setting", "way", "ability",
  "upstream", "third-party", "third party", "vendor", "external", "remote", "their", "legacy", "old", "flaky", "existing", "known", "pre-existing", "preexisting",
  "and", "but", "so", "now", "ok", "okay", "no", "nope", "hmm", "hmmm", "ugh", "well", "actually", "wait", "sorry",
  "i", "i really", "we", "you", "a", "the",
];
/** Every word the old alternatives name, from their sources with the escapes (\b, \s, \w) taken out. */
const WORDS = [...new Set(OLD.flatMap(([, parts]) => parts).join(" ").replace(/\\[a-z]/gi, " ").match(/[a-z]+(?:'[a-z]+)?/gi) ?? [])];
const CONTRACTIONS = ["didn't", "doesn't", "don't", "isn't", "aren't", "won't", "weren't", "can't", "it's", "that's", "let's", "i'm", "i'd", "i'll", "i've", "we'd", "you've", "why'd", "what's", "here's"];
const OTHER = ["src/a.ts", "login.ts", "./run.sh", "v1.2", "v2.0.1", "abc1234", "commit 9f3e2a1", "#12", "Bob's", "bob's change", "500", "404", "ctrl+z", "e.g.", "x", "-", "..."];
const SEPARATORS = [", ", ". ", "! ", "? ", "; ", ": ", " - ", "\n", "  ", " (", ") ", ' "', '" ', " '", "' ", " \u2018", "\u2019 ", " \u201c", "\u201d ", "...", "\t", ""];
const ENDS = ["", ".", "!", "?", " ?", "...", "!!", "\n", " "];

const START: Gen<string> = gen.chain(gen.pick(STARTS), ([firsts, rests]) =>
  gen.map(gen.tuple<[string, string, boolean]>(gen.pick(firsts), gen.pick(rests), gen.weighted(0.15)), ([first, rest, cut]) => {
    const s = `${first} ${rest}`;
    return cut ? s.slice(0, s.lastIndexOf(" ")) : s;
  }),
);
const WORD: Gen<string> = gen.frequency<string>([4, START], [3, gen.pick(BEHIND)], [4, gen.pick(WORDS)], [1, gen.pick(CONTRACTIONS)], [1, gen.pick(OTHER)]);
const PIECE: Gen<string> = gen.map(
  gen.tuple<[string, string, number, boolean]>(gen.frequency<string>([6, gen.constant(" ")], [3, gen.pick(SEPARATORS)]), WORD, gen.int(0, 9), gen.weighted(0.1)),
  ([sep, word, c, curly]) => {
    const w = c === 0 ? word.toUpperCase() : c <= 2 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    return sep + (curly ? w.replace(/'/g, "\u2019") : w);
  },
);
/** A prompt; one in ten starts with 300 to 399 characters of filler, so the 400 characters end inside it. */
const TEXT: Gen<string> = gen.map(
  gen.tuple<[boolean, number, string[], string]>(gen.weighted(0.1), gen.int(300, 399), gen.array(PIECE, { minLength: 1, maxLength: 30, avgLength: 8 }), gen.pick(ENDS)),
  ([padded, pad, pieces, end]) => {
    const body = pieces.join("") + end;
    return padded ? `${"x ".repeat(Math.ceil(pad / 2))}${body}` : body;
  },
);

test("each alternative is the old one, or the old one with a lookahead on its first words in front of its lookbehind", (t) => {
  assert.deepEqual(KIND_ALTERNATIVES.map(([kind]) => kind), [...PUSHBACK_KINDS]);
  assert.deepEqual(OLD.map(([kind]) => kind), [...PUSHBACK_KINDS]);
  let ahead = 0;
  OLD.forEach(([kind, olds], k) => {
    const news = KIND_ALTERNATIVES[k]?.[1] ?? [];
    assert.equal(news.length, olds.length, `${kind}: as many alternatives as before`);
    olds.forEach((old, j) => {
      const now = news[j] ?? "";
      const lead = LOOKAHEAD.exec(now);
      if (BEHIND_FIRST.test(old)) {
        assert.ok(lead, `${kind} alternative ${j + 1} has a lookahead in front: ${now.slice(0, 60)}`);
        assert.equal(now.slice(lead[0].length), old, `${kind} alternative ${j + 1} is the old one after its lookahead`);
        ahead++;
      } else {
        assert.equal(now, old, `${kind} alternative ${j + 1} is the old one`);
      }
    });
  });
  t.diagnostic(`${ahead} of ${OLD.flatMap(([, parts]) => parts).length} alternatives have a lookahead in front`);
});

test("the prompts reach every alternative that opens with a lookbehind, every kind and no kind", () => {
  const texts = sample(TEXT, 2000, 1);
  const read = texts.map(prepared);
  OLD_EACH.forEach(([kind, olds], k) => {
    olds.forEach((old, j) => {
      if (BEHIND_FIRST.test(OLD[k]?.[1][j] ?? "")) assert.ok(read.some((t) => old.test(t)), `no prompt reaches ${kind} alternative ${j + 1}: ${old.source.slice(0, 60)}`);
    });
  });
  const kinds = new Set(texts.map(oldKind));
  for (const kind of [...PUSHBACK_KINDS, undefined]) assert.ok(kinds.has(kind), `no prompt is ${kind ?? "no kind"}`);
  assert.ok(texts.some((t) => t.length > 400), "a prompt runs past 400 characters");
});

test("each alternative matches the prompts the old one did, and pushbackKind gives the old kind", async (t) => {
  const prop = check(KIND_ALTERNATIVES, pushbackKind);
  const seen = new Map<string, number>();
  await forAll(
    TEXT,
    (text) => {
      const kind = oldKind(text) ?? "no kind";
      seen.set(kind, (seen.get(kind) ?? 0) + 1);
      prop(text);
    },
    { runs: RUNS, label: "pushback kinds" },
  );
  t.diagnostic([...seen].map(([kind, n]) => `${kind} ${n}`).join(", "));
});

test("the check fails on a lookahead of each kind that misses a word its alternative starts with", async (t) => {
  const mutants: [PushbackKind, string, string][] = [
    ["intent", "you", "your"],
    ["undo", "change|set|switch|turn|move", "change|set|switch|turn"],
    ["redo", "please|pls|can you|could you|let'?s|just", "please|pls|can you|could you|just"],
    ["broken", "fails|failing|failed|broken|crashing|crashes|crashed", "fails|failing|failed|broken|crashing|crashes"],
  ];
  for (const [kind, words, to] of mutants) {
    const alts = mutant(kind, words, to);
    const label = `${kind}: (?:${words}) as (?:${to})`;
    const f = await failure(TEXT, check(alts, kindFrom(alts)), { env: {}, runs: MUTANT_RUNS, maxShrinks: 200, label });
    assert.match(f.cause instanceof Error ? f.cause.message : String(f.cause), new RegExp(`^${kind} alternative \\d+ `), label);
    t.diagnostic(`${label}: failed on case ${f.caseIndex + 1}`);
  }
});

/** KIND_ALTERNATIVES with the lookahead on `words` in front of a `kind` alternative on `to` instead. */
function mutant(kind: PushbackKind, words: string, to: string): Alternatives {
  const from = String.raw`(?=\b(?:${words})\b)`;
  let n = 0;
  const alts = KIND_ALTERNATIVES.map(([k, parts]) => [k, parts.map((p) => {
    if (k !== kind || !p.startsWith(from)) return p;
    n++;
    return String.raw`(?=\b(?:${to})\b)` + p.slice(from.length);
  })] as const);
  assert.equal(n, 1, `one ${kind} alternative opens with ${from}`);
  return alts;
}

/** The PropertyFailure forAll throws; fails when it throws none. */
async function failure(g: Gen<string>, prop: (text: string) => void, opts: ForAllOptions): Promise<PropertyFailure> {
  try {
    await forAll(g, prop, opts);
  } catch (e) {
    if (e instanceof PropertyFailure) return e;
    throw e;
  }
  assert.fail(`${opts.label ?? "the property"} passed`);
}
