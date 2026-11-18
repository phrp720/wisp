import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addBolt,
  addStep,
  boltSteps,
  buildStep,
  createPersonalWorkspace,
  describeRawStep,
  moveBolt,
  moveStep,
  removeBolt,
  removeStep,
  renameBolt,
  replaceStep,
  setJob,
  stepValues,
} from "./edit.js";
import { LOCAL_FILE, PROJECT_FILE, readProjectFile } from "./project.js";
import { trustProject } from "./trust.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-edit-")));
  process.env["WISP_HOME"] = join(dir, "home");
  file = join(dir, PROJECT_FILE);
  await writeFile(file, JSON.stringify({ name: "Shop", bolts: [{ label: "Work on api", color: "#4a9dff", targets: [{ folder: "apps/api" }] }] }));
});

afterEach(async () => {
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("editing a workspace without writing JSON", () => {
  it("adds bolts and steps, and writes a file a person can read", async () => {
    await addBolt(file, "Check", { job: true });
    const { step } = buildStep("run", { run: "pnpm test", label: "", cwd: "" });
    await addStep(file, "check", step!);
    await addStep(file, "Work on api", buildStep("wait", { wait: "http://localhost:3000" }).step!);

    const text = await readFile(file, "utf8");
    expect(text).toMatch(/"label": "Check",\n {6}"color": "#[0-9a-f]{6}",\n {6}"job": true,\n {6}"targets": \[\n {8}\{ "run": "pnpm test" \}\n {6}\]/);
    const read = await readProjectFile(file);
    expect(read.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
    expect(read.workspace.bolts.map((bolt) => [bolt.label, bolt.steps.length])).toEqual([
      ["Work on api", 2],
      ["Check", 1],
    ]);
  });

  it("gives each new bolt a colour none of the others has", async () => {
    for (const name of ["One", "Two", "Three", "Four"]) await addBolt(file, name);
    const raw = JSON.parse(await readFile(file, "utf8")) as { bolts: { color?: string }[] };
    const colors = raw.bolts.map((bolt) => bolt.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("keeps what it does not know about, like a colour", async () => {
    await addStep(file, "work on api", buildStep("url", { url: "localhost:3000" }).step!);
    expect(await readFile(file, "utf8")).toContain('"color": "#4a9dff"');
  });

  it("checks a form's values and says what is wrong, per field", () => {
    expect(buildStep("run", { run: "" }).errors).toEqual({ run: "Command is needed" });
    expect(buildStep("wait", { wait: "soon" }).errors["wait"]).toMatch(/try http/);
    expect(buildStep("wait", { wait: "5" }).step).toEqual({ wait: 5 });
    expect(buildStep("compose", { compose: "compose.yaml", services: "db, cache" }).step).toEqual({ compose: "compose.yaml", services: ["db", "cache"] });
    expect(buildStep("run", { run: "pnpm dev", label: "api", cwd: "apps/api" }).step).toEqual({ run: "pnpm dev", cwd: "apps/api", label: "api" });
  });

  it("edits, moves and removes steps", async () => {
    await addStep(file, "Work on api", { run: "pnpm dev" });
    await addStep(file, "Work on api", { url: "localhost:3000" });
    await moveStep(file, "Work on api", 2, -1);
    expect((await boltSteps(file, "Work on api")).map(describeRawStep)).toEqual(["open the apps/api folder", "open localhost:3000", "run pnpm dev"]);

    await replaceStep(file, "Work on api", 2, { run: "pnpm dev --turbo", cwd: "apps/api" });
    await removeStep(file, "Work on api", 0);
    expect((await boltSteps(file, "Work on api")).map(describeRawStep)).toEqual(["open localhost:3000", "run pnpm dev --turbo in apps/api"]);
    expect(stepValues({ run: "pnpm dev --turbo", cwd: "apps/api" })).toEqual({ run: "pnpm dev --turbo", cwd: "apps/api" });
  });

  it("renames, reorders, turns into a job and deletes bolts — refusing a duplicate name", async () => {
    await addBolt(file, "Check");
    await expect(addBolt(file, "check")).rejects.toThrow(/already a bolt/);
    await renameBolt(file, "Check", "Run the tests");
    await setJob(file, "Run the tests", true);
    await moveBolt(file, "Run the tests", -1);
    let read = await readProjectFile(file);
    expect(read.workspace.bolts.map((bolt) => [bolt.label, bolt.job ?? false])).toEqual([
      ["Run the tests", true],
      ["Work on api", false],
    ]);
    await removeBolt(file, "Work on api");
    read = await readProjectFile(file);
    expect(read.workspace.bolts.map((bolt) => bolt.label)).toEqual(["Run the tests"]);
  });

  it("keeps a file trusted when the change was made here, by the person who trusted it", async () => {
    await addStep(file, "Work on api", { run: "pnpm dev" });
    await trustProject(file);
    await addStep(file, "Work on api", { run: "pnpm test" });
    expect((await readProjectFile(file)).trust).toBe("trusted");
  });

  it("does not trust a file that was not trusted before", async () => {
    await addStep(file, "Work on api", { run: "pnpm dev" });
    expect((await readProjectFile(file)).trust).toBe("untrusted");
  });

  it("edits a bolt where it is written — the local override, when it lives there", async () => {
    await writeFile(join(dir, LOCAL_FILE), JSON.stringify({ bolts: [{ label: "Mine", targets: [] }] }));
    await addStep(file, "mine", { url: "linear.app" });
    expect(JSON.parse(await readFile(join(dir, LOCAL_FILE), "utf8")).bolts[0].targets).toEqual([{ url: "linear.app" }]);
    expect(JSON.parse(await readFile(file, "utf8")).bolts).toHaveLength(1);
  });

  it("makes an empty personal workspace, with no placeholder bolt", async () => {
    const created = await createPersonalWorkspace("Morning");
    const read = await readProjectFile(created);
    expect(read.workspace).toMatchObject({ name: "Morning", personal: true, trusted: true });
    expect(read.workspace.bolts).toEqual([]);
    expect(read.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual([]);
    await expect(createPersonalWorkspace("Morning")).rejects.toThrow(/already/);
  });
});
