import type { CommandDef } from "../lib/define.js";
import { SPEC } from "../spec.js";

export const spec: CommandDef = {
  name: "spec",
  // `agents`, and `wisp help agents`: the names an AI agent looks for (the AGENTS-CLI idea).
  aliases: ["agents"],
  summary: "For AI agents: the full reference to the file format, every command and how to use them",
  examples: ["wisp help agents", "wisp spec > WISP.md"],

  async run() {
    process.stdout.write(SPEC);
  },
};
