import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { withImplicitUse } from "../../src/cli/lib/argv.js";
import { COMMANDS, verbs } from "../../src/cli/lib/commands.js";
import { fail, register, usageErrorJson } from "../../src/cli/lib/define.js";
import { WispError } from "../../src/core/errors.js";
import { COMMAND_WORDS, shortest } from "../../src/cli/lib/render.js";
import { SPEC } from "../../src/cli/spec.js";
import { VERSION } from "../../src/cli/version.js";

const argv = (...args: string[]) => ["node", "wisp", ...args];

describe("withImplicitUse", () => {
  const commands = verbs();

  it("reads an unknown first word as a pipeline", () => {
    expect(withImplicitUse(argv("api"), commands)).toEqual(argv("use", "api"));
    expect(withImplicitUse(argv("api", "--dry-run"), commands)).toEqual(argv("use", "api", "--dry-run"));
  });

  it("reads `wisp help agents` as the reference for agents, not help about a command", () => {
    expect(withImplicitUse(argv("help", "agents"), commands)).toEqual(argv("spec"));
    expect(withImplicitUse(argv("agents"), commands)).toEqual(argv("agents"));
    expect(withImplicitUse(argv("help", "use"), commands)).toEqual(argv("use", "--help"));
  });

  it("reads a bare `wisp help` as the help", () => {
    expect(withImplicitUse(argv("help"), commands)).toEqual(argv("--help"));
  });

  it("reads `wisp help all` as the help with every command", () => {
    expect(withImplicitUse(argv("help", "all"), commands)).toEqual(argv("--help"));
  });

  it("reads bare `wisp --json` as `wisp status --json`", () => {
    expect(withImplicitUse(argv("--json"), commands)).toEqual(argv("status", "--json"));
    expect(withImplicitUse(argv("list", "--json"), commands)).toEqual(argv("list", "--json"));
  });

    it("leaves commands, flags and bare wisp alone", () => {
    expect(withImplicitUse(argv("list"), commands)).toEqual(argv("list"));
    expect(withImplicitUse(argv("--help"), commands)).toEqual(argv("--help"));
    expect(withImplicitUse(argv(), commands)).toEqual(argv());
  });
});

describe("wisp --help", () => {
  const help = (showAll: boolean) => {
    const program = new Command("wisp");
    for (const command of COMMANDS) register(program, command, showAll);
    return program.helpInformation();
  };

  it("keeps the setup commands out of the everyday help", () => {
    expect(help(false)).toContain("history");
    expect(help(false)).not.toContain("open-with");
    expect(help(false)).not.toContain("Setup:");
  });

  it("lists them under Setup with `wisp help all`", () => {
    expect(help(true)).toContain("Setup:");
    expect(help(true)).toContain("open-with");
    expect(help(true)).toContain("completion");
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
    const pipelines = ["Work on core", "Work on the app", "Work on the CLI"].map((label) => ({ id: label, label, steps: [] }));
    expect(shortest(pipelines[0]!, pipelines)).toBe("core");
    expect(shortest(pipelines[2]!, pipelines)).toBe("cli");
  });

  it("counts only whole words as a clash, and falls back to the slug", () => {
    const pipelines = ["Documentation", "Docs", "Work on api", "Work on api again"].map((label) => ({ id: label, label, steps: [] }));
    expect(shortest(pipelines[1]!, pipelines)).toBe("docs");
    expect(shortest(pipelines[2]!, pipelines)).toBe("work-on-api");
  });

  it("suggests a pipeline's own slug first", () => {
    const pipelines = [{ id: "a", label: "Start the whole stack", slug: "up", steps: [] }, { id: "b", label: "Check", slug: "check", steps: [] }];
    expect(shortest(pipelines[0]!, pipelines)).toBe("up");
    expect(shortest(pipelines[1]!, pipelines, true)).toBe("use check");
  });

  it("never suggests a command's name to type on its own", () => {
    const pipelines = ["Check", "Run the checks", "Work on api"].map((label) => ({ id: label, label, steps: [] }));
    expect(shortest(pipelines[0]!, pipelines, true)).toBe("use check");
    expect(shortest(pipelines[0]!, pipelines)).toBe("check");
    expect(shortest(pipelines[1]!, pipelines, true)).toBe("checks");
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
        error: { code: "NO_PIPELINE", message: "No pipeline called nope", hint: "`wisp show` lists the pipelines, `wisp pick` chooses one." },
      });
    } finally {
      process.argv = before;
      log.mockRestore();
      exit.mockRestore();
    }
  });
});

describe("usage errors under --json", () => {
  it("become a JSON failure with the parser's message on one line", () => {
    expect(JSON.parse(usageErrorJson("error: unknown option '--inptu'\n(Did you mean --input?)\n"))).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "unknown option '--inptu' (Did you mean --input?)", hint: "`wisp <command> --help` lists what it takes." },
    });
  });
});
