// Loaded into every test file's process by test-ci.mjs (--import). With --test-force-exit a test
// file calls process.exit() as soon as its tests are done, and on Linux and macOS the end of its
// report can still be queued in its stdout pipe: the tests ran, but their results never reach the
// run's report or its totals (nodejs/node issue 64833). A blocking pipe has nothing queued at exit.
// Node already makes this pipe blocking on Windows. Only test file processes have NODE_TEST_CONTEXT;
// the processes a test launches do not load this file.
if (process.env.NODE_TEST_CONTEXT) process.stdout._handle?.setBlocking?.(true);
