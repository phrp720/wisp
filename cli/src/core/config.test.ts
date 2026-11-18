import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getMouse, setMouse } from "./config.js";
import { configPath } from "./paths.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wisp-config-"));
  process.env["WISP_HOME"] = join(dir, "home");
});

afterEach(async () => {
  delete process.env["WISP_HOME"];
  await rm(dir, { recursive: true, force: true });
});

describe("the mouse setting", () => {
  it("is on until you turn it off, and only off is written down", async () => {
    expect(await getMouse()).toBe(true);
    expect(await setMouse(false)).toBe(false);
    expect(await getMouse()).toBe(false);
    expect(JSON.parse(await readFile(configPath(), "utf8"))).toMatchObject({ mouse: false });
    expect(await setMouse(true)).toBe(true);
    expect(JSON.parse(await readFile(configPath(), "utf8"))).not.toHaveProperty("mouse");
  });
});
