/**
 * `wisp api` means `wisp use api`.
 *
 * Running a bolt is the thing people do daily, and making them say so every time is a
 * word of ceremony on the one command that gets typed most. Anything that is a command
 * stays a command — the check is against the registered names, not a guess — so the
 * grammar only widens where it was previously an error.
 *
 * A bolt sharing a name with a command is still reachable as `wisp use list`.
 */
export function withImplicitUse(argv: string[], commands: Set<string>): string[] {
  const first = argv[2];
  if (!first || first.startsWith("-") || commands.has(first)) return argv;
  return [...argv.slice(0, 2), "use", ...argv.slice(2)];
}
