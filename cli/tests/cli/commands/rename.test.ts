import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readProjectFile } from "../../../src/core/project/index.js";
import { trustProject } from "../../../src/core/trust.js";
import { rename } from "../../../src/cli/commands/rename.js";

let dir: string;
let file: string;
let printed: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-rename-"));
  process.env["WISP_HOME"] = join(dir, "home");
  const project = join(dir, "acme");
  await mkdir(project, { recursive: true });
  file = join(project, ".wisp.json");
  await writeFile(
    file,
    JSON.stringify({
      name: "Acme",
      pipelines: [
        { label: "Database", steps: [{ run: "postgres" }] },
        { label: "Dev", steps: [{ pipeline: "Database", label: "db" }, { run: "pnpm dev", after: "db" }] },
      ],
    }),
  );
  await trustProject(file);
  vi.spyOn(process, "cwd").mockReturnValue(project);
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.join(" ")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("wisp rename", () => {
  it("renames a pipeline and every step that runs it, and asks for trust again", async () => {
    await rename.run(["database", "Postgres"], {});
    const written = JSON.parse(await readFile(file, "utf8")) as { pipelines: { label: string; steps: Record<string, unknown>[] }[] };
    expect(written.pipelines.map((pipeline) => pipeline.label)).toEqual(["Postgres", "Dev"]);
    expect(written.pipelines[1]?.steps[0]).toEqual({ pipeline: "Postgres", label: "db" });
    expect((await readProjectFile(file)).trust).not.toBe("trusted");
    expect(printed.join("\n")).toContain("wisp trust");
  });

  it("takes the workspace first, from any folder, and prints JSON for a script", async () => {
    await rename.run([file, "dev", "Dev stack"], { json: true });
    expect(JSON.parse(printed.join("\n"))).toMatchObject({ from: "Dev", to: "Dev stack" });
  });

  it("refuses without a new name, and when the pipeline isn't there", async () => {
    await expect(rename.run(["database"], {})).rejects.toThrow(/Say which pipeline, then its new name/);
    await expect(rename.run(["deploy", "Ship"], {})).rejects.toThrow(/no pipeline called "deploy"/);
  });
});
