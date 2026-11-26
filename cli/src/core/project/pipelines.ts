import { SLUG, pipelineSlug } from "../workspaces.js";
import { INPUT_NAME, INPUT_VALUE, envNames, notPlain, placeholders } from "../inputs.js";
import type { Pipeline, PipelineStep, InputSpec, WaitSpec } from "../types.js";
import { type Context, type Entry, inlineKind } from "./context.js";
import { osName } from "./os.js";
import { absolute, isRecord, optionalString, stepAddress } from "./values.js";

const PIPELINE_KEYS = new Set(["label", "slug", "notes", "color", "keepGoing", "confirm", "inputs", "steps", "down"]);

const INPUT_KEYS = new Set(["ask", "choices", "default"]);

/** Seconds a wait gives up after, unless it says otherwise. */
const DEFAULT_WAIT_TIMEOUT = 60;

/**
 * Pipelines, with their steps: something to open or run, a wait, or another pipeline to run first.
 * A pipeline in the override replaces the project's pipeline of the same name, which is how you
 * make a shared pipeline your own.
 */
export function pipelines(entries: Entry[], ctx: Context): Pipeline[] {
  const result: Pipeline[] = [];
  const index = new Map<string, number>();
  const skippedSteps = new Map<string, number>();

  for (const { value: entry, at } of entries) {
    if (!isRecord(entry)) {
      ctx.found.push({ level: "error", at, message: "dropped: not an object" });
      continue;
    }

    const label = optionalString(entry["label"]);
    if (!label) {
      ctx.found.push({ level: "error", at, message: 'dropped: no "label"' });
      continue;
    }

    const id = `pipeline:${label.toLowerCase()}`;
    const existing = index.get(id);
    const fromLocal = at.startsWith("local ");
    if (existing !== undefined && !fromLocal) {
      ctx.found.push({ level: "error", at: `${at}.label`, message: `dropped: a second pipeline called "${label}"` });
      continue;
    }

    const listed = Array.isArray(entry["steps"]) ? (entry["steps"] as unknown[]) : [];
    if (!Array.isArray(entry["steps"])) {
      ctx.found.push({ level: "warning", at: `${at}.steps`, message: `"${label}" names nothing to open` });
    }

    const { steps, skipped, broken } = parseSteps(listed, `${at}.steps`, ctx);

    if (steps.length === 0 && listed.length > 0 && skipped === 0) {
      ctx.found.push({ level: "error", at, message: `"${label}" resolved to nothing — running it would open nothing` });
    }
    if (steps.length === 0 && skipped > 0) {
      ctx.found.push({ level: "note", at, message: `"${label}" opens nothing on ${osName(ctx.os)}` });
    }
    skippedSteps.set(id, skipped);

    const pipeline: Pipeline = { id, label, steps, ...(broken ? { broken: `"${label}" can't run: ${broken}` } : {}) };
    const notes = optionalString(entry["notes"]);
    if (notes) pipeline.notes = notes;
    const slug = optionalString(entry["slug"]);
    if (slug && SLUG.test(slug)) pipeline.slug = slug;
    else if (slug) ctx.found.push({ level: "warning", at: `${at}.slug`, message: `"${slug}" is not a slug, so it is ignored`, hint: "Lowercase letters, digits and hyphens, like dev-stack" });
    const color = optionalString(entry["color"]);
    if (color) pipeline.color = color;

    for (const key of Object.keys(entry)) {
      if (PIPELINE_KEYS.has(key)) continue;
      ctx.found.push({ level: "warning", at: `${at}.${key}`, message: `"${key}" is not something a pipeline can set — it is ignored`, hint: `Known keys: ${[...PIPELINE_KEYS].join(", ")}` });
    }

    if (entry["confirm"] !== undefined) {
      if (entry["confirm"] === true) pipeline.confirm = `Run "${label}"?`;
      else if (typeof entry["confirm"] === "string" && entry["confirm"].trim()) pipeline.confirm = entry["confirm"].trim();
      else if (entry["confirm"] !== false) {
        ctx.found.push({ level: "warning", at: `${at}.confirm`, message: '"confirm" is the question to ask before it runs, or true — it is ignored' });
      }
    }

    if (entry["inputs"] !== undefined) {
      const inputs = parseInputs(entry["inputs"], `${at}.inputs`, ctx);
      if (inputs.length > 0) pipeline.inputs = inputs;
    }
    const declared = new Set((pipeline.inputs ?? []).map((input) => input.name));
    const undeclared = (text: string, where: string, address?: string) => {
      const inAddress = new Set(address ? placeholders(address) : []);
      for (const name of new Set(placeholders(text))) {
        if (declared.has(name)) continue;
        const hint = `Add it to the pipeline: "inputs": { "${name}": { "ask": "…" } }`;
        if (inAddress.has(name)) ctx.found.push({ level: "error", at: where, message: `{{${name}}} is not one of "${label}"'s inputs, so "${address}" can't be opened`, hint });
        else ctx.found.push({ level: "warning", at: where, message: `{{${name}}} is not one of "${label}"'s inputs — it is left as written`, hint });
      }
    };
    if (pipeline.confirm) undeclared(pipeline.confirm, `${at}.confirm`);
    for (const key of ["steps", "down"]) {
      const list = Array.isArray(entry[key]) ? (entry[key] as unknown[]) : [];
      list.forEach((step, position) => undeclared(JSON.stringify(step), `${at}.${key}[${position}]`, stepAddress(step)));
    }

    if (entry["keepGoing"] !== undefined) {
      if (typeof entry["keepGoing"] === "boolean") {
        if (entry["keepGoing"]) pipeline.keepGoing = true;
      } else {
        ctx.found.push({ level: "warning", at: `${at}.keepGoing`, message: '"keepGoing" must be true or false — it is ignored' });
      }
    }

    // What `wisp down` runs after stopping what the pipeline started: the teardown that is
    // not a process Wisp can stop, like `docker compose stop`.
    if (entry["down"] !== undefined) {
      if (Array.isArray(entry["down"])) {
        const parsed = parseSteps(entry["down"] as unknown[], `${at}.down`, ctx);
        const down = parsed.steps;
        if (parsed.broken && !pipeline.broken) pipeline.broken = `"${label}" can't be taken down: ${parsed.broken}`;
        if (down.length > 0) pipeline.down = down;
      } else {
        ctx.found.push({ level: "error", at: `${at}.down`, message: '"down" must be a list of steps — it was ignored' });
      }
    }

    if (existing !== undefined) {
      result[existing] = pipeline;
    } else {
      index.set(id, result.length);
      result.push(pipeline);
    }
  }

  checkDependencies(result, ctx);
  checkSlugs(result, ctx);
  return result;
}

function parseInputs(value: unknown, at: string, ctx: Context): InputSpec[] {
  const warn = (where: string, message: string) => ctx.found.push({ level: "warning", at: where, message });
  if (!isRecord(value)) {
    warn(at, '"inputs" names each value the pipeline asks for, like { "env": { "ask": "Deploy where?" } } — it is ignored');
    return [];
  }
  const word = (item: unknown) => (typeof item === "string" || typeof item === "number" ? String(item).trim() : "");
  const specs: InputSpec[] = [];
  for (const [name, raw] of Object.entries(value)) {
    const where = `${at}.${name}`;
    if (!INPUT_NAME.test(name)) {
      warn(where, `"${name}" can't name an input: use letters, digits, - and _, starting with a letter — it is ignored`);
      continue;
    }
    if (!isRecord(raw)) {
      warn(where, `${name} is described by an object, like { "ask": "Deploy where?" } — it is ignored`);
      continue;
    }
    const spec: InputSpec = { name, ask: optionalString(raw["ask"]) ?? name };
    if (raw["choices"] !== undefined) {
      const listed = Array.isArray(raw["choices"]) ? [...new Set(raw["choices"].map(word).filter(Boolean))] : [];
      const choices = listed.filter((choice) => INPUT_VALUE.test(choice));
      for (const choice of listed.filter((entry) => !choices.includes(entry))) warn(`${where}.choices`, `${notPlain(name, choice)} — it is left out`);
      if (choices.length > 0) spec.choices = choices;
      else if (listed.length === 0) warn(`${where}.choices`, `"choices" is a list of the values to pick from — it is ignored`);
    }
    if (raw["default"] !== undefined) {
      const fallback = word(raw["default"]);
      if (!fallback) warn(`${where}.default`, `"default" is the value used when none is given — it is ignored`);
      else if (!INPUT_VALUE.test(fallback)) warn(`${where}.default`, `${notPlain(name, fallback)} — it is ignored`);
      else if (spec.choices && !spec.choices.includes(fallback)) warn(`${where}.default`, `"${fallback}" is not one of its choices — it is ignored`);
      else spec.default = fallback;
    }
    for (const key of Object.keys(raw)) {
      if (!INPUT_KEYS.has(key)) warn(`${where}.${key}`, `"${key}" is not something an input can set — it is ignored`);
    }
    specs.push(spec);
  }
  return specs;
}

/** One list of steps: a pipeline's `steps` or its `down`. */
function parseSteps(listed: unknown[], at: string, ctx: Context): { steps: PipelineStep[]; skipped: number; broken?: string } {
  const steps: PipelineStep[] = [];
  let skipped = 0;
  const declared: { name?: string; after: string[]; where: string }[] = [];

  for (const [position, target] of listed.entries()) {
    const where = `${at}[${position}]`;
    if (!isRecord(target)) {
      ctx.found.push({ level: "error", at: where, message: 'dropped: a step is an object, like { "run": "pnpm dev" } or { "url": "localhost:3000" }' });
      continue;
    }
    const name = optionalString(target["label"]);
    const after = readAfter(target["after"], `${where}.after`, ctx);
    declared.push({ ...(name ? { name } : {}), after: after ?? [], where });
    const extra = { ...(name ? { name } : {}), ...(after && after.length > 0 ? { after } : {}) };

    if (inlineKind(target)) {
      const inlineId = ctx.idsByAt.get(where);
      if (!inlineId) continue;
      if (ctx.elsewhere.has(inlineId)) {
        skipped += 1;
        continue;
      }
      steps.push({ kind: "asset", id: inlineId, ...extra });
      continue;
    }

    const step = specialStep(target, where, ctx);
    if (step) steps.push({ ...step, ...extra });
  }

  const broken = checkAfter(declared, ctx);
  return { steps, skipped, ...(broken ? { broken } : {}) };
}

function readAfter(value: unknown, at: string, ctx: Context): string[] | undefined {
  if (value === undefined) return undefined;
  const listed = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  const names = listed?.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim());
  if (!names || names.length !== (listed?.length ?? -1)) {
    ctx.found.push({ level: "error", at, message: '"after" names the steps this one waits for, by their label: "after": "install" or ["lint", "test"]' });
    return undefined;
  }
  return [...new Set(names)];
}

function checkAfter(steps: { name?: string; after: string[]; where: string }[], ctx: Context): string | undefined {
  let broken: string | undefined;
  const fail = (at: string, message: string) => {
    ctx.found.push({ level: "error", at, message });
    broken ??= message;
  };
  const count = new Map<string, number>();
  for (const step of steps) if (step.name) count.set(step.name, (count.get(step.name) ?? 0) + 1);
  for (const step of steps) {
    for (const name of step.after) {
      if (name === step.name) fail(`${step.where}.after`, `"${name}" can't wait for itself`);
      else if (!count.has(name)) fail(`${step.where}.after`, `waits for "${name}", but no step has that label`);
      else if ((count.get(name) ?? 0) > 1) fail(`${step.where}.after`, `waits for "${name}", but more than one step has that label`);
    }
  }
  if (broken) return broken;

  const byName = new Map(steps.flatMap((step) => (step.name ? [[step.name, step] as const] : [])));
  const state = new Map<object, "visiting" | "done">();
  const visit = (step: (typeof steps)[number], path: string[]): void => {
    if (state.get(step) === "done") return;
    if (state.get(step) === "visiting") {
      const cycle = [...path.slice(path.indexOf(step.name ?? "")), step.name ?? ""];
      fail(step.where, `these steps wait for each other: ${cycle.join(" → ")}`);
      return;
    }
    state.set(step, "visiting");
    for (const name of step.after) {
      const next = byName.get(name);
      if (next) visit(next, [...path, step.name ?? ""]);
    }
    state.set(step, "done");
  };
  for (const step of steps) visit(step, []);
  return broken;
}

/** A step written as an object: `{ "wait": … }` or `{ "pipeline": … }`. */
function specialStep(target: Record<string, unknown>, at: string, ctx: Context): PipelineStep | undefined {
  if (target["wait"] !== undefined) {
    const wait = parseWait(target["wait"]);
    if (!wait) {
      ctx.found.push({
        level: "error",
        at,
        message: "dropped: a wait needs seconds, a port or a url",
        hint: 'e.g. { "wait": 5 }, { "wait": "localhost:5432" }, { "wait": { "url": "http://localhost:3000", "timeout": 90 } }',
      });
      return undefined;
    }
    const names = "url" in wait ? envNames(wait.url) : [];
    if (names.length > 0 && !ctx.trusted && "url" in wait) {
      const id = `wait:${at}`;
      ctx.withheld.push({ kind: "wait", id, label: `wait for ${wait.url}`, value: wait.url, reason: `reads ${names.map((name) => `$${name}`).join(", ")} from your environment` });
      return { kind: "wait", wait, held: id };
    }
    return { kind: "wait", wait };
  }

  const compose = optionalString(target["compose"]);
  if (compose) {
    const services = Array.isArray(target["services"])
      ? (target["services"] as unknown[]).filter((service): service is string => typeof service === "string" && !!service.trim())
      : [];
    const file = absolute(compose, ctx.root);
    // A compose file runs whatever images it names, with whatever of your disk it mounts:
    // as much code as a command, so it waits for trust the same way.
    if (!ctx.trusted && !ctx.withheld.some((item) => item.id === `compose:${file}`)) {
      const what = services.length > 0 ? `Docker services: ${services.join(", ")}` : "Docker services";
      ctx.withheld.push({ kind: "compose", id: `compose:${file}`, label: what, value: compose, reason: "starts containers" });
    }
    return { kind: "compose", file, ...(services.length > 0 ? { services } : {}) };
  }

  const pipeline = optionalString(target["pipeline"]);
  if (pipeline) {
    if (target["workspace"] !== undefined) {
      ctx.found.push({
        level: "error",
        at,
        message: `dropped: a pipeline step runs a pipeline of this file. To run "${pipeline}" from another project, run it as a command: { "run": "wisp use <its .wisp.json> ${pipeline}", "finishes": true }`,
      });
      return undefined;
    }
    return { kind: "pipeline", pipeline };
  }

  ctx.found.push({
    level: "error",
    at,
    message: 'dropped: a step needs one of "url", "folder", "file", "app", "run", "compose", "wait" or "pipeline"',
  });
  return undefined;
}

/**
 * A wait, however it was written.
 *
 * `5` waits five seconds. `"5432"` or `"db:5432"` waits for a port, `"http://…"` for a url
 * to answer. The object form says the same with a `timeout`.
 */
const WAIT_URL = /^(https?:\/\/|\{\{\s*(env\.)?[A-Za-z_][A-Za-z0-9_-]*\s*\}\})/i;

export function parseWait(value: unknown): WaitSpec | undefined {
  if (typeof value === "number") return value > 0 ? { seconds: value } : undefined;

  if (typeof value === "string") {
    const text = value.trim();
    if (WAIT_URL.test(text)) return { url: text, timeout: DEFAULT_WAIT_TIMEOUT };
    const port = /^(?:([\w.-]+):)?(\d{1,5})$/.exec(text);
    if (port) return { port: Number(port[2]), host: port[1] ?? "localhost", timeout: DEFAULT_WAIT_TIMEOUT };
    const seconds = /^(\d+(?:\.\d+)?)s$/.exec(text);
    if (seconds) return { seconds: Number(seconds[1]) };
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  const timeout =
    typeof value["timeout"] === "number" && value["timeout"] > 0 ? value["timeout"] : DEFAULT_WAIT_TIMEOUT;

  if (typeof value["url"] === "string" && WAIT_URL.test(value["url"].trim())) {
    const status = value["status"];
    return { url: value["url"], timeout, ...(Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599 ? { status: status as number } : {}) };
  }
  if (typeof value["port"] === "number" && value["port"] > 0 && value["port"] < 65536) {
    const host = optionalString(value["host"]) ?? "localhost";
    return { port: value["port"], host, timeout };
  }
  if (typeof value["seconds"] === "number" && value["seconds"] > 0) return { seconds: value["seconds"] };
  return undefined;
}

/**
 * Dependencies within this file: each must name a pipeline that exists, and no pipeline may end
 * up needing itself. Dependencies on other workspaces can only be checked when they run.
 */
function checkSlugs(pipelines: Pipeline[], ctx: Context): void {
  const seen = new Map<string, string>();
  for (const pipeline of pipelines) {
    const slug = pipelineSlug(pipeline);
    const other = seen.get(slug);
    if (other) ctx.found.push({ level: "warning", at: "pipelines", pipeline: pipeline.label, message: `"${other}" and "${pipeline.label}" both answer to ${slug}`, hint: 'Give one of them a different "slug": until then, neither runs by that name' });
    else seen.set(slug, pipeline.label);
  }
}

function checkDependencies(pipelines: Pipeline[], ctx: Context): void {
  const byLabel = new Map(pipelines.map((pipeline) => [pipeline.label.toLowerCase(), pipeline]));

  for (const pipeline of pipelines) {
    for (const step of pipeline.steps) {
      if (step.kind !== "pipeline") continue;
      if (!byLabel.has(step.pipeline.toLowerCase())) {
        ctx.found.push({
          level: "error",
          at: `pipelines`,
          pipeline: pipeline.label,
          message: `"${pipeline.label}" runs a pipeline called "${step.pipeline}", which this file does not declare`,
          hint: `Pick one of this file's pipelines, or add one called "${step.pipeline}"`,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const reported = new Set<string>();

  const visit = (pipeline: Pipeline, path: string[]): void => {
    if (done.has(pipeline.id)) return;
    if (visiting.has(pipeline.id)) {
      const cycle = [...path.slice(path.indexOf(pipeline.label)), pipeline.label];
      const key = [...cycle].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        ctx.found.push({
          level: "error",
          at: "pipelines",
          pipeline: cycle[0] as string,
          message: `these pipelines need each other: ${cycle.join(" → ")}`,
          hint: "Running any of them would be refused — remove one of the dependencies",
        });
      }
      return;
    }
    visiting.add(pipeline.id);
    for (const step of pipeline.steps) {
      if (step.kind !== "pipeline") continue;
      const next = byLabel.get(step.pipeline.toLowerCase());
      if (next) visit(next, [...path, pipeline.label]);
    }
    visiting.delete(pipeline.id);
    done.add(pipeline.id);
  };

  for (const pipeline of pipelines) visit(pipeline, []);
}
