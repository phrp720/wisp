/**
 * `wisp api` means `wisp use api`.
 *
 * Running a pipeline is the thing people do daily, and making them say so every time is a
 * word of ceremony on the one command that gets typed most. Anything that is a command
 * stays a command — the check is against the registered names, not a guess — so the
 * grammar only widens where it was previously an error.
 *
 * A pipeline sharing a name with a command is still reachable as `wisp use list`.
 */
export function withImplicitUse(argv: string[], commands: Set<string>): string[] {
  // `wisp help agents` is the reference itself, not help about a command called agents.
  if (argv[2] === "help" && argv[3] === "agents") return [...argv.slice(0, 2), "spec", ...argv.slice(4)];
  if (argv[2] === "help" && argv[3] === "all") return [...argv.slice(0, 2), "--help", ...argv.slice(4)];
  if (argv[2] === "help" && argv.length === 3) return [...argv.slice(0, 2), "--help"];
  if (argv[2] === "help" && argv[3] && commands.has(argv[3])) return [...argv.slice(0, 2), argv[3], "--help"];
  if (argv[2] === "--json" && argv.length === 3) return [...argv.slice(0, 2), "status", "--json"];
  const first = argv[2];
  if (!first || first.startsWith("-") || commands.has(first)) return argv;
  return [...argv.slice(0, 2), "use", ...argv.slice(2)];
}
