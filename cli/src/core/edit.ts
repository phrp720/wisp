import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { WispError, describe } from "./errors.js";
import { workspacesDir } from "./paths.js";
import { PROJECT_SCHEMA_URL, parseWait, readProjectFile } from "./project.js";
import { pickColor } from "./colors.js";
import { formatProjectFile } from "./scaffold.js";
import { localFileFor, trustProject } from "./trust.js";

/**
 * Changing a workspace file without anyone writing JSON.
 *
 * The TUI's forms land here: add a bolt, add a step, move it, rename it. Each change is
 * read, made and written in one go, laid out the way `init` lays a file out, so the file
 * stays one a person can read in a pull request.
 */

/** A step as it is written in the file: a label naming a shared asset, or an object. */
export type RawStep = string | Record<string, unknown>;

export interface RawBolt {
  label: string;
  notes?: string;
  job?: boolean;
  color?: string;
  targets: RawStep[];
  down?: RawStep[];
  [key: string]: unknown;
}

/**
 * The kinds of step a form can make, grouped the way a person looks for them — something to
 * start, something to wait for, something to open — each with an icon and a few examples.
 */
export const STEP_KINDS = [
  { kind: "run", group: "Start", icon: "💻", title: "Run a command", example: "pnpm dev, make test, ./deploy.sh" },
  { kind: "compose", group: "Start", icon: "🐳", title: "Start Docker services", example: "a database, a cache — from a compose file" },
  { kind: "bolt", group: "Start", icon: "⚡", title: "Run another bolt first", example: "start the database before the API" },
  { kind: "wait", group: "Wait", icon: "⏳", title: "Wait until something is ready", example: "a website answers, a port opens, a few seconds" },
  { kind: "url", group: "Open", icon: "🌐", title: "Open a website", example: "http://localhost:3000, the staging dashboard" },
  { kind: "folder", group: "Open", icon: "📁", title: "Open a folder", example: "in your file manager, or your editor" },
  { kind: "file", group: "Open", icon: "📄", title: "Open a file", example: "README.md, docs/runbook.md" },
  { kind: "app", group: "Open", icon: "🧩", title: "Open an app", example: "Slack, Figma, Postman" },
] as const;

export type StepKindName = (typeof STEP_KINDS)[number]["kind"];

/** One field of a step's form. */
export interface StepField {
  key: string;
  label: string;
  hint: string;
  required: boolean;
  /** An example of what goes there, shown in grey while it is empty. */
  placeholder?: string;
  /** A choice between a few options instead of text. */
  choices?: { value: string; label: string }[];
}

/** What each kind of step asks for. The first field is the one that matters. */
export const STEP_FIELDS: Record<StepKindName, StepField[]> = {
  run: [
    { key: "run", label: "Command", hint: "what you would type in a terminal", placeholder: "pnpm dev", required: true },
    { key: "label", label: "Name", hint: "how it is shown in Wisp — short is best", placeholder: "the command itself", required: false },
    { key: "cwd", label: "In folder", hint: "relative to the project", placeholder: "the project's folder", required: false },
    {
      key: "restart",
      label: "If it stops",
      hint: "brought back with a growing pause, up to 10 times in a row",
      required: false,
      choices: [
        { value: "no", label: "leave it" },
        { value: "on-failure", label: "restart if it crashed" },
        { value: "always", label: "always restart" },
      ],
    },
  ],
  compose: [
    { key: "compose", label: "Compose file", hint: "relative to the project", placeholder: "compose.yaml", required: true },
    { key: "services", label: "Services", hint: "comma separated", placeholder: "all of them", required: false },
  ],
  wait: [{ key: "wait", label: "Wait for", hint: "a website (http://…), a port (5432), or seconds (5s)", placeholder: "http://localhost:3000", required: true }],
  url: [
    { key: "url", label: "Address", hint: "a bare host works too", placeholder: "http://localhost:3000", required: true },
    { key: "label", label: "Name", hint: "how it is shown in Wisp", placeholder: "the address", required: false },
  ],
  folder: [
    { key: "folder", label: "Folder", hint: "relative to the project", placeholder: "apps/api", required: true },
    { key: "label", label: "Name", hint: "how it is shown in Wisp", placeholder: "the path", required: false },
  ],
  file: [
    { key: "file", label: "File", hint: "relative to the project", placeholder: "README.md", required: true },
    { key: "label", label: "Name", hint: "how it is shown in Wisp", placeholder: "the path", required: false },
  ],
  app: [
    { key: "app", label: "App", hint: "its name — or a command on Linux, like code", placeholder: "Slack", required: true },
    { key: "label", label: "Name", hint: "how it is shown in Wisp", placeholder: "the app's name", required: false },
  ],
  bolt: [
    { key: "bolt", label: "Bolt", hint: "the bolt to run before this one's next step", placeholder: "Database", required: true },
    { key: "workspace", label: "In workspace", hint: "another workspace's bolt", placeholder: "this one", required: false },
  ],
};

/** The kind of a written step, for a form to open on. */
export function stepKindOf(step: RawStep): StepKindName | "shared" {
  if (typeof step === "string") return "shared";
  for (const { kind } of STEP_KINDS) if (step[kind] !== undefined) return kind;
  return "shared";
}

/** A form's values for an existing step, as text. */
export function stepValues(step: RawStep): Record<string, string> {
  if (typeof step === "string") return {};
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(step)) {
    if (typeof value === "string" || typeof value === "number") values[key] = String(value);
    else if (Array.isArray(value)) values[key] = value.join(", ");
    else if (key === "wait" && typeof value === "object" && value) {
      const wait = value as Record<string, unknown>;
      values[key] = String(wait["url"] ?? (wait["port"] ? `${wait["host"] ?? "localhost"}:${wait["port"]}` : `${wait["seconds"]}s`));
    }
  }
  return values;
}

/**
 * A step from a form's values, checked. Errors are said per field, in words that say what
 * to put there instead.
 */
export function buildStep(kind: StepKindName, values: Record<string, string>): { step?: Record<string, unknown>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const value = (key: string) => values[key]?.trim() ?? "";

  for (const field of STEP_FIELDS[kind]) {
    if (field.required && !value(field.key)) errors[field.key] = `${field.label} is needed`;
  }

  const step: Record<string, unknown> = {};
  if (kind === "wait") {
    const raw = value("wait");
    const wait = /^\d+(\.\d+)?$/.test(raw) && Number(raw) < 1000 ? Number(raw) : raw;
    if (raw && !parseWait(wait)) errors["wait"] = "Not something Wisp can wait for — try http://localhost:3000, 5432 or 5s";
    step["wait"] = wait;
  } else if (kind === "compose") {
    step["compose"] = value("compose");
    const services = value("services").split(",").map((service) => service.trim()).filter(Boolean);
    if (services.length > 0) step["services"] = services;
  } else if (kind === "url") {
    const url = value("url");
    try {
      if (url) new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    } catch {
      errors["url"] = "That doesn't look like a web address";
    }
    step["url"] = url;
  } else {
    for (const field of STEP_FIELDS[kind]) {
      const text = value(field.key);
      if (!text || field.key === "label") continue;
      // A choice at its default says nothing, so it is not written.
      if (field.key === "restart" && text === "no") continue;
      step[field.key] = text;
    }
  }

  const label = value("label");
  if (label && STEP_FIELDS[kind].some((field) => field.key === "label")) step["label"] = label;
  return Object.keys(errors).length > 0 ? { errors } : { step, errors };
}

/** A written step as a sentence, for the editor's list. */
export function describeRawStep(step: RawStep): string {
  if (typeof step === "string") return `${step} (shared)`;
  const label = typeof step["label"] === "string" ? step["label"] : undefined;
  const kind = stepKindOf(step);
  switch (kind) {
    case "run": {
      const where = typeof step["cwd"] === "string" ? ` in ${step["cwd"]}` : "";
      const run = typeof step["run"] === "string" ? step["run"] : "a command";
      return label && label !== run ? `run ${label} — ${run}${where}` : `run ${run}${where}`;
    }
    case "compose": {
      const services = Array.isArray(step["services"]) ? ` (${(step["services"] as string[]).join(", ")})` : "";
      return `start Docker services${services} from ${String(step["compose"])}`;
    }
    case "wait":
      return typeof step["wait"] === "number" ? `wait ${step["wait"]}s` : `wait for ${stepValues(step)["wait"] ?? "…"}`;
    case "url":
      return `open ${label ?? String(step["url"])}`;
    case "folder":
      return `open the ${label ?? String(step["folder"])} folder`;
    case "file":
      return `open ${label ?? String(step["file"])}`;
    case "app":
      return `open ${label ?? String(step["app"])}`;
    case "bolt":
      return `⚡ ${String(step["bolt"])} first${typeof step["workspace"] === "string" ? ` (from ${step["workspace"]})` : ""}`;
    default:
      return "…";
  }
}

/** The file a bolt is written in: the project's own, or its local override. */
async function locate(file: string, bolt?: string): Promise<{ path: string; raw: Record<string, unknown> }> {
  const main = await readRaw(file);
  if (!bolt) return { path: file, raw: main };
  if (findBolt(main, bolt) >= 0) return { path: file, raw: main };
  const localPath = localFileFor(file);
  const local = await readRaw(localPath).catch(() => undefined);
  if (local && findBolt(local, bolt) >= 0) return { path: localPath, raw: local };
  throw new WispError(`No bolt called "${bolt}" in ${file}`, "NOT_FOUND");
}

async function readRaw(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new WispError(`Could not read ${file}: ${describe(error)}`, "PROJECT_READ_FAILED");
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WispError(`${file} does not contain an object`, "PROJECT_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function findBolt(raw: Record<string, unknown>, label: string): number {
  const bolts = Array.isArray(raw["bolts"]) ? (raw["bolts"] as RawBolt[]) : [];
  return bolts.findIndex((bolt) => typeof bolt?.label === "string" && bolt.label.toLowerCase() === label.toLowerCase());
}

const ORDER = ["$schema", "name", "icon", "color", "notes", "links", "folders", "files", "apps", "commands", "bolts"];

/**
 * Write a file back, laid out by hand as `init` does — and keep trust when it was there:
 * the person changing it is the person who trusted it, and they just saw the change.
 */
async function save(file: string, raw: Record<string, unknown>, trustFile: string): Promise<void> {
  const before = await readProjectFile(trustFile).catch(() => undefined);
  const keys = [...ORDER.filter((key) => key in raw), ...Object.keys(raw).filter((key) => !ORDER.includes(key))];
  await writeFile(file, formatProjectFile(keys.map((key) => [key, raw[key]])), "utf8");
  if (before && !before.workspace.personal && before.trust === "trusted") await trustProject(trustFile);
}

export interface WorkspaceDetails {
  name: string;
  icon: string;
  notes: string;
}

export async function setWorkspaceDetails(file: string, details: WorkspaceDetails): Promise<void> {
  const name = details.name.trim();
  if (!name) throw new WispError("A workspace needs a name", "INVALID_INPUT");
  const before = (await readProjectFile(file)).workspace;
  const main = await readRaw(file);
  const local = before.local ? await readRaw(before.local) : undefined;
  const now: Record<keyof WorkspaceDetails, string> = { name, icon: details.icon.trim(), notes: details.notes.trim() };
  const was: Record<keyof WorkspaceDetails, string> = { name: before.name, icon: before.icon ?? "", notes: before.notes ?? "" };
  let mainChanged = false;
  let localChanged = false;
  for (const key of ["name", "icon", "notes"] as const) {
    if (now[key] === was[key]) continue;
    const inLocal = local !== undefined && key in local;
    const target = inLocal ? local : main;
    if (now[key]) target[key] = now[key];
    else delete target[key];
    if (inLocal) localChanged = true;
    else mainChanged = true;
  }
  if (local && localChanged && before.local) await save(before.local, local, file);
  if (mainChanged) await save(file, main, file);
}

/** Apply a change to one bolt, wherever it is written. */
export async function changeBolt(file: string, bolt: string, change: (bolt: RawBolt) => RawBolt | undefined): Promise<void> {
  const { path, raw } = await locate(file, bolt);
  const bolts = [...((raw["bolts"] as RawBolt[]) ?? [])];
  const index = findBolt(raw, bolt);
  const next = change({ ...(bolts[index] as RawBolt), targets: [...((bolts[index] as RawBolt).targets ?? [])] });
  if (next) bolts[index] = next;
  else bolts.splice(index, 1);
  await save(path, { ...raw, bolts }, file);
}

export async function addBolt(file: string, label: string, options: { job?: boolean } = {}): Promise<void> {
  const name = label.trim();
  if (!name) throw new WispError("A bolt needs a name", "INVALID_INPUT");
  const raw = await readRaw(file);
  if (findBolt(raw, name) >= 0) throw new WispError(`There is already a bolt called "${name}"`, "DUPLICATE_NAME");
  const existing = (raw["bolts"] as RawBolt[]) ?? [];
  // A colour of its own, so it is told apart from its neighbours at a glance.
  const color = pickColor(existing.map((bolt) => bolt.color));
  const bolts = [...existing, { label: name, color, ...(options.job ? { job: true } : {}), targets: [] }];
  await save(file, { ...raw, bolts }, file);
}

export async function renameBolt(file: string, bolt: string, label: string): Promise<void> {
  const name = label.trim();
  if (!name) throw new WispError("A bolt needs a name", "INVALID_INPUT");
  if (name.toLowerCase() !== bolt.toLowerCase() && findBolt(await readRaw(file), name) >= 0) {
    throw new WispError(`There is already a bolt called "${name}"`, "DUPLICATE_NAME");
  }
  await changeBolt(file, bolt, (current) => ({ ...current, label: name }));
}

export async function setBoltNotes(file: string, bolt: string, notes: string): Promise<void> {
  const text = notes.trim();
  await changeBolt(file, bolt, (current) => {
    const { label, notes: _notes, ...rest } = current;
    return text ? { label, notes: text, ...rest } : { label, ...rest };
  });
}

export async function removeBolt(file: string, bolt: string): Promise<void> {
  await changeBolt(file, bolt, () => undefined);
}

export async function moveBolt(file: string, bolt: string, by: -1 | 1): Promise<void> {
  const raw = await readRaw(file);
  const bolts = [...((raw["bolts"] as RawBolt[]) ?? [])];
  const index = findBolt(raw, bolt);
  const to = index + by;
  if (index < 0 || to < 0 || to >= bolts.length) return;
  [bolts[index], bolts[to]] = [bolts[to] as RawBolt, bolts[index] as RawBolt];
  await save(file, { ...raw, bolts }, file);
}

export async function setJob(file: string, bolt: string, job: boolean): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const { job: _job, ...rest } = current;
    return job ? { ...rest, label: current.label, job: true, targets: current.targets } : { ...rest, label: current.label, targets: current.targets };
  });
}

/** A bolt as written, for the editor to show. */
export async function readBolt(file: string, bolt: string): Promise<RawBolt> {
  const { raw } = await locate(file, bolt);
  const found = (raw["bolts"] as RawBolt[])[findBolt(raw, bolt)] as RawBolt;
  return { ...found, targets: [...(found.targets ?? [])] };
}

/** The steps of a bolt as written, for the editor to list. */
export async function boltSteps(file: string, bolt: string): Promise<RawStep[]> {
  return (await readBolt(file, bolt)).targets;
}

export async function addStep(file: string, bolt: string, step: RawStep, at?: number): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const targets = [...current.targets];
    targets.splice(at ?? targets.length, 0, step);
    return { ...current, targets };
  });
}

export async function replaceStep(file: string, bolt: string, index: number, step: RawStep): Promise<void> {
  await changeBolt(file, bolt, (current) => ({ ...current, targets: current.targets.map((entry, at) => (at === index ? step : entry)) }));
}

export async function removeStep(file: string, bolt: string, index: number): Promise<void> {
  await changeBolt(file, bolt, (current) => ({ ...current, targets: current.targets.filter((_entry, at) => at !== index) }));
}

export async function moveStep(file: string, bolt: string, index: number, by: -1 | 1): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const targets = [...current.targets];
    const to = index + by;
    if (to < 0 || to >= targets.length) return current;
    [targets[index], targets[to]] = [targets[to] as RawStep, targets[index] as RawStep];
    return { ...current, targets };
  });
}

/**
 * A personal workspace: the same format, kept in Wisp's own directory, for the things
 * that belong to no repository — "Morning", "On call".
 */
/**
 * Delete one of your own workspaces. Only those: a project's .wisp.json belongs to its
 * repository, and is never Wisp's to delete (it can only stop listing it).
 */
export async function removePersonalWorkspace(file: string): Promise<void> {
  const path = resolve(file);
  if (dirname(path) !== resolve(workspacesDir())) {
    throw new WispError("Only your own workspaces can be deleted. A project's file stays in its repository", "INVALID_INPUT");
  }
  await rm(path);
}

export async function createPersonalWorkspace(name: string): Promise<string> {
  const title = name.trim();
  if (!title) throw new WispError("A workspace needs a name", "INVALID_INPUT");
  const fileName = `${title.replace(/[\\/:*?"<>|]+/g, "-")}.wisp.json`;
  const file = join(workspacesDir(), fileName);
  const exists = await readFile(file).then(() => true).catch(() => false);
  if (exists) throw new WispError(`There is already a workspace called "${title}"`, "DUPLICATE_NAME");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspacesDir(), { recursive: true });
  // Its own colour too, apart from the workspaces you already have.
  const { loadWorkspaces } = await import("./workspaces.js");
  const others = await loadWorkspaces().catch(() => []);
  const color = pickColor(others.map((workspace) => workspace.color));
  await writeFile(
    file,
    formatProjectFile([["$schema", PROJECT_SCHEMA_URL], ["name", title], ["color", color], ["bolts", []]]),
    "utf8",
  );
  return file;
}
