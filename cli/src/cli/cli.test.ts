import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { withImplicitUse } from "./lib/argv.js";
import { COMMANDS, verbs } from "./lib/commands.js";
import { fail } from "./lib/define.js";
import { WispError } from "../core/errors.js";
import { COMMAND_WORDS, shortest } from "./lib/render.js";
import { SPEC } from "./spec.js";
import { VERSION } from "./version.js";

const argv = (...args: string[]) => ["node", "wisp", ...args];

describe("withImplicitUse", () => {
  const commands = verbs();

  it("reads an unknown first word as a pipeline", () => {
    expect(withImplicitUse(argv("api"), commands)).toEqual(argv("use", "api"));
    expect(withImplicitUse(argv("api", "-n"), commands)).toEqual(argv("use", "api", "-n"));
  });

  it("reads `wisp help agents` as the reference for agents, not help about a command", () => {
    expect(withImplicitUse(argv("help", "agents"), commands)).toEqual(argv("spec"));
    expect(withImplicitUse(argv("agents"), commands)).toEqual(argv("agents"));
    expect(withImplicitUse(argv("help", "use"), commands)).toEqual(argv("help", "use"));
  });

    it("leaves commands, flags and bare wisp alone", () => {
    expect(withImplicitUse(argv("list"), commands)).toEqual(argv("list"));
    expect(withImplicitUse(argv("--help"), commands)).toEqual(argv("--help"));
    expect(withImplicitUse(argv(), commands)).toEqual(argv());
  });
});

describe("commands", () => {
  it("have no names that collide", () => {
    const names = COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keep the everyday list short", () => {
    expect(COMMANDS.filter((command) => command.group === "everyday").map((command) => command.name)).toEqual([
      "use",
      "pick",
      "init",
      "trust",
      "list",
    ]);
  });
});

describe("shortest", () => {
  it("suggests the last word that means something and still names one pipeline", () => {
    const shop = ["Work on storefront", "Deploy", "Back up the database"].map((label) => ({ id: label, label, steps: [] }));
    expect(shortest(shop[0]!, shop)).toBe("storefront");
    expect(shortest(shop[2]!, shop)).toBe("database");
    const bolts = ["Work on core", "Work on the app", "Work on the CLI"].map((label) => ({ id: label, label, steps: [] }));
    expect(shortest(bolts[0]!, bolts)).toBe("core");
    expect(shortest(bolts[2]!, bolts)).toBe("cli");
  });

  it("counts only whole words as a clash, and falls back to the slug", () => {
    const bolts = ["Documentation", "Docs", "Work on api", "Work on api again"].map((label) => ({ id: label, label, steps: [] }));
    expect(shortest(bolts[1]!, bolts)).toBe("docs");
    expect(shortest(bolts[2]!, bolts)).toBe("work-on-api");
  });

  it("never suggests a command's name to type on its own", () => {
    const bolts = ["Check", "Run the checks", "Work on api"].map((label) => ({ id: label, label, steps: [] }));
    expect(shortest(bolts[0]!, bolts, true)).toBe("use check");
    expect(shortest(bolts[0]!, bolts)).toBe("check");
    expect(shortest(bolts[1]!, bolts, true)).toBe("checks");
  });

  it("knows every word that names a command", () => {
    expect([...COMMAND_WORDS].sort()).toEqual([...verbs()].sort());
  });
});

describe("version", () => {
  it("matches package.json, since a compiled binary cannot read it", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(manifest.version);
  });
});

describe("spec", () => {
  it("is what docs/SPEC.md says — regenerate it with `pnpm spec`", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(await readFile(join(root, "..", "docs", "SPEC.md"), "utf8")).toBe(SPEC);
  });

  it("mentions every command", () => {
    for (const command of COMMANDS.filter((entry) => entry.name !== "use" && entry.name !== "open-with")) {
      expect(SPEC).toContain(`wisp ${command.name}`);
    }
  });
});

describe("failing", () => {
  it("says so in JSON when JSON was asked for, with the code and what to try", () => {
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
    const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const before = process.argv;
    process.argv = ["node", "wisp", "nope", "--json"];
    try {
      expect(() => fail(new WispError("No pipeline called nope", "NO_PIPELINE"))).toThrow("exit 1");
      expect(JSON.parse(printed.join("\n"))).toEqual({
        ok: false,
        error: { code: "NO_PIPELINE", message: "No pipeline called nope", hint: "`wisp show [workspace]` lists the pipelines, `wisp pick [workspace]` chooses one." },
      });
    } finally {
      process.argv = before;
      log.mockRestore();
      exit.mockRestore();
    }
  });
});
