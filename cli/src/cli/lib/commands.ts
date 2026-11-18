import { check } from "../commands/check.js";
import { doctor } from "../commands/doctor.js";
import { init } from "../commands/init.js";
import { down, history, hook, restart } from "../commands/lifecycle.js";
import { list } from "../commands/list.js";
import { logs, ps, stop } from "../commands/processes.js";
import { scan } from "../commands/scan.js";
import { openWith } from "../commands/settings.js";
import { show } from "../commands/show.js";
import { spec } from "../commands/spec.js";
import { trust } from "../commands/trust.js";
import { use } from "../commands/use.js";
import type { CommandDef } from "./define.js";

/**
 * Every command, in the order `--help` lists them. Four are everyday; the rest are there
 * when you need them and out of the way when you do not.
 */
export const COMMANDS: CommandDef<never>[] = [
  { ...use, group: "everyday" },
  { ...init, group: "everyday" },
  { ...trust, group: "everyday" },
  { ...list, group: "everyday" },
  down,
  restart,
  history,
  show,
  check,
  hook,
  ps,
  logs,
  stop,
  scan,
  openWith,
  doctor,
  spec,
] as CommandDef<never>[];

/** Every word that means a command, aliases included — what `wisp <word>` must not shadow. */
export function verbs(commands: CommandDef<never>[] = COMMANDS): Set<string> {
  const names = new Set<string>(["help", "status"]);
  for (const command of commands) {
    names.add(command.name);
    for (const alias of command.aliases ?? []) names.add(alias);
  }
  return names;
}
