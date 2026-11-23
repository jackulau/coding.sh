// Follow-up prompts that push back (core/pushback.ts): isPushback, the broad test the MCP failures
// tool and the eval candidates use, and pushbackKind, the narrow one the model scorecard counts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isPushback, PUSHBACK_KINDS, pushbackKind, type PushbackKind } from "../../src/core/pushback.ts";

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
    ]) {
      assert.equal(pushbackKind(t), undefined, t);
    }
  });

  test("leaves out a feature, a condition, a check or a question that uses the same words", () => {
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
    ]) {
      assert.equal(pushbackKind(t), undefined, t);
    }
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
});
