import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { interpret } from "./project.js";
import { draftProject, parseCompose, portFrom, writeProjectDraft } from "./scaffold.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "specter-init-")));
  process.env["SPECTER_HOME"] = join(dir, ".home");
});

afterEach(async () => {
  delete process.env["SPECTER_HOME"];
  await rm(dir, { recursive: true, force: true });
});

async function files(tree: Record<string, unknown>): Promise<void> {
  for (const [path, contents] of Object.entries(tree)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
  }
}

async function draft() {
  const result = await draftProject(dir);
  const raw = JSON.parse(result.contents) as { name: string; bolts: { label: string; color?: string; job?: boolean; targets: unknown[]; down?: unknown[] }[] };
  // Every bolt gets a colour, and no two the same; compared apart from the rest, since it is random.
  const colors = raw.bolts.map((bolt) => bolt.color);
  expect(colors.every((color) => /^#[0-9a-f]{6}$/.test(color ?? ""))).toBe(true);
  expect(new Set(colors).size).toBe(colors.length);
  const parsed = { ...raw, bolts: raw.bolts.map(({ color: _color, ...bolt }) => bolt) };
  return { ...result, parsed };
}

describe("init reads what the project already has", () => {
  it("turns a monorepo with services into bolts that start them in order", async () => {
    await files({
      "package.json": { name: "@acme/root", packageManager: "pnpm@10.0.0", scripts: { dev: "turbo dev", lint: "eslint .", test: "vitest run" } },
      "apps/web/package.json": { name: "@acme/web", scripts: { dev: "next dev" } },
      "apps/api/package.json": { name: "api", scripts: { dev: "tsx watch src/index.ts --port 4000" } },
      "packages/ui/package.json": { name: "@acme/ui", scripts: { build: "tsc" } },
      "compose.yaml": `services:
  db:
    image: postgres
    ports:
      - "5432:5432"
  cache:
    image: redis
    ports: ["6379"]
`,
    });
    const { parsed, detected } = await draft();

    expect(parsed.name).toBe("Root");
    expect(parsed.bolts.map((bolt) => bolt.label)).toEqual(["Services", "Work on api", "Work on web", "Run everything", "Check"]);
    expect(parsed.bolts[0]).toEqual({ label: "Services", targets: [{ compose: "compose.yaml" }] });
    expect(parsed.bolts[1]!.targets).toEqual([
      { bolt: "Services" },
      { folder: "apps/api" },
      { run: "pnpm dev", cwd: "apps/api", label: "api dev" },
      { wait: "http://localhost:4000" },
      { url: "http://localhost:4000" },
    ]);
    expect(parsed.bolts[2]!.targets).toContainEqual({ url: "http://localhost:3000" });
    expect(parsed.bolts[4]).toEqual({ label: "Check", job: true, targets: [{ run: "pnpm lint", label: "lint" }, { run: "pnpm test", label: "test" }] });
    expect(detected.sources).toContain("compose.yaml (db, cache)");
  });

  it("finds a development compose file below the root, and never the production one", async () => {
    await files({
      "package.json": { name: "app", scripts: { dev: "next dev --turbopack" } },
      "deployments/production/docker-compose.yml": "services:\n  db:\n    ports:\n      - 5432:5432\n",
      "deployments/development/docker-compose.yml": "services:\n  postgres:\n    ports:\n      - \"5432:5432\"\n",
    });
    const { parsed } = await draft();
    expect(parsed.bolts[0]).toEqual({ label: "Services", targets: [{ compose: "deployments/development/docker-compose.yml" }] });
    expect(parsed.bolts[1]!.targets[0]).toEqual({ bolt: "Services" });
  });

  it("uses a task runner when there is no package to start", async () => {
    await files({ Makefile: ".PHONY: dev test\ndev:\n\tgo run ./cmd/server\n\ntest:\n\tgo test ./...\n" });
    const { parsed } = await draft();
    expect(parsed.bolts.map((bolt) => [bolt.label, bolt.targets])).toEqual([
      [`Work on ${parsed.name}`, [{ run: "make dev", label: `${parsed.name} dev` }]],
      ["Check", [{ run: "make test", label: "test" }]],
    ]);
  });

  it("reads mise, just and Taskfile tasks too", async () => {
    await files({ "mise.toml": '[tasks.dev]\nrun = "cargo watch"\n\n[tasks.test]\nrun = "cargo test"\n' });
    expect((await draft()).parsed.bolts[0]!.targets).toEqual([{ run: "mise run dev", label: expect.stringContaining("dev") }]);
  });

  it("runs a Procfile's processes side by side", async () => {
    await files({ Procfile: "web: bundle exec rails s\nworker: bundle exec sidekiq\n" });
    expect((await draft()).parsed.bolts[0]).toEqual({
      label: "Run all",
      targets: [
        { run: "bundle exec rails s", label: "web" },
        { run: "bundle exec sidekiq", label: "worker" },
      ],
    });
  });

  it("uses the package manager the lockfile says", async () => {
    await files({ "package.json": { name: "site", scripts: { dev: "vite" } }, "yarn.lock": "" });
    expect((await draft()).parsed.bolts[0]!.targets).toEqual([
      { run: "yarn dev", label: "Site dev" },
      { wait: "http://localhost:5173" },
      { url: "http://localhost:5173" },
    ]);
  });

  it("does not mistake a production start script for a dev server", async () => {
    await files({ "package.json": { name: "svc", scripts: { start: "node dist/index.js", test: "node --test" } } });
    expect((await draft()).parsed.bolts.map((bolt) => bolt.label)).toEqual(["Check"]);
  });

  it("falls back to folders when there is nothing to run", async () => {
    await files({ "src/index.ts": "" });
    expect((await draft()).parsed.bolts).toEqual([{ label: "Work on src", targets: [{ folder: "src" }] }]);
  });

  it("writes a file that reads back as the workspace it describes, with nothing to report", async () => {
    await files({
      "package.json": { name: "app", scripts: { dev: "next dev", test: "vitest" } },
      "docker-compose.yml": "services:\n  db:\n    ports:\n      - 5432:5432\n",
    });
    const result = await draftProject(dir);
    await writeProjectDraft(result);
    const read = interpret({ main: JSON.parse(result.contents) }, { file: result.file, personal: false, trust: "trusted", os: "darwin" });
    expect(read.diagnostics).toEqual([]);
    expect(read.workspace.bolts.map((bolt) => bolt.label)).toEqual(["Services", "Work on App", "Check"]);
    await expect(writeProjectDraft(result)).rejects.toThrow(/already exists/);
  });

  it("lays the file out to be read in review: one step per line", async () => {
    await files({ "package.json": { name: "app", scripts: { dev: "vite" } } });
    const { contents } = await draftProject(dir);
    expect(contents).toMatch(/"label": "Work on App",\n {6}"color": "#[0-9a-f]{6}",\n {6}"targets": \[\n {8}\{ "run": "npm run dev", "label": "App dev" \},\n/);
  });
});

describe("portFrom", () => {
  it.each([
    ["next dev", 3000],
    ["next build", undefined],
    ["vite", 5173],
    ["vite build", undefined],
    ["astro dev", 4321],
    ["ng serve", 4200],
    ["tsx watch src --port 4000", 4000],
    ["PORT=8080 node server.js", 8080],
    ["node server.js", undefined],
  ] as const)("%s → %s", (command, port) => {
    expect(portFrom(command)).toBe(port);
  });
});

describe("parseCompose", () => {
  it("reads published ports in their short and long forms", () => {
    expect(
      parseCompose(`version: "3"
services:
  db:
    image: postgres
    ports:
      - "127.0.0.1:5432:5432"
  web:
    build: .
    ports:
      - target: 80
        published: 8080
  worker:
    build: .
volumes:
  data: {}
`),
    ).toEqual([
      { name: "db", ports: [5432] },
      { name: "web", ports: [8080] },
      { name: "worker", ports: [] },
    ]);
  });
});

describe("colours", () => {
  it("never repeat, and keep going past the set", async () => {
    const { PALETTE, pickColor, pickColors } = await import("./colors.js");
    const all = pickColors(PALETTE.length + 6);
    expect(new Set(all).size).toBe(all.length);
    expect(pickColor(PALETTE.slice(1), () => 0)).toBe(PALETTE[0]);
  });
});
