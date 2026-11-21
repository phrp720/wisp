import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parseDuration } from "./duration.js";
import { WispError, describe } from "./errors.js";
import { INPUT_NAME } from "./inputs.js";
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

/** A step as it is written in the file. */
export type RawStep = Record<string, unknown>;

export interface RawBolt {
  label: string;
  notes?: string;
  keepGoing?: boolean;
  confirm?: string | boolean;
  inputs?: Record<string, RawInput>;
  color?: string;
  targets: RawStep[];
  down?: RawStep[];
  [key: string]: unknown;
}

export interface RawInput {
  ask?: string;
  choices?: (string | number)[];
  default?: string | number;
}

const BOLT_ORDER = ["label", "notes", "color", "keepGoing", "confirm", "inputs", "targets", "down"];

function tidyBolt(bolt: RawBolt): RawBolt {
  const known = BOLT_ORDER.filter((key) => bolt[key] !== undefined).map((key) => [key, bolt[key]]);
  const rest = Object.entries(bolt).filter(([key]) => !BOLT_ORDER.includes(key));
  return Object.fromEntries([...known, ...rest]) as RawBolt;
}

/**
 * The kinds of step a form can make, grouped the way a person looks for them — something to
 * start, something to wait for, something to open — each with an icon and a few examples.
 */
export const STEP_KINDS = [
  { kind: "run", group: "Start", icon: "💻", title: "Run a command", example: "pnpm dev, make test, ./deploy.sh" },
  { kind: "compose", group: "Start", icon: "🐳", title: "Start Docker services", example: "a database, a cache — from a compose file" },
  { kind: "bolt", group: "Start", icon: "⚡", title: "Run a bolt", example: "the database, before the API" },
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
  when?: (values: Record<string, string>) => boolean;
  guess?: (values: Record<string, string>) => string | undefined;
}

const FINISHING = /(?<![a-z])(build|test|tests|lint|check|typecheck|tsc|format|fmt|migrate|seed|deploy|release|publish|backup|dump|restore|install|ci|clean|compile|bundle|generate)(?![a-z])/;
const RUNNING = /(?<![a-z])(dev|start|serve|server|up|run|watch)(?![a-z])/;

export function guessFinishes(command: string): "running" | "finishes" | undefined {
  const text = command.toLowerCase();
  if (!text.trim()) return undefined;
  if (/(?<![a-z])watch(?![a-z])|--watch/.test(text)) return "running";
  if (/(?<![a-z])up(?![a-z])/.test(text) && /\s(-d|--detach)(\s|$)/.test(text)) return "finishes";
  if (FINISHING.test(text)) return "finishes";
  if (RUNNING.test(text)) return "running";
  return undefined;
}

/** What each kind of step asks for. The first field is the one that matters. */
export const STEP_FIELDS: Record<StepKindName, StepField[]> = {
  run: [
    { key: "run", label: "Command", hint: "what you would type in a terminal", placeholder: "pnpm dev", required: true },
    {
      key: "finishes",
      label: "It",
      hint: "a server keeps running; a test or a build finishes",
      required: false,
      choices: [
        { value: "running", label: "keeps running" },
        { value: "finishes", label: "finishes" },
      ],
      guess: (values) => guessFinishes(values["run"] ?? ""),
    },
    { key: "label", label: "Name", hint: "how it is shown in Wisp — short is best", placeholder: "the command itself", required: false },
    { key: "cwd", label: "In folder", hint: "relative to the project", placeholder: "the project's folder", required: false },
    {
      key: "timeout",
      label: "Timeout",
      hint: "if it takes longer, Wisp stops it and the step fails: 30s, 10m, 1h",
      placeholder: "none",
      required: false,
      when: (values) => values["finishes"] === "finishes",
    },
    {
      key: "restart",
      label: "Restart",
      hint: "up to 10 times in a row, waiting longer each time",
      required: false,
      when: (values) => values["finishes"] !== "finishes",
      choices: [
        { value: "no", label: "never" },
        { value: "on-failure", label: "if it crashes" },
        { value: "always", label: "always" },
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
    { key: "bolt", label: "Bolt", hint: "a bolt of this workspace; steps that depend on it wait for all of it", placeholder: "Database", required: true },
    { key: "label", label: "Name", hint: "what other steps depend on", placeholder: "the bolt's name", required: false },
  ],
};

/** The kind of a written step, for a form to open on. */
export function stepKindOf(step: RawStep): StepKindName | undefined {
  for (const { kind } of STEP_KINDS) if (step[kind] !== undefined) return kind;
  return undefined;
}

/** A form's values for an existing step, as text. */
export function stepValues(step: RawStep): Record<string, string> {
  const values: Record<string, string> = {};
  if (step["run"] !== undefined) values["finishes"] = step["finishes"] === true ? "finishes" : "running";
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
      if (field.key === "finishes") {
        if (text === "finishes") step["finishes"] = true;
        continue;
      }
      // A choice at its default says nothing, so it is not written.
      if (field.key === "restart" && (text === "no" || value("finishes") === "finishes")) continue;
      if (field.key === "timeout") {
        if (value("finishes") !== "finishes") continue;
        if (parseDuration(text) === undefined) errors["timeout"] = "A timeout is a number of seconds, or like 30s, 10m or 1h";
        step["timeout"] = /^\d+(\.\d+)?$/.test(text) ? Number(text) : text;
        continue;
      }
      step[field.key] = text;
    }
  }

  const label = value("label");
  if (label && STEP_FIELDS[kind].some((field) => field.key === "label")) step["label"] = label;
  return Object.keys(errors).length > 0 ? { errors } : { step, errors };
}

/** A written step as a sentence, for the editor's list. */
export function describeRawStep(step: RawStep): string {
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
      return `run the ${String(step["bolt"])} bolt`;
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

const ORDER = ["$schema", "name", "icon", "color", "notes", "bolts"];

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
  if (next) bolts[index] = tidyBolt(next);
  else bolts.splice(index, 1);
  await save(path, { ...raw, bolts }, file);
}

export async function addBolt(file: string, label: string): Promise<void> {
  const name = label.trim();
  if (!name) throw new WispError("A bolt needs a name", "INVALID_INPUT");
  const raw = await readRaw(file);
  if (findBolt(raw, name) >= 0) throw new WispError(`There is already a bolt called "${name}"`, "DUPLICATE_NAME");
  const existing = (raw["bolts"] as RawBolt[]) ?? [];
  // A colour of its own, so it is told apart from its neighbours at a glance.
  const color = pickColor(existing.map((bolt) => bolt.color));
  const bolts = [...existing, { label: name, color, targets: [] }];
  await save(file, { ...raw, bolts }, file);
}

export async function renameBolt(file: string, bolt: string, label: string): Promise<void> {
  const name = label.trim();
  if (!name) throw new WispError("A bolt needs a name", "INVALID_INPUT");
  if (name.toLowerCase() !== bolt.toLowerCase() && findBolt(await readRaw(file), name) >= 0) {
    throw new WispError(`There is already a bolt called "${name}"`, "DUPLICATE_NAME");
  }
  const { path, raw } = await locate(file, bolt);
  const bolts = (raw["bolts"] as RawBolt[]) ?? [];
  const index = findBolt(raw, bolt);
  const old = (bolts[index] as RawBolt).label.toLowerCase();
  const runsIt = (step: RawStep) => typeof step["bolt"] === "string" && step["bolt"].toLowerCase() === old;
  const renamed = (steps: RawStep[]) => steps.map((step) => (runsIt(step) ? { ...step, bolt: name } : step));
  const next = bolts.map((entry, at) => {
    const pointing = entry.targets.some(runsIt) || (entry.down ?? []).some(runsIt);
    if (at !== index && !pointing) return entry;
    return tidyBolt({ ...entry, ...(at === index ? { label: name } : {}), targets: renamed(entry.targets), ...(entry.down ? { down: renamed(entry.down) } : {}) });
  });
  await save(path, { ...raw, bolts: next }, file);
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

export async function setConfirm(file: string, bolt: string, confirm: string | boolean): Promise<void> {
  const value = typeof confirm === "string" ? confirm.trim() || false : confirm;
  await changeBolt(file, bolt, (current) => {
    const { confirm: _confirm, ...rest } = current;
    return value === false ? rest : { ...rest, confirm: value };
  });
}

export function inputValues(name: string, input: RawInput): Record<string, string> {
  return { name, ask: input.ask ?? "", choices: (input.choices ?? []).join(", "), default: input.default === undefined ? "" : String(input.default) };
}

export function buildInput(values: Record<string, string>, taken: string[]): { name: string; input: RawInput } | { errors: Record<string, string> } {
  const name = (values["name"] ?? "").trim();
  const ask = (values["ask"] ?? "").trim();
  const choices = [...new Set((values["choices"] ?? "").split(",").map((choice) => choice.trim()).filter(Boolean))];
  const fallback = (values["default"] ?? "").trim();
  const errors: Record<string, string> = {};
  if (!INPUT_NAME.test(name)) errors["name"] = "letters, digits, - and _, starting with a letter";
  else if (taken.includes(name)) errors["name"] = `there is already an input called ${name}`;
  if (fallback && choices.length > 0 && !choices.includes(fallback)) errors["default"] = `one of ${choices.join(", ")}`;
  if (Object.keys(errors).length > 0) return { errors };
  return { name, input: { ...(ask ? { ask } : {}), ...(choices.length > 0 ? { choices } : {}), ...(fallback ? { default: fallback } : {}) } };
}

function renamePlaceholder<T>(value: T, from: string, to: string): T {
  const pattern = new RegExp(`\\{\\{\\s*${from.replace(/[-]/g, "\\-")}\\s*\\}\\}`, "g");
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return item.replace(pattern, `{{${to}}}`);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return walk(value) as T;
}

export async function setInput(file: string, bolt: string, previous: string | undefined, name: string, input: RawInput): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const entries = Object.entries(current.inputs ?? {});
    const at = previous === undefined ? -1 : entries.findIndex(([key]) => key === previous);
    if (at >= 0) entries[at] = [name, input];
    else entries.push([name, input]);
    const next = { ...current, inputs: Object.fromEntries(entries) };
    if (previous === undefined || previous === name) return next;
    return {
      ...next,
      targets: renamePlaceholder(next.targets, previous, name),
      ...(next.down ? { down: renamePlaceholder(next.down, previous, name) } : {}),
      ...(typeof next.confirm === "string" ? { confirm: renamePlaceholder(next.confirm, previous, name) } : {}),
    };
  });
}

export async function removeInput(file: string, bolt: string, name: string): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const { inputs, ...rest } = current;
    const left = Object.entries(inputs ?? {}).filter(([key]) => key !== name);
    return left.length > 0 ? { ...rest, inputs: Object.fromEntries(left) } : rest;
  });
}

export async function setKeepGoing(file: string, bolt: string, keepGoing: boolean): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const { keepGoing: _keepGoing, ...rest } = current;
    return keepGoing ? { ...rest, keepGoing: true } : rest;
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

function labelOf(step: RawStep): string | undefined {
  return typeof step["label"] === "string" && step["label"].trim() ? step["label"].trim() : undefined;
}

export function afterOf(step: RawStep): string[] {
  const after = step["after"];
  return typeof after === "string" ? [after] : Array.isArray(after) ? after.filter((name): name is string => typeof name === "string") : [];
}

function withAfter(step: RawStep, names: string[]): RawStep {
  const { after: _after, ...rest } = step;
  return names.length === 0 ? rest : { ...rest, after: names.length === 1 ? (names[0] as string) : names };
}

function renamed(targets: RawStep[], from: string, to: string | undefined): RawStep[] {
  return targets.map((step) => {
    const names = afterOf(step);
    if (!names.includes(from)) return step;
    return withAfter(step, to === undefined ? names.filter((name) => name !== from) : names.map((name) => (name === from ? to : name)));
  });
}

export function suggestLabel(step: RawStep, taken: string[]): string {
  const words = (value: unknown) => String(value ?? "").split(/\s+/).filter((word) => word && !word.startsWith("-"));
  const base =
    step["bolt"] !== undefined
      ? String(step["bolt"]).toLowerCase()
      : step["run"] !== undefined
      ? (words(step["run"]).pop() ?? "command")
      : step["wait"] !== undefined
        ? "ready"
        : step["compose"] !== undefined
          ? "services"
          : String(step["url"] ?? step["folder"] ?? step["file"] ?? step["app"] ?? "step")
              .replace(/^https?:\/\//, "")
              .split(/[/?#]/)[0] || "step";
  let name = base;
  for (let count = 2; taken.includes(name); count += 1) name = `${base} ${count}`;
  return name;
}

export async function addStep(file: string, bolt: string, step: RawStep, at?: number): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const targets = [...current.targets];
    targets.splice(at ?? targets.length, 0, step);
    return { ...current, targets };
  });
}

export async function replaceStep(file: string, bolt: string, index: number, step: RawStep): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const before = current.targets[index];
    const kept = withAfter(step, before ? afterOf(before) : []);
    const from = before ? labelOf(before) : undefined;
    const to = labelOf(kept);
    const targets = current.targets.map((entry, at) => (at === index ? kept : entry));
    return { ...current, targets: from && from !== to ? renamed(targets, from, to) : targets };
  });
}

export async function removeStep(file: string, bolt: string, index: number): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const gone = current.targets[index];
    const targets = current.targets.filter((_entry, at) => at !== index);
    const name = gone ? labelOf(gone) : undefined;
    return { ...current, targets: name ? renamed(targets, name, undefined) : targets };
  });
}

export async function moveStep(file: string, bolt: string, index: number, by: -1 | 1): Promise<number> {
  let at = index;
  await changeBolt(file, bolt, (current) => {
    const targets = [...current.targets];
    const to = index + by;
    if (to < 0 || to >= targets.length) return current;
    [targets[index], targets[to]] = [targets[to] as RawStep, targets[index] as RawStep];
    at = to;
    return { ...current, targets };
  });
  return at;
}

export async function setAfter(file: string, bolt: string, index: number, on: number[]): Promise<void> {
  await changeBolt(file, bolt, (current) => {
    const targets = [...current.targets];
    const taken = targets.flatMap((step) => (labelOf(step) ? [labelOf(step) as string] : []));
    const names = on
      .filter((at) => at !== index && targets[at] !== undefined)
      .map((at) => {
        const step = targets[at] as RawStep;
        const existing = labelOf(step);
        if (existing) return existing;
        const name = suggestLabel(step, taken);
        taken.push(name);
        targets[at] = { ...step, label: name };
        return name;
      });
    const step = targets[index];
    if (!step) return current;
    targets[index] = withAfter(step, names);
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
