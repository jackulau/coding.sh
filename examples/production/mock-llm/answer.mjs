#!/usr/bin/env node
// Experiment task for J6 (docs/PRODUCTION.md §7): reads the case input on stdin
// and prints "pong", the mock LLM's answer, so a `contains "pong"` grader passes.
if (!process.stdin.isTTY) {
  for await (const _ of process.stdin);
}
console.log("pong");
