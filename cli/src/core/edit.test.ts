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
  guessFinishes,
  setBoltNotes,
  setConfirm,
  toggleTogether,
  setInput,
  removeInput,
  buildInput,
  inputValues,
  setKeepGoing,
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
    await addBolt(file, "Check");
    const { step } = buildStep("run", { run: "pnpm test", finishes: "finishes", label: "", cwd: "" });
    await addStep(file, "check", step!);
    await addStep(file, "Work on api", buildStep("wait", { wait: "http://localhost:3000" }).step!);

    const text = await readFile(file, "utf8");
    expect(text).toMatch(/"label": "Check",\n {6}"color": "#[0-9a-f]{6}",\n {6}"targets": \[\n {8}\{ "run": "pnpm test", "finishes": true \}\n {6}\]/);
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

  it("writes a command that finishes as such, without a restart policy, which only fits one that keeps running", () => {
    expect(buildStep("run", { run: "pnpm build", finishes: "finishes", restart: "always" }).step).toEqual({ run: "pnpm build", finishes: true });
    expect(buildStep("run", { run: "pnpm dev", finishes: "running", restart: "on-failure" }).step).toEqual({ run: "pnpm dev", restart: "on-failure" });
    expect(stepValues({ run: "pnpm build", finishes: true })["finishes"]).toBe("finishes");
    expect(stepValues({ run: "pnpm dev" })["finishes"]).toBe("running");
  });

  it("guesses from a command whether it finishes or keeps running", () => {
    const cases: [string, string | undefined][] = [
      ["npm run build", "finishes"],
      ["pnpm test", "finishes"],
      ["pg_dump shop > backup.sql", "finishes"],
      ["./backup.sh", "finishes"],
      ["docker compose up -d", "finishes"],
      ["npm run dev", "running"],
      ["npm start", "running"],
      ["pnpm test:watch", "running"],
      ["tsc --watch", "running"],
      ["docker compose up", "running"],
      ["make", undefined],
      ["", undefined],
    ];
    for (const [command, expected] of cases) expect(guessFinishes(command), command).toBe(expected);
  });

  it("edits, moves and removes steps", async () => {
    await addStep(file, "Work on api", { run: "pnpm dev" });
    await addStep(file, "Work on api", { url: "localhost:3000" });
    await moveStep(file, "Work on api", 2, -1);
    expect((await boltSteps(file, "Work on api")).map(describeRawStep)).toEqual(["open the apps/api folder", "open localhost:3000", "run pnpm dev"]);

    await replaceStep(file, "Work on api", 2, { run: "pnpm dev --turbo", cwd: "apps/api" });
    await removeStep(file, "Work on api", 0);
    expect((await boltSteps(file, "Work on api")).map(describeRawStep)).toEqual(["open localhost:3000", "run pnpm dev --turbo in apps/api"]);
    expect(stepValues({ run: "pnpm dev --turbo", cwd: "apps/api" })).toEqual({ run: "pnpm dev --turbo", cwd: "apps/api", finishes: "running" });
  });

  it("renames, reorders, makes keep going after a failure and deletes bolts — refusing a duplicate name", async () => {
    await addBolt(file, "Check");
    await expect(addBolt(file, "check")).rejects.toThrow(/already a bolt/);
    await renameBolt(file, "Check", "Run the tests");
    await setKeepGoing(file, "Run the tests", true);
    await moveBolt(file, "Run the tests", -1);
    let read = await readProjectFile(file);
    expect(read.workspace.bolts.map((bolt) => [bolt.label, bolt.keepGoing ?? false])).toEqual([
      ["Run the tests", true],
      ["Work on api", false],
    ]);
    await removeBolt(file, "Work on api");
    read = await readProjectFile(file);
    expect(read.workspace.bolts.map((bolt) => bolt.label)).toEqual(["Run the tests"]);
  });

  it("runs steps together and apart: t joins the one before or leaves the group, K and J respect groups", async () => {
    const runs = async () => {
      const targets = JSON.parse(await readFile(file, "utf8")).bolts[0].targets as Record<string, unknown>[];
      return targets.map((target) => (Array.isArray(target["together"]) ? (target["together"] as { run: string }[]).map((step) => step.run) : String(target["run"] ?? target["folder"])));
    };
    await removeStep(file, "Work on api", 0);
    for (const run of ["a", "b", "c", "d"]) await addStep(file, "Work on api", { run, finishes: true });
    expect(await toggleTogether(file, "Work on api", 1)).toBe(1);
    expect(await toggleTogether(file, "Work on api", 2)).toBe(2);
    expect(await runs()).toEqual([["a", "b", "c"], "d"]);
    expect(await boltSteps(file, "Work on api")).toHaveLength(4);
    expect((await readProjectFile(file)).workspace.bolts[0]!.steps.map((step) => step.together)).toEqual([0, 0, 0, undefined]);

    expect(await moveStep(file, "Work on api", 1, -1)).toBe(0);
    expect(await runs()).toEqual([["b", "a", "c"], "d"]);
    expect(await moveStep(file, "Work on api", 3, -1)).toBe(0);
    expect(await runs()).toEqual(["d", ["b", "a", "c"]]);
    expect(await moveStep(file, "Work on api", 3, 1)).toBe(3);
    expect(await runs()).toEqual(["d", ["b", "a"], "c"]);

    expect(await toggleTogether(file, "Work on api", 2)).toBe(2);
    expect(await runs()).toEqual(["d", "b", "a", "c"]);
    await toggleTogether(file, "Work on api", 0);
    expect(await runs()).toEqual([["d", "b"], "a", "c"]);

    await addStep(file, "Work on api", { run: "e" }, 1);
    expect(await runs()).toEqual([["d", "e", "b"], "a", "c"]);
    await removeStep(file, "Work on api", 0);
    expect(await runs()).toEqual([["e", "b"], "a", "c"]);
  });

  it("adds, renames and removes inputs: a rename follows into the steps and the question", async () => {
    await replaceStep(file, "Work on api", 0, { run: "./deploy.sh {{env}}", finishes: true });
    await setConfirm(file, "Work on api", "Deploy to {{ env }}?");
    await setInput(file, "Work on api", undefined, "env", { ask: "Deploy where?", choices: ["staging", "production"] });
    await setInput(file, "Work on api", undefined, "tag", { default: "latest" });
    await setInput(file, "Work on api", "env", "target", { ask: "Deploy where?", choices: ["staging", "production"], default: "staging" });
    const written = JSON.parse(await readFile(file, "utf8")).bolts[0];
    expect(Object.keys(written)).toEqual(["label", "color", "confirm", "inputs", "targets"]);
    expect(Object.keys(written.inputs)).toEqual(["target", "tag"]);
    expect(written.targets[0].run).toBe("./deploy.sh {{target}}");
    expect(written.confirm).toBe("Deploy to {{target}}?");
    expect((await readProjectFile(file)).diagnostics.filter((entry) => entry.message.includes("{{"))).toEqual([]);

    await removeInput(file, "Work on api", "target");
    await removeInput(file, "Work on api", "tag");
    expect(JSON.parse(await readFile(file, "utf8")).bolts[0]).not.toHaveProperty("inputs");
  });

  it("builds an input from a form, and says what is wrong with one", () => {
    expect(buildInput({ name: "env", ask: " Where? ", choices: "staging, production, staging", default: "staging" }, [])).toEqual({ name: "env", input: { ask: "Where?", choices: ["staging", "production"], default: "staging" } });
    expect(buildInput({ name: "2fa", choices: "a", default: "b" }, [])).toEqual({ errors: { name: "letters, digits, - and _, starting with a letter", default: "one of a" } });
    expect(buildInput({ name: "env" }, ["env"])).toEqual({ errors: { name: "there is already an input called env" } });
    expect(inputValues("env", { choices: ["a", 2], default: 2 })).toEqual({ name: "env", ask: "", choices: "a, 2", default: "2" });
  });

  it("writes whether a bolt asks first, and its question, and drops both when it doesn't", async () => {
    await setConfirm(file, "Work on api", "  Start the shared API?  ");
    expect((await readProjectFile(file)).workspace.bolts[0]?.confirm).toBe("Start the shared API?");
    await setConfirm(file, "Work on api", true);
    expect(JSON.parse(await readFile(file, "utf8")).bolts[0].confirm).toBe(true);
    expect((await readProjectFile(file)).workspace.bolts[0]?.confirm).toBe('Run "Work on api"?');
    await setConfirm(file, "Work on api", false);
    expect(JSON.parse(await readFile(file, "utf8")).bolts[0]).not.toHaveProperty("confirm");
    await setConfirm(file, "Work on api", " ");
    expect(JSON.parse(await readFile(file, "utf8")).bolts[0]).not.toHaveProperty("confirm");
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
