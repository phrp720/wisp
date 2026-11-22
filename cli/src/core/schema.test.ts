import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { PROJECT_SCHEMA_URL, interpret } from "./project.js";

// The repository's root: the schema lives there, beside cli/, at the address files link to.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function load(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(ROOT, path), "utf8"));
}

/**
 * The schema is a second description of the format, so it can disagree with the first.
 * These tests make that fail loudly: an editor that accepts what Wisp ignores, or flags
 * what Wisp reads, is worse than no schema at all.
 */
describe("the published schema", async () => {
  const schema = await load("schema/wisp.schema.json");
  const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);

  const valid = (file: unknown) => {
    const ok = validate(file);
    return ok ? true : validate.errors?.map((error) => `${error.instancePath} ${error.message}`).join("; ");
  };

  it("is served from the url generated files point at", () => {
    expect(schema["$id"]).toBe(PROJECT_SCHEMA_URL);
  });

  it("accepts every form the reader accepts, and the reader reads them without errors", () => {
    const file = {
      $schema: PROJECT_SCHEMA_URL,
      name: "Acme",
      icon: "🏢",
      color: "#6d4aff",
      pipelines: [
        { label: "Database", keepGoing: true, steps: [{ run: "docker compose up -d", label: "up", finishes: true }, { wait: "5432", after: "up" }], down: [{ run: "docker compose stop" }] },
        {
          label: "Work on api",
          color: "#4a9dff",
          steps: [
            { pipeline: "Database", label: "db" },
            { folder: "apps/api", after: "db" },
            { compose: "deployments/development/docker-compose.yml", services: ["postgres"] },
            { folder: "apps/api" },
            { label: "web", folder: "apps/web", os: ["linux", "windows"] },
            { file: "docs/runbook.md" },
            { url: "http://localhost:3000" },
            { label: "Staging", url: "https://staging.acme.com", os: "macos" },
            { app: "Slack" },
            { label: "Editor", app: { macos: "Visual Studio Code", linux: "code" } },
            { label: "dev", run: "pnpm dev", cwd: "apps/api", env: { PORT: 3000 }, shell: "sh", background: true },
            { label: "build", run: { macos: "make", windows: "nmake" } },
            { run: "pnpm test", env: { CI: true }, finishes: true, timeout: "10m" },
            { run: "pnpm e2e", finishes: true, timeout: 900 },
            { wait: 3 },
            { wait: "localhost:5432" },
            { wait: { url: "http://localhost:3000", timeout: 90 } },
          ],
        },
        {
          label: "Deploy",
          confirm: "Deploy {{tag}} to {{env}}?",
          inputs: { env: { ask: "Deploy where?", choices: ["staging", "production"], default: "staging" }, tag: {} },
          steps: [{ run: "./deploy.sh {{env}} {{tag}}", finishes: true }, { wait: "https://{{env}}.acme.com/health" }, { url: "https://{{env}}.acme.com" }],
        },
        { label: "Restore", confirm: true, steps: [{ run: "./restore.sh", finishes: true }] },
        { label: "Check", steps: [{ run: "pnpm lint", label: "lint", finishes: true }, { run: "pnpm test", label: "test", finishes: true }, { wait: "localhost:5432" }, { run: "pnpm build", after: ["lint", "test"], finishes: true }] },
      ],
    };

    expect(valid(file)).toBe(true);
    const read = interpret({ main: file }, { file: "/w/.wisp.json", personal: false, trust: "trusted", os: "darwin" });
    expect(read.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
    expect(read.diagnostics.filter((entry) => entry.at.startsWith("pipelines[2]") || entry.at.startsWith("pipelines[3]") || entry.at.startsWith("pipelines[4]"))).toEqual([]);
  });

  it("has no shared sections, and no steps written as a name", () => {
    expect(valid({ links: [{ label: "Repository", url: "https://github.com/acme/acme" }], pipelines: [] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "Open", steps: ["Repository"] }] })).not.toBe(true);
    const read = interpret({ main: { pipelines: [{ label: "Open", steps: ["Repository", { url: "acme.com" }] }] } }, { file: "/w/.wisp.json", personal: false, trust: "trusted", os: "darwin" });
    expect(read.diagnostics.filter((entry) => entry.level === "error").map((entry) => entry.message)).toEqual(['dropped: a step is an object, like { "run": "pnpm dev" } or { "url": "localhost:3000" }']);
    expect(read.workspace.bolts[0]?.steps).toHaveLength(1);
  });

  it("flags what the reader would warn about", () => {
    expect(valid({ nmae: "typo" })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", steps: [{ run: "a", finishes: true, timeout: "soon" }] }] })).not.toBe(true);
    expect(valid({ apps: [{ app: { beos: "x" } }] })).not.toBe(true);
    expect(valid({ commands: [{ run: "x", shell: "fish" }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", steps: [{ wait: "soon" }] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", steps: [{ folder: "a", run: "b" }] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", confirm: 3, steps: [] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", inputs: { "bad name": {} }, steps: [] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", inputs: { env: { ask: "Where?", options: ["a"] } }, steps: [] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", inputs: { env: { choices: ["eu;west"] } }, steps: [] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", inputs: { note: { default: "a --force" } }, steps: [] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", inputs: { tag: { default: "-rf" } }, steps: [] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", inputs: { city: { choices: ["München", 3, "eu west"] } }, steps: [] }] })).toBe(true);
    expect(valid({ pipelines: [{ label: "x", steps: [{ pipeline: "Database", run: "a" }] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", steps: [{ run: "a", after: 3 }] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", needs: ["Database"], steps: [] }] })).not.toBe(true);
    expect(valid({ pipelines: [{ label: "x", steps: [{ pipeline: "Database", workspace: "infra" }] }] })).not.toBe(true);
  });

  it("validates Wisp's own project file", async () => {
    expect(valid(await load(".wisp.json"))).toBe(true);
  });
});
