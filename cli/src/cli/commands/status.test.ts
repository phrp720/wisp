import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { status } from "./status.js";

let dir: string;
let printed: string[];
let cwd: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-status-"));
  process.env["WISP_HOME"] = join(dir, "home");
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
  cwd = process.cwd();
  process.chdir(dir);
});

afterEach(async () => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("wisp status --json", () => {
  it("prints the project here and every workspace", async () => {
    await writeFile(join(dir, ".wisp.json"), JSON.stringify({ name: "Shop", pipelines: [{ label: "Check", slug: "check", steps: [{ link: "https://example.com" }] }] }));
    await status({ json: true });
    const result = JSON.parse(printed.join("\n")) as { project: { name: string; pipelines: { slug: string }[] }; workspaces: { name: string }[] };
    expect(result.project.name).toBe("Shop");
    expect(result.project.pipelines.map((pipeline) => pipeline.slug)).toEqual(["check"]);
    expect(result.workspaces.map((workspace) => workspace.name)).toContain("Shop");
  });

  it("says there is no project here with null", async () => {
    await status({ json: true });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ project: null });
  });
});

describe("wisp status", () => {
  it("says the file had problems rather than that it has no pipelines yet", async () => {
    await writeFile(join(dir, ".wisp.json"), JSON.stringify({ name: "Shop", bolts: [{ label: "Check", steps: [] }] }));
    await status();
    const text = printed.join("\n");
    expect(text).toContain("No pipelines read from this file");
    expect(text).not.toContain("yet");
  });

  it("counts steps that wait for trust as waiting, not as none", async () => {
    await writeFile(join(dir, ".wisp.json"), JSON.stringify({ name: "Shop", pipelines: [{ label: "Check", steps: [{ run: "pnpm test" }] }] }));
    await status();
    const text = printed.join("\n");
    expect(text).toContain("1 step waiting for trust");
    expect(text).not.toContain("0 steps");
  });
});
