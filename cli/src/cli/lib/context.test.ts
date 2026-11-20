import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordProject } from "../../core/config.js";
import { pick } from "../commands/pick.js";
import { use } from "../commands/use.js";
import { resolveRun } from "./context.js";

let dir: string;
let wisp: string;
let mira: string;
let outside: string;
let printed: string[];

async function project(name: string, body: Record<string, unknown>): Promise<string> {
  const folder = join(dir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, ".wisp.json"), JSON.stringify(body));
  return folder;
}

function standIn(folder: string): void {
  vi.spyOn(process, "cwd").mockReturnValue(folder);
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-context-")));
  process.env["WISP_HOME"] = join(dir, "home");
  wisp = await project("wisp", {
    name: "Wisp",
    bolts: [
      { label: "Work on the CLI", notes: "The CLI in watch mode", targets: [{ url: "localhost:3000" }] },
      { label: "Documentation", targets: [{ url: "localhost:5173" }] },
      { label: "Document", targets: [{ url: "localhost:5174" }] },
    ],
  });
  mira = await project("mira", { name: "Mira", bolts: [{ label: "Deploy", targets: [{ label: "Site", url: "https://mira.example" }] }] });
  outside = join(dir, "elsewhere");
  await mkdir(outside, { recursive: true });
  await recordProject(join(wisp, ".wisp.json"));
  await recordProject(join(mira, ".wisp.json"));
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("one word", () => {
  it("is a bolt of the project you are in, by a whole word, its slug or its name", async () => {
    standIn(wisp);
    expect((await resolveRun("cli", undefined, undefined)).bolt).toBe("cli");
    expect((await resolveRun("work-on-the-cli", undefined, undefined)).read.workspace.name).toBe("Wisp");
    expect((await resolveRun("document", undefined, undefined)).bolt).toBe("document");
  });

  it("is never part of a word, and says which it might have meant", async () => {
    standIn(wisp);
    const refused = resolveRun("doc", undefined, undefined);
    await expect(refused).rejects.toMatchObject({ code: "NO_BOLT" });
    await expect(refused).rejects.toThrow("Wisp has no bolt called \"doc\". Did you mean `wisp documentation`, `wisp document`?");
  });

  it("never runs another project's bolt, and says how to", async () => {
    standIn(wisp);
    const refused = resolveRun("deploy", undefined, undefined);
    await expect(refused).rejects.toMatchObject({ code: "NO_BOLT" });
    await expect(refused).rejects.toThrow("Wisp has no bolt called \"deploy\". Elsewhere: `wisp mira deploy`.");
  });

  it("is not a workspace: naming one says how to see its bolts", async () => {
    standIn(wisp);
    await expect(resolveRun("mira", undefined, undefined)).rejects.toThrow("Mira is a workspace: `wisp show mira` lists its bolts, `wisp pick mira` picks one.");
  });

  it("outside a project, runs nothing", async () => {
    standIn(outside);
    await expect(resolveRun("deploy", undefined, undefined)).rejects.toThrow("\"deploy\" is not a bolt here: this folder has no .wisp.json. Elsewhere: `wisp mira deploy`.");
  });
});

describe("two words", () => {
  it("are a workspace and its bolt, from anywhere", async () => {
    standIn(outside);
    const { read, bolt } = await resolveRun("mira", "deploy", undefined);
    expect(read.workspace.name).toBe("Mira");
    expect(bolt).toBe("deploy");
  });
});

describe("wisp use with no bolt", () => {
  it("refuses and lists what to type", async () => {
    standIn(wisp);
    await expect(use.run([], {})).rejects.toThrow("Name a bolt of Wisp: `wisp work-on-the-cli`, `wisp documentation`, `wisp document`");
  });
});

describe("wisp pick without a terminal", () => {
  it("asks nothing and prints the bolts it would offer, with their slugs and notes", async () => {
    standIn(outside);
    await pick.run(["wisp"], { json: true });
    const shown = JSON.parse(printed.join("\n")) as { name: string; bolts: { label: string; slug: string; notes?: string }[] };
    expect(shown.name).toBe("Wisp");
    expect(shown.bolts.map((bolt) => [bolt.slug, bolt.notes ?? ""])).toEqual([
      ["work-on-the-cli", "The CLI in watch mode"],
      ["documentation", ""],
      ["document", ""],
    ]);
  });

  it("lists the workspaces when it is not in one and none was named", async () => {
    standIn(outside);
    await pick.run([], { json: true });
    const listed = JSON.parse(printed.join("\n")) as { name: string }[];
    expect(listed.map((entry) => entry.name).sort()).toEqual(["Mira", "Wisp"]);
  });
});
