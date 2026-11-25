// Follow-up prompts that push back (core/pushback.ts): isPushback, the broad test the MCP failures
// tool and the eval candidates use, and pushbackKind, the narrow one the model scorecard counts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isPushback, KIND_ALTERNATIVES, PUSHBACK_KINDS, pushbackKind, type PushbackKind } from "../../src/core/pushback.ts";

describe("isPushback", () => {
  test("keeps its broad reading: any prompt that opens with no, wait, stop or actually", () => {
    for (const t of ["no problem", "No, that's fine", "wait for the build", "stop the server", "actually, also add a test", "don't forget the docs", "Why did you delete it?", "you forgot the docs", "wrong"]) {
      assert.equal(isPushback(t), true, t);
    }
    for (const t of ["that's wrong", "you broke the build", "it didn't work", "please try again", "please revert it", "undo that"]) {
      assert.equal(isPushback(`Thanks. ${t}`), true, t);
    }
    for (const t of ["add a test for the parser", "Can you add an undo button?", "write a retry loop", "looks good, ship it", ""]) {
      assert.equal(isPushback(t), false, t);
    }
    // It reads the first 400 characters only.
    assert.equal(isPushback(`${"a".repeat(400)} you broke it`), false);
  });
});

describe("pushbackKind", () => {
  const cases: Record<PushbackKind, string[]> = {
    intent: [
      "That's not what I asked for",
      "no, that's not what I meant",
      "Not what I wanted.",
      "You misunderstood the task",
      "Actually I meant the other config file",
      "I meant the login page, not the signup page",
      "I didn't ask you to change the tests",
      "I never said to delete it",
      "you edited the wrong file",
      "Wrong file, it's src/a.ts",
      "that's not it",
      "you misinterpreted the task",
      "This is not what I want",
      "that's not what I'm asking for",
      "That's wrong",
      "No, that's wrong. The function should return null.",
      "That's not right",
      "no that's not correct",
      "I asked for a bar chart, not a pie chart",
      "I wanted a bar chart, not a pie chart",
      "You did the opposite of what I asked",
      "You weren't supposed to touch the tests",
      "Not that one, the other one",
    ],
    undo: [
      "undo that",
      "Undo",
      "please revert",
      "Revert your changes",
      "can you revert the last commit",
      "roll back the migration you added",
      "go back to the previous version",
      "remove that",
      "Remove those.",
      "put it back",
      "put the old test back",
      "change it back",
      "Remove what you added to main.ts",
      "restore the original",
      "I want it back to how it was",
      "undo the rename",
      "revert that, it broke prod",
      "Roll back the prod deploy, your change broke checkout",
      "Take that out",
      "Get rid of what you just added",
      "Delete what you just wrote",
      "Remove the changes you made to utils.ts",
      "Revert the changes on login.ts",
      "Put it back if you can",
      "Undo that if you can",
    ],
    redo: [
      "try again",
      "ok, try again with the debug flag",
      "Can you try again?",
      "hmm, that is odd. Try it again",
      "redo it",
      "Redo the whole thing",
      "let's start over",
      "start from scratch please",
      "I don't like it",
      "I don't like the naming, rename them",
      "give it another try",
      "no, start from scratch on the parser",
      "I don't like it because it's slow",
      "Retry",
      "Please retry",
      "Do it again but with tabs",
      "Don't like it",
    ],
    broken: [
      "it's still broken",
      "still failing",
      "The tests are still failing on CI",
      "that didn't work",
      "That didn't fix it",
      "you broke the build",
      "Your change broke the login page",
      "it doesn't work",
      "it's not working",
      "I still get the same error",
      "Same error as before",
      "still not working",
      "it fails again",
      "you made it worse",
      "Nothing changed.",
      "Doesn't work",
      "nope, not working",
      "Now the tests fail",
      "Tests are failing now",
      "Now it crashes on startup",
      "build broke",
      "The tests broke",
      "Getting a 500 now",
      "the page is blank now",
      "It's worse now",
      "you made the error message worse",
      "Same issue",
      "Same problem",
      "Still the same error",
      "Nothing happened",
    ],
  };
  for (const kind of PUSHBACK_KINDS) {
    test(`reads ${kind}`, () => {
      for (const t of cases[kind]) assert.equal(pushbackKind(t), kind, t);
    });
  }

  test("names one kind per prompt, the first of intent, undo, redo, broken", () => {
    assert.equal(pushbackKind("no, that's not what I meant, undo it"), "intent");
    assert.equal(pushbackKind("undo that, it's still broken"), "undo");
    assert.equal(pushbackKind("still failing, try again"), "redo");
  });

  test("leaves out what reads as pushback only by its first word", () => {
    for (const t of [
      "no problem",
      "no worries, take your time",
      "No, that's fine",
      "no, go ahead",
      "nope, looks good",
      "don't forget to also update the docs",
      "Don't worry about the tests",
      "stop the server and run the tests",
      "wait for the build",
      "actually, also add a test",
      "wrong",
      "No, use the existing helper instead",
    ]) {
      assert.equal(pushbackKind(t), undefined, t);
    }
  });

  test("leaves out a feature, a condition, a check, a question or praise that uses the same words", () => {
    for (const t of [
      "Can you add an undo button to the toolbar?",
      "Add a revert command to the CLI",
      "write a retry loop that will try again on failure",
      "If the request fails, try again",
      "I don't like it when tests are slow",
      "Can you remove this file?",
      "There's an unused import in foo.ts, can you remove it?",
      "If that doesn't work, use the fallback",
      "if it didn't work, print the log",
      "Make sure the test still fails without the fix",
      "check if you broke anything",
      "make sure the tests still pass",
      "Is it still failing?",
      "Use the same error handling as in bar.ts",
      "fix the wrong file path in config",
      "I meant to ask, can you also add a test?",
      "I didn't work on that part, it's new",
      "Put the tests in a separate file",
      "Restore the database from the backup",
      "Add a button to go back to the previous step",
      "Add a start over button to the wizard",
      "Nice, you broke it into smaller functions",
      "Great, you broke it down nicely",
      "Make the handler return the same error as v1",
      "Same error handling as bar.ts, please",
      "I don't like this library, but we must use it. Wrap it.",
      "Nothing changed in the API, so skip the docs",
      "Sort the list by date, then reverse it so the newest is first",
      "Reverse this array before printing it",
      "If the job fails, put it back on the queue",
      "When a worker crashes, put the message back in the queue",
      "After the test, set it back to the default",
      "Turn it back on after the migration finishes",
      "On failure, restore the original config",
      "Add a function to restore the previous state on error",
      "Restore it from the backup in S3",
      "Restore it on startup",
      "Make sure each test puts the env back to how it was",
      "Rollback the transaction on error",
      "Roll back the transaction if the insert fails",
      "Revert the state if the write fails",
      "Undo is broken in the editor, can you fix it?",
      "Undo and redo shortcuts are swapped in the editor",
      "Undo/redo works now, thanks",
      "Rollback fails on Postgres when a trigger exists",
      "Revert commits should keep the original author",
      "Redo should be ctrl+shift+z on Linux",
      "Try again later if the registry is down",
      "Ran the formatter, nothing changed.",
      "Snapshots pass and nothing changed, great",
      "I reran the benchmark and nothing changed, so the refactor is safe. Now add docs",
      "Nothing changed, as expected",
      "Now the tests fail as expected, implement the fix",
      "Getting a 200 now",
      "I said thanks, no more changes needed",
      "ok I said I'd review it later, go ahead and open the PR",
      "I wanted to add a test, not a big deal",
      "That's not right now, maybe next week",
      "Not this one yet, start with the parser",
      "That's wrong?",
      "Why did you remove that?",
      "Did you remove that?",
    ]) {
      assert.equal(pushbackKind(t), undefined, t);
    }
  });

  test("leaves out work the prompt places outside the agent's last turn", () => {
    for (const t of [
      "Roll back the prod deploy to v1.2",
      "Revert commit abc123 on the release branch",
      "Undo the last migration in prod, it was mine",
      "Undo my last commit, I pushed it by mistake",
      "Start from scratch on the README, it is out of date",
      "The upstream API still fails on 429s; add a retry",
      "The tests are still failing on main from before your change; investigate",
      "Same error as the one in issue #12: add a regression test",
      "It doesn't work offline yet: add offline support",
      "I didn't change anything in that file, so the diff is yours",
      "I didn't fix the lint myself, can you?",
      "Please revert the changes in upstream/main",
      "Roll back the database to yesterday's snapshot",
      "Undo the changes the linter made",
      "Revert Bob's change to the config",
      "Revert the change from last week that broke login",
      "CI is still red because of the flaky test, ignore it and continue",
      "The old parser still fails on empty input, add a test for that",
      "Lint still fails, but that's the old config. Move on.",
      "the API returns 500 still failing for the vendor endpoint, add retries",
    ]) {
      assert.equal(pushbackKind(t), undefined, t);
    }
    // The same words count when the prompt says the agent made it.
    assert.equal(pushbackKind("roll back the migration you added"), "undo");
    assert.equal(pushbackKind("Revert the deploy you just did"), "undo");
  });

  test("reads a curly apostrophe as a straight one", () => {
    assert.equal(pushbackKind("that didn’t work"), "broken");
    assert.equal(pushbackKind("I don’t like it"), "redo");
  });

  test("reads the first 400 characters, and nothing for an empty prompt", () => {
    assert.equal(pushbackKind(`${"a ".repeat(200)} you broke it`), undefined);
    assert.equal(pushbackKind("   "), undefined);
    assert.equal(pushbackKind(""), undefined);
  });

  test("looks for an alternative's first word before it reads back", () => {
    // A lookbehind that opens an alternative runs at every position of the prompt. The lookahead on
    // the first word in front of it changes no kind: test/verify/pushback-prop.test.ts checks that.
    for (const [kind, parts] of KIND_ALTERNATIVES) {
      for (const p of parts) assert.doesNotMatch(p, /^\(\?<[=!]/, `${kind}: ${p.slice(0, 80)}`);
    }
  });
});
