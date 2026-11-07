// A tiny "agent" in another process: case input JSON on stdin, output JSON on stdout.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  if (input.crash) {
    process.stderr.write("agent crashed\n");
    process.exit(3);
  }
  if (input.text) {
    process.stdout.write(`plain ${input.q}\n`);
    return;
  }
  process.stdout.write(
    JSON.stringify({
      answer: String(input.q).toUpperCase(),
      caseId: process.env.CODING_SH_CASE_ID,
      runId: process.env.CODING_SH_RUN_ID,
      trial: process.env.CODING_SH_TRIAL,
    }),
  );
});
