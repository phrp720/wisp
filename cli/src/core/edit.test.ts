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
  removePersonalWorkspace,
  removeStep,
  renameBolt,
  replaceStep,
  setBoltNotes,
  setJob,
  setWorkspaceDetails,
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

  it("writes a bolt's notes right after its label, and drops them when cleared", async () => {
    await setBoltNotes(file, "Work on api", "  The API with its database  ");
    expect(Object.keys(JSON.parse(await readFile(file, "utf8")).bolts[0])).toEqual(["label", "notes", "color", "targets"]);
    expect((await readProjectFile(file)).workspace.bolts[0]?.notes).toBe("The API with its database");
    await setBoltNotes(file, "Work on api", "");
    expect(JSON.parse(await readFile(file, "utf8")).bolts[0]).not.toHaveProperty("notes");
    expect((await readProjectFile(file)).workspace.bolts[0]?.notes).toBeUndefined();
  });

  it("says a wait in plain words: seconds, a port, an address", () => {
    expect([{ wait: 3 }, { wait: "localhost:5432" }, { wait: "http://localhost:3000" }].map(describeRawStep)).toEqual(["wait 3s", "wait for localhost:5432", "wait for http://localhost:3000"]);
  });

  it("renames a workspace, sets its icon and notes, and drops one left empty", async () => {
    await setWorkspaceDetails(file, { name: "Shop Labs", icon: "🛒", notes: "The storefront" });
    let raw = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(raw).slice(0, 3)).toEqual(["name", "icon", "notes"]);
    expect((await readProjectFile(file)).workspace).toMatchObject({ name: "Shop Labs", icon: "🛒", notes: "The storefront" });
    await setWorkspaceDetails(file, { name: "Shop Labs", icon: "", notes: "The storefront" });
    raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw).not.toHaveProperty("icon");
    await expect(setWorkspaceDetails(file, { name: "  ", icon: "", notes: "" })).rejects.toThrow(/needs a name/);
  });

  it("leaves a name taken from the folder alone when it did not change", async () => {
    await writeFile(file, JSON.stringify({ bolts: [] }));
    const named = (await readProjectFile(file)).workspace.name;
    await setWorkspaceDetails(file, { name: named, icon: "", notes: "Mine" });
    expect(JSON.parse(await readFile(file, "utf8"))).not.toHaveProperty("name");
    expect((await readProjectFile(file)).workspace).toMatchObject({ name: named, notes: "Mine" });
  });

  it("renames a workspace where its name is set: the local override, when it sets one, keeping trust", async () => {
    await writeFile(join(dir, LOCAL_FILE), JSON.stringify({ name: "My Shop" }));
    await trustProject(file);
    await setWorkspaceDetails(file, { name: "Our Shop", icon: "", notes: "Shared notes" });
    expect(JSON.parse(await readFile(join(dir, LOCAL_FILE), "utf8")).name).toBe("Our Shop");
    const main = JSON.parse(await readFile(file, "utf8"));
    expect(main.name).toBe("Shop");
    expect(main.notes).toBe("Shared notes");
    const read = await readProjectFile(file);
    expect(read.workspace.name).toBe("Our Shop");
    expect(read.trust).toBe("trusted");
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

  it("deletes your own workspaces, and never a project's file", async () => {
    const created = await createPersonalWorkspace("Notes");
    await removePersonalWorkspace(created);
    await expect(readFile(created, "utf8")).rejects.toThrow();
    await expect(removePersonalWorkspace(file)).rejects.toThrow(/Only your own workspaces/);
    expect(await readFile(file, "utf8")).toContain("bolts");
  });
});
