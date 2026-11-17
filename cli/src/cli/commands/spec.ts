import type { CommandDef } from "../lib/define.js";
import { SPEC } from "../spec.js";

export const spec: CommandDef = {
  name: "spec",
  summary: "Print the full reference: the file format, every command, and how an agent should use them",
  examples: ["wisp spec", "wisp spec > WISP.md"],

  async run() {
    process.stdout.write(SPEC);
  },
};
