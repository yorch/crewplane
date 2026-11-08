const help = `Crewplane — local orchestration for coding agents

Usage: crewplane [--help | --version]

This is the extraction foundation. Agent execution is not implemented yet.
See docs/PLAN.md for the implementation sequence.
`;
const args = process.argv.slice(2);
if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
  console.log(help);
} else if (args.length === 1 && args[0] === "--version") {
  console.log("0.1.0");
} else {
  console.error("Unknown command. Run crewplane --help.");
  process.exitCode = 2;
}
