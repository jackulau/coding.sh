// Test scorer: reads {input, output, expected} on stdin; behavior picked by argv[2].
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const ctx = JSON.parse(raw);
  const mode = process.argv[2];
  const ok = ctx.output === ctx.expected;
  if (mode === "json") {
    process.stdout.write(JSON.stringify({ score: ok ? 1 : 0.25, pass: ok, reason: ok ? "match" : `want ${ctx.expected}` }));
  } else if (mode === "number") {
    process.stdout.write("progress line\n0.75\n");
  } else if (mode === "exit") {
    if (!ok) process.stderr.write("mismatch\n");
    process.exit(ok ? 0 : 1);
  } else if (mode === "sleep") {
    setTimeout(() => {}, 10_000);
  } else if (mode === "echo-case") {
    process.stdout.write(JSON.stringify({ pass: ctx.caseId === "c1", score: ctx.caseId === "c1" ? 1 : 0 }));
  }
});
