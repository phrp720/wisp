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
      links: ["acme.com", { label: "Staging", url: "https://staging.acme.com", os: "macos" }],
      folders: ["apps/api", { label: "web", path: "apps/web", os: ["linux", "windows"] }],
      files: [{ label: "Readme", path: "README.md" }],
      apps: ["Slack", { label: "Editor", app: { macos: "Visual Studio Code", linux: "code" } }],
      commands: [
        { label: "dev", run: "pnpm dev", cwd: "apps/api", env: { PORT: 3000 }, shell: "sh", background: true },
        { label: "build", run: { macos: "make", windows: "nmake" } },
      ],
      bolts: [
        { label: "Database", job: true, targets: [{ run: "docker compose up -d" }, { wait: "5432" }], down: [{ run: "docker compose stop" }] },
        {
          label: "Work on api",
          color: "#4a9dff",
          targets: [
            { bolt: "Database", workspace: "infra" },
            { bolt: "Database" },
            { compose: "deployments/development/docker-compose.yml", services: ["postgres"] },
            "apps/api",
            { folder: "apps/api" },
            { file: "docs/runbook.md" },
            { url: "http://localhost:3000" },
            { app: "Slack" },
            { run: "pnpm test", env: { CI: true } },
            { wait: 3 },
            { wait: "localhost:5432" },
            { wait: { url: "http://localhost:3000", timeout: 90 } },
            "dev",
          ],
        },
      ],
    };

    expect(valid(file)).toBe(true);
    const read = interpret({ main: file }, { file: "/w/.wisp.json", personal: false, trust: "trusted", os: "darwin" });
    expect(read.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
  });

  it("flags what the reader would warn about", () => {
    expect(valid({ nmae: "typo" })).not.toBe(true);
    expect(valid({ apps: [{ app: { beos: "x" } }] })).not.toBe(true);
    expect(valid({ commands: [{ run: "x", shell: "fish" }] })).not.toBe(true);
    expect(valid({ bolts: [{ label: "x", targets: [{ wait: "soon" }] }] })).not.toBe(true);
    expect(valid({ bolts: [{ label: "x", targets: [{ folder: "a", run: "b" }] }] })).not.toBe(true);
  });

  it("validates Wisp's own project file", async () => {
    expect(valid(await load(".wisp.json"))).toBe(true);
  });
});
