import { execFile } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { pickColors } from "./colors.js";
import { WispError } from "./errors.js";
import { expandHome } from "./paths.js";
import { PROJECT_FILE, PROJECT_SCHEMA_URL } from "./project.js";

const run = promisify(execFile);

/**
 * A project file Wisp guessed at, before anyone has edited it.
 *
 * Held as a draft rather than written straight out, so the CLI can show what it is about
 * to commit to a repository and the caller can say no.
 */
export interface ProjectDraft {
  file: string;
  contents: string;
  detected: Detected;
}

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** Something in the project that can be started: a package with a dev script, say. */
export interface App {
  name: string;
  /** Relative to the project root; empty for the root itself. */
  dir: string;
  command: string;
  /** Where it listens, when the script says or the framework is known. */
  port?: number;
}

export interface Service {
  name: string;
  ports: number[];
}

export interface Check {
  label: string;
  run: string;
}

export interface Detected {
  name: string;
  remote?: string;
  links: { label: string; url: string }[];
  /** Where each finding came from, so the draft can be judged rather than trusted. */
  sources: string[];
  apps: App[];
  /** The whole thing at once — a monorepo's root `dev`, a Procfile. */
  everything?: { label: string; steps: { label: string; run: string }[] };
  /** Services from a compose file, and its path relative to the project. */
  compose?: { services: Service[]; file?: string };
  checks: Check[];
  /** Folders worth opening when nothing else was found. */
  folders: { label: string; path: string }[];
}

/**
 * Draft a `.wisp.json` for a directory from what is already there.
 *
 * The point is the blank page: a project already says how to run it — in package.json,
 * a Makefile, docker-compose — and `init` reads that, so the first `wisp` works
 * without anyone writing a line. The guesses are the ones a person would make from the
 * same files.
 */
export async function draftProject(from: string = process.cwd()): Promise<ProjectDraft> {
  const root = resolve(expandHome(from));
  const detected = await detect(root);
  return { file: join(root, PROJECT_FILE), contents: format(detected), detected };
}

/**
 * Write a drafted project file. Refuses to overwrite unless asked: clobbering someone's
 * carefully arranged bolts because they typed `init` twice is not a recoverable mistake.
 */
export async function writeProjectDraft(draft: ProjectDraft, overwrite = false): Promise<string> {
  if (!overwrite) {
    const exists = await stat(draft.file).catch(() => undefined);
    if (exists) throw new WispError(`${draft.file} already exists — pass --force to replace it`, "PROJECT_EXISTS");
  }
  await writeFile(draft.file, draft.contents, "utf8");
  return draft.file;
}

export async function detect(root: string): Promise<Detected> {
  const [pkg, remote, manager, compose, tasks, procfile, folders] = await Promise.all([
    readJsonFile(join(root, "package.json")),
    gitRemote(root),
    packageManager(root),
    readCompose(root),
    readTasks(root),
    readProcfile(root),
    codeFolders(root),
  ]);

  const sources: string[] = [];
  const links: Detected["links"] = [];
  if (remote) {
    links.push({ label: "Repository", url: remote });
    // Both major hosts put issues at the same place.
    if (/github\.com|gitlab\.com/.test(remote)) links.push({ label: "Issues", url: `${remote}/issues` });
  }
  const homepage = typeof pkg?.["homepage"] === "string" ? pkg["homepage"].replace(/#readme$/, "") : undefined;
  if (homepage && !links.some((link) => link.url === homepage)) links.push({ label: "Homepage", url: homepage });

  const pm = manager ?? "npm";
  const apps: App[] = [];
  const rootScripts = scriptsOf(pkg);

  // A monorepo's members, each with its own dev script, are the things you work on.
  for (const member of await members(root)) {
    const memberPkg = await readJsonFile(join(root, member, "package.json"));
    const app = appFrom(memberPkg, member, pm);
    if (app) apps.push(app);
  }
  if (apps.length > 0) sources.push(`${apps.length} package${apps.length === 1 ? "" : "s"} with a dev script`);

  let everything: Detected["everything"];
  const rootApp = appFrom(pkg, "", pm);
  if (rootApp && apps.length > 0) {
    everything = { label: "Run everything", steps: [{ label: rootApp.command, run: rootApp.command }] };
    sources.push(`root ${rootApp.command}`);
  } else if (rootApp) {
    apps.push({ ...rootApp, name: projectName(pkg, root) });
    sources.push(`package.json ${rootApp.command}`);
  }

  // No package to start, but a task runner that knows how.
  if (apps.length === 0 && !everything) {
    const dev = tasks.find((task) => DEV_NAMES.includes(task.name));
    if (dev) {
      apps.push({ name: projectName(pkg, root), dir: "", command: dev.run });
      sources.push(`${dev.source} ${dev.name}`);
    }
  }

  if (procfile.length > 0) {
    everything = { label: "Run all", steps: procfile.map((entry) => ({ label: entry.name, run: entry.command })) };
    sources.push(`Procfile (${procfile.length})`);
  }

  if (compose && compose.services.length > 0) {
    sources.push(`${compose.file ?? "docker compose"} (${compose.services.map((service) => service.name).join(", ")})`);
  }

  const checks = checksFrom(rootScripts, pm, tasks);
  const cargo = await isFile(join(root, "Cargo.toml"));
  const go = await isFile(join(root, "go.mod"));
  if (checks.length === 0 && cargo) checks.push({ label: "test", run: "cargo test" });
  if (checks.length === 0 && go) checks.push({ label: "test", run: "go test ./..." });
  if (checks.length > 0) sources.push(`checks: ${checks.map((check) => check.label).join(", ")}`);

  return {
    name: projectName(pkg, root),
    ...(remote ? { remote } : {}),
    links,
    sources,
    apps: apps.slice(0, 8),
    ...(everything ? { everything } : {}),
    ...(compose && compose.services.length > 0 ? { compose } : {}),
    checks,
    folders,
  };
}

const DEV_NAMES = ["dev", "develop", "start:dev", "serve", "start", "run", "up"];
const SCRIPT_DEV = ["dev", "develop", "start:dev", "serve", "start"];
const CHECK_NAMES = ["lint", "typecheck", "type-check", "check", "test"];

function appFrom(pkg: Record<string, unknown> | undefined, dir: string, pm: PackageManager): App | undefined {
  const scripts = scriptsOf(pkg);
  const script = SCRIPT_DEV.find((name) => scripts[name] !== undefined);
  if (!script) return undefined;
  // `start` is usually production — `node dist/index.js` — unless it is plainly a dev server.
  if (script === "start" && !portFrom(scripts[script] ?? "")) return undefined;

  const port = portFrom(scripts[script] ?? "");
  return {
    name: dir ? (stripScope(typeof pkg?.["name"] === "string" ? pkg["name"] : "") || basename(dir)) : "app",
    dir,
    command: runScript(pm, script),
    ...(port ? { port } : {}),
  };
}

function checksFrom(scripts: Record<string, string>, pm: PackageManager, tasks: Task[]): Check[] {
  const fromScripts = CHECK_NAMES.filter((name) => scripts[name] !== undefined).map((name) => ({ label: name, run: runScript(pm, name) }));
  if (fromScripts.length > 0) return fromScripts;
  return CHECK_NAMES.flatMap((name) => {
    const task = tasks.find((entry) => entry.name === name);
    return task ? [{ label: name, run: task.run }] : [];
  });
}

function runScript(pm: PackageManager, script: string): string {
  if (pm === "npm") return script === "start" || script === "test" ? `npm ${script}` : `npm run ${script}`;
  if (pm === "bun") return `bun run ${script}`;
  return `${pm} ${script}`;
}

/**
 * Where a dev script listens: what it says outright, or what its framework defaults to.
 * Only from the script itself — a dependency on `next` does not mean this script runs it.
 */
export function portFrom(command: string): number | undefined {
  const explicit = /(?:--port[= ]|\s-p\s+|\bPORT=)(\d{2,5})\b/.exec(command);
  if (explicit) return Number(explicit[1]);

  const defaults: [RegExp, number][] = [
    [/\bnext\s+dev\b|\bnext\b(?!\s+(build|start|lint))/, 3000],
    [/\bnuxi?\s+dev\b/, 3000],
    [/\bastro\s+dev\b|\bastro\b(?!\s+(build|check))/, 4321],
    [/\bng\s+serve\b/, 4200],
    [/\breact-scripts\s+start\b/, 3000],
    [/\bgatsby\s+develop\b/, 8000],
    [/\bremix\s+dev\b/, 3000],
    [/\bstorybook\s+dev\b|\bstart-storybook\b/, 6006],
    [/\bexpo\s+start\b/, 8081],
    [/\bwrangler\s+dev\b/, 8787],
    [/\bdocusaurus\s+start\b/, 3000],
    [/\bvitepress\s+dev\b/, 5173],
    [/\bwebpack(-dev-server|\s+serve)\b/, 8080],
    [/\bnest\s+start\b/, 3000],
    [/\bhugo\s+server\b/, 1313],
    [/\bvite\b(?!\s+(build|preview))/, 5173],
  ];
  return defaults.find(([pattern]) => pattern.test(command))?.[1];
}

/** The packages of a monorepo: the usual directories, one level down, each with a manifest. */
async function members(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const parent of ["apps", "packages", "services"]) {
    for (const child of await children(join(root, parent))) {
      if (await isFile(join(root, parent, child, "package.json"))) found.push(`${parent}/${child}`);
    }
  }
  return found;
}

async function packageManager(root: string): Promise<PackageManager | undefined> {
  const pkg = await readJsonFile(join(root, "package.json"));
  const declared = typeof pkg?.["packageManager"] === "string" ? pkg["packageManager"].split("@")[0] : undefined;
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  if (await isFile(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await isFile(join(root, "yarn.lock"))) return "yarn";
  if ((await isFile(join(root, "bun.lockb"))) || (await isFile(join(root, "bun.lock")))) return "bun";
  if (await isFile(join(root, "package-lock.json"))) return "npm";
  return pkg ? "npm" : undefined;
}

/**
 * Services and the ports they publish, from a compose file — read just well enough for
 * that. A compose file is YAML, and a YAML parser is a lot of weight for one list.
 */
async function readCompose(root: string): Promise<{ services: Service[]; file?: string } | undefined> {
  const found = await findCompose(root);
  if (!found) return undefined;
  const text = await readFile(join(root, found), "utf8").catch(() => undefined);
  if (!text) return undefined;
  return { services: parseCompose(text), file: found };
}

const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

/**
 * The compose file to start for development: at the root if there is one — that is where
 * `docker compose` itself looks — and otherwise a level or two down, where projects keep
 * one per environment (`deployments/development/`). A development one wins over a
 * production one: nobody wants `init` starting their production stack.
 */
async function findCompose(root: string): Promise<string | undefined> {
  for (const name of COMPOSE_NAMES) if (await isFile(join(root, name))) return name;

  const candidates: string[] = [];
  const visit = async (relative: string, depth: number) => {
    for (const child of await children(join(root, relative))) {
      if (SKIP_DIRS.has(child)) continue;
      const path = relative ? `${relative}/${child}` : child;
      for (const name of COMPOSE_NAMES) if (await isFile(join(root, path, name))) candidates.push(`${path}/${name}`);
      if (depth < 2) await visit(path, depth + 1);
    }
  };
  await visit("", 1);

  const score = (path: string) => (/\b(dev|development|local)\b/i.test(path) ? 0 : /\bprod(uction)?\b/i.test(path) ? 2 : 1);
  return candidates.sort((left, right) => score(left) - score(right) || left.length - right.length)[0];
}

const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "target", "venv", ".venv", "__pycache__"]);

export function parseCompose(text: string): Service[] {
  const services: Service[] = [];
  let inServices = false;
  let current: Service | undefined;
  let serviceIndent = -1;
  let inPorts = false;

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      inServices = line === "services:";
      current = undefined;
      continue;
    }
    if (!inServices) continue;

    if (serviceIndent === -1 || indent <= serviceIndent) {
      const key = /^([\w.-]+):\s*$/.exec(line);
      if (key) {
        serviceIndent = indent;
        current = { name: key[1] as string, ports: [] };
        services.push(current);
        inPorts = false;
        continue;
      }
    }
    if (!current) continue;

    if (/^ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (inPorts && line.startsWith("-")) {
      const port = publishedPort(line.replace(/^-\s*/, "").replace(/["']/g, ""));
      if (port) current.ports.push(port);
      continue;
    }
    if (inPorts && /^published:\s*["']?(\d+)/.test(line)) {
      current.ports.push(Number(/(\d+)/.exec(line)?.[1]));
      continue;
    }
    if (inPorts && !line.startsWith("-") && !/^(target|published|protocol|mode|host_ip):/.test(line)) inPorts = false;
  }

  return services;
}

/** The host side of `"5432:5432"`, `"127.0.0.1:8080:80"`, `"8080:80/tcp"`. A bare port is random on the host. */
function publishedPort(spec: string): number | undefined {
  const parts = spec.replace(/\/\w+$/, "").split(":");
  if (parts.length < 2) return undefined;
  const host = Number(parts[parts.length - 2]);
  return Number.isInteger(host) && host > 0 && host < 65536 ? host : undefined;
}

interface Task {
  source: string;
  name: string;
  run: string;
}

/** Targets and tasks from the task runners people use, as the commands that run them. */
async function readTasks(root: string): Promise<Task[]> {
  const tasks: Task[] = [];

  const make = await readFile(join(root, "Makefile"), "utf8").catch(() => undefined);
  if (make) {
    for (const match of make.matchAll(/^([A-Za-z][\w.-]*)\s*:(?!=)/gm)) {
      const name = match[1] as string;
      if (!name.startsWith(".")) tasks.push({ source: "Makefile", name, run: `make ${name}` });
    }
  }

  const just = (await readFile(join(root, "justfile"), "utf8").catch(() => undefined)) ?? (await readFile(join(root, "Justfile"), "utf8").catch(() => undefined));
  if (just) {
    for (const match of just.matchAll(/^@?([A-Za-z][\w-]*)(?:\s+[^:=\n]*)?:(?!=)/gm)) {
      tasks.push({ source: "justfile", name: match[1] as string, run: `just ${match[1]}` });
    }
  }

  const mise = (await readFile(join(root, "mise.toml"), "utf8").catch(() => undefined)) ?? (await readFile(join(root, ".mise.toml"), "utf8").catch(() => undefined));
  if (mise) {
    for (const match of mise.matchAll(/^\[tasks\.["']?([\w:-]+)["']?\]/gm)) {
      tasks.push({ source: "mise", name: match[1] as string, run: `mise run ${match[1]}` });
    }
  }

  const taskfile = (await readFile(join(root, "Taskfile.yml"), "utf8").catch(() => undefined)) ?? (await readFile(join(root, "Taskfile.yaml"), "utf8").catch(() => undefined));
  if (taskfile) {
    const section = taskfile.split(/^tasks:\s*$/m)[1] ?? "";
    for (const match of section.matchAll(/^ {2}([\w:-]+):\s*$/gm)) {
      tasks.push({ source: "Taskfile", name: match[1] as string, run: `task ${match[1]}` });
    }
  }

  return tasks;
}

async function readProcfile(root: string): Promise<{ name: string; command: string }[]> {
  const text = await readFile(join(root, "Procfile"), "utf8").catch(() => undefined);
  if (!text) return [];
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^([\w-]+):\s*(.+)$/.exec(line.trim());
    return match ? [{ name: match[1] as string, command: (match[2] as string).trim() }] : [];
  });
}

/** The repository url, as a browser can open it — never the `git@host:owner/repo.git` form. */
async function gitRemote(root: string): Promise<string | undefined> {
  const result = await run("git", ["remote", "get-url", "origin"], { cwd: root }).catch(() => undefined);
  const raw = result?.stdout.trim();
  if (!raw) return undefined;
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(raw);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return raw.replace(/\.git$/, "");
}

/** Fallback when there is nothing to run: a monorepo's members, or a plain project's `src`. */
async function codeFolders(root: string): Promise<{ label: string; path: string }[]> {
  const found: { label: string; path: string }[] = [];
  for (const parent of ["apps", "packages", "services", "libs"]) {
    for (const child of await children(join(root, parent))) found.push({ label: child, path: `${parent}/${child}` });
  }
  if (found.length > 0) return found.slice(0, 8);
  for (const dir of ["src", "lib", "app"]) {
    if (await isDirectory(join(root, dir))) return [{ label: dir, path: dir }];
  }
  return [];
}

function projectName(pkg: Record<string, unknown> | undefined, root: string): string {
  const name = typeof pkg?.["name"] === "string" ? stripScope(pkg["name"]) : "";
  return name ? titleCase(name) : basename(root) || "Project";
}

function stripScope(name: string): string {
  return name.replace(/^@[^/]+\//, "");
}

function scriptsOf(pkg: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = pkg?.["scripts"];
  if (typeof scripts !== "object" || scripts === null) return {};
  return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readFile(path, "utf8").catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function children(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => (word[0] ?? "").toUpperCase() + word.slice(1))
    .join(" ");
}

type Step = Record<string, unknown>;
interface DraftBolt {
  label: string;
  color?: string;
  job?: boolean;
  targets: (Step | string)[];
  down?: Step[];
}

/** The bolts a person would write after reading the same files. */
export function bolts(detected: Detected, random: () => number = Math.random): DraftBolt[] {
  const out: DraftBolt[] = [];
  const services = detected.compose?.services ?? [];

  if (services.length > 0) {
    // A compose step rather than a `docker compose up` command: Wisp then waits for the
    // services to be healthy, shows each container, and stops them again on `down`.
    out.push({ label: "Services", targets: [{ compose: detected.compose?.file ?? composeFileName(detected) }] });
  }
  const needsServices = services.length > 0 ? [{ bolt: "Services" }] : [];

  for (const app of detected.apps) {
    const url = app.port ? `http://localhost:${app.port}` : undefined;
    out.push({
      label: `Work on ${app.name}`,
      targets: [
        ...needsServices,
        ...(app.dir ? [{ folder: app.dir }] : []),
        { run: app.command, ...(app.dir ? { cwd: app.dir } : {}), label: `${app.name} ${app.command.split(" ").pop()}` },
        ...(url ? [{ wait: url }, { url }] : []),
      ],
    });
  }

  if (detected.everything) {
    out.push({
      label: detected.everything.label,
      targets: [...needsServices, ...detected.everything.steps.map((step) => ({ run: step.run, label: step.label }))],
    });
  }

  if (detected.checks.length > 0) {
    out.push({ label: "Check", job: true, targets: detected.checks.map((check) => ({ run: check.run, label: check.label })) });
  }

  // Nothing to run at all: the old, plain draft — a bolt per area, opening it with the repo.
  if (out.length === 0) {
    const repo = detected.links[0]?.label;
    if (detected.folders.length === 0) {
      out.push({ label: `Open ${detected.name}`, targets: detected.links.map((link) => link.label) });
    } else {
      for (const folder of detected.folders) {
        out.push({ label: `Work on ${folder.label}`, targets: [{ folder: folder.path }, ...(repo ? [repo] : [])] });
      }
    }
  } else if (detected.links.length > 0) {
    out.push({ label: "Open the repo", targets: detected.links.map((link) => link.label) });
  }

  // A colour each, none the same, so the list reads at a glance.
  const kept = out.filter((bolt) => bolt.targets.length > 0);
  const colors = pickColors(kept.length, [], random);
  return kept.map((bolt, at) => ({ label: bolt.label, color: colors[at] as string, ...(bolt.job ? { job: true } : {}), targets: bolt.targets, ...(bolt.down ? { down: bolt.down } : {}) }));
}

function composeFileName(detected: Detected): string {
  return detected.compose?.file ?? "compose.yaml";
}

function format(detected: Detected): string {
  return formatProjectFile([
    // First line of every generated file: it turns on autocomplete and inline validation
    // in any editor that reads JSON Schema.
    ["$schema", PROJECT_SCHEMA_URL],
    ["name", detected.name],
    ["links", detected.links],
    ["bolts", bolts(detected)],
  ]);
}

/**
 * A project file as JSON a person would have typed.
 *
 * `JSON.stringify` spreads every asset across four lines and runs the sections together.
 * A project file is read in review, so it is laid out by hand: one asset per line, a bolt
 * per block with one step per line, a blank line between sections. Empty lists are left
 * out, so a project with no links does not commit `"links": []`.
 */
export function formatProjectFile(sections: [key: string, value: unknown][]): string {
  const groups: string[][] = [];
  let scalars: string[] = [];

  const flush = () => {
    if (scalars.length > 0) groups.push(scalars);
    scalars = [];
  };

  for (const [key, value] of sections) {
    if (value === undefined || value === "") continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      flush();
      const body = key === "bolts" ? (value as (DraftBolt & Record<string, unknown>)[]).map(boltBlock).join(",\n") : rows(value as Record<string, unknown>[]);
      groups.push([`  ${JSON.stringify(key)}: [\n${body}\n  ]`]);
      continue;
    }

    scalars.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  }
  flush();

  return `{\n${groups.map((group) => group.join(",\n")).join(",\n\n")}\n}\n`;
}

/**
 * One bolt as a block: its name and settings first, then one step per line. Every field
 * is kept, in the order written — the file may hold what a person added by hand.
 */
function boltBlock(bolt: DraftBolt & Record<string, unknown>): string {
  const keys = ["label", ...Object.keys(bolt).filter((key) => key !== "label" && key !== "targets" && key !== "down"), "targets", ...("down" in bolt ? ["down"] : [])];
  const lines = keys.map((key) => {
    const value = bolt[key];
    if (key === "targets") {
      const steps = (Array.isArray(value) ? value : []) as unknown[];
      return steps.length === 0 ? `      "targets": []` : `      "targets": [\n${steps.map((step) => `        ${inline(step)}`).join(",\n")}\n      ]`;
    }
    if (key === "down") return `      "down": [${((value as unknown[]) ?? []).map(inline).join(", ")}]`;
    return `      ${JSON.stringify(key)}: ${inline(value)}`;
  });
  return `    {\n${lines.join(",\n")}\n    }`;
}

function rows(items: Record<string, unknown>[]): string {
  return items.map((item) => `    ${inline(item)}`).join(",\n");
}

/** One value on one line, spaced the way a person spaces it. */
function inline(value: unknown): string {
  return JSON.stringify(value, null, 1).replace(/\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]");
}
