import { WispError } from "./errors.js";
import type { InputSpec, SwitchTarget } from "./types.js";

export const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const INPUT_VALUE = /^(?!-)[\p{L}\p{N}._/:@+=,~-]+(?: +(?!-)[\p{L}\p{N}._/:@+=,~-]+)*$/u;
const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;
const ENCODED = /%7B%7B([A-Za-z][A-Za-z0-9_-]*)%7D%7D/gi;

const ENV_PLACEHOLDER = /\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export type InputValues = Record<string, string>;

export function envNames(text: string): string[] {
  return [...new Set([...text.matchAll(ENV_PLACEHOLDER)].map((match) => match[1] as string))];
}

export function fillEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const missing = envNames(text).filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    const names = missing.map((name) => `$${name}`).join(", ");
    throw new WispError(`${names} ${missing.length === 1 ? "isn't" : "aren't"} set here`, "INVALID_INPUT", "Set it where Wisp runs, like your shell profile or the crontab line");
  }
  return text.replace(ENV_PLACEHOLDER, (_whole, name: string) => (env[name] as string).trim());
}

export function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string);
}

export function fillText(text: string, values: InputValues): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

export function notPlain(name: string, value: string): string {
  return `${name} takes plain words, like staging, v1.2.3 or fix the login: letters, digits, spaces and . _ - / : @ + = , ~, with no word starting with -. "${value}" has something else`;
}

export function fillTarget(target: SwitchTarget, values: InputValues): SwitchTarget {
  if (Object.keys(values).length === 0) return target;
  for (const [name, value] of Object.entries(values)) {
    if (!INPUT_VALUE.test(value)) throw new WispError(notPlain(name, value), "INVALID_INPUT");
  }
  const text = (value: string) => fillText(value, values);
  const address = (value: string) => fillText(value, Object.fromEntries(Object.entries(values).map(([name, entry]) => [name, encodeURI(entry)])));
  const filled: SwitchTarget = { ...target, label: text(target.label), value: target.kind === "link" ? address(target.value.replace(ENCODED, "{{$1}}")) : text(target.value) };
  if (target.cwd) filled.cwd = text(target.cwd);
  if (target.env) filled.env = Object.fromEntries(Object.entries(target.env).map(([key, value]) => [key, text(value)]));
  if (target.wait && "url" in target.wait) filled.wait = { ...target.wait, url: address(target.wait.url) };
  return filled;
}

export function parseGiven(pairs: string[], specs: InputSpec[], pipeline: string): InputValues {
  const values: InputValues = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const name = at > 0 ? pair.slice(0, at).trim() : "";
    if (!name) throw new WispError(`"${pair}" is not name=value`, "INVALID_INPUT");
    const spec = specs.find((entry) => entry.name === name);
    if (!spec) {
      const known = specs.map((entry) => entry.name);
      throw new WispError(`"${pipeline}" has no input called ${name}${known.length > 0 ? `; it has ${known.join(", ")}` : ""}`, "INVALID_INPUT");
    }
    const problem = checkValue(spec, pair.slice(at + 1));
    if (problem) throw new WispError(problem, "INVALID_INPUT");
    values[name] = pair.slice(at + 1).trim();
  }
  return values;
}

export function checkValue(spec: InputSpec, raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return `${spec.name} needs a value`;
  if (spec.choices && !spec.choices.includes(value)) return `${spec.name} is one of ${spec.choices.join(", ")}, not "${value}"`;
  if (!INPUT_VALUE.test(value)) return notPlain(spec.name, value);
  return undefined;
}
