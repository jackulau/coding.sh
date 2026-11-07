#!/usr/bin/env node
// Fake CLI: exit 2 on an unknown flag, exit 0 on --help, a few subcommands.
const argv = process.argv.slice(2);
const KNOWN = new Set(["--json", "--name", "--help", "-h", "--version"]);
if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
  process.stdout.write(`Usage: fake-cli <command> [options]

Commands:
  greet      Say hello
  sum        Add numbers
  fail       Exit 1

Options:
  --name <NAME>   Who to greet
  --json          JSON output
  --help          Show help
`);
  process.exit(0);
}
if (argv.includes("--version")) {
  process.stdout.write("1.0.0\n");
  process.exit(0);
}
for (const a of argv) {
  if (a.startsWith("-") && !KNOWN.has(a.split("=")[0])) {
    process.stderr.write(`error: unknown option '${a}'\n`);
    process.exit(2);
  }
}
const [cmd, ...rest] = argv;
if (cmd === "greet") {
  const i = rest.indexOf("--name");
  process.stdout.write(`hello ${i >= 0 ? rest[i + 1] : "world"}\n`);
  process.exit(0);
}
if (cmd === "sum") {
  process.stdout.write(String(rest.filter((x) => !x.startsWith("-")).reduce((a, b) => a + Number(b), 0)) + "\n");
  process.exit(0);
}
if (cmd === "fail") {
  process.stderr.write("something broke\n");
  process.exit(1);
}
if (cmd === undefined) process.exit(0);
process.stderr.write(`error: unknown command '${cmd}'\n`);
process.exit(2);
