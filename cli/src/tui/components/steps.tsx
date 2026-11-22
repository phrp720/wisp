import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { containerMood, type Container } from "../../core/system/docker.js";
import { describeDuration } from "../../core/text/duration.js";
import { tildify } from "../../core/paths.js";
import type { RunStatus } from "../../core/system/processes.js";
import { composeTarget, stagesOfTargets, stepTargets } from "../../core/run/index.js";
import type { Pipeline, SwitchTarget, WorkspaceRead } from "../../core/types.js";
import type { GraphNode } from "./graph.js";
import type { Glyphs } from "../terminal/glyphs.js";
import { TONE } from "../terminal/tones.js";
import { describeStep, shortUrl } from "../model.js";

/** One line of a bolt's steps, already laid out. */
export interface Line {
  key: string;
  node: ReactNode;
}

type Status = { text: string; color: string } | undefined;

export function usedBy(read: WorkspaceRead, bolt: Pipeline): string[] {
  return read.workspace.bolts.filter((candidate) => candidate.steps.some((step) => step.kind === "pipeline" && step.bolt.toLowerCase() === bolt.label.toLowerCase())).map((candidate) => candidate.label);
}

/** The bolts in the order a run goes through them: the ones it runs, deepest first, then itself. */
export function flow(read: WorkspaceRead, bolt: Pipeline, seen = new Set<string>()): string[] {
  const order: string[] = [];
  for (const step of bolt.steps) {
    if (step.kind !== "pipeline") continue;
    const found = findPipeline(read, step.bolt);
    if (!found || seen.has(found.label)) continue;
    seen.add(found.label);
    for (const name of flow(read, found, seen)) if (!order.includes(name)) order.push(name);
  }
  order.push(bolt.label);
  return order;
}

/** Every step, numbered by when it can start, each bolt it runs opened up beneath it. */
type Shown = SwitchTarget & { held?: boolean };

export function shownTargets(read: WorkspaceRead, bolt: Pipeline): Shown[] {
  const aligned = stepTargets(read.workspace, bolt.steps);
  const heldById = new Map(read.withheld.map((item) => [item.id, item]));
  return bolt.steps.flatMap((step, at): Shown[] => {
    const target = aligned[at];
    if (target) return [target];
    const placed = { ...(step.name ? { name: step.name } : {}), ...(step.after && step.after.length > 0 ? { after: step.after } : {}), held: true };
    if (step.kind === "compose") return [{ ...composeTarget(step, "up"), ...placed }];
    const item = step.kind === "asset" ? heldById.get(step.id) : step.kind === "wait" && step.held ? heldById.get(step.held) : undefined;
    if (!item) return [];
    return [{ kind: item.kind, label: item.label, id: item.id, value: item.value, ...(item.cwd ? { cwd: item.cwd } : {}), ...placed }];
  });
}

export function planGraph(read: WorkspaceRead, bolt: Pipeline, glyphs: Glyphs): GraphNode[] {
  const all = shownTargets(read, bolt);
  const byName = new Map(all.flatMap((target, at) => (target.name ? [[target.name, at] as const] : [])));
  return all.map((target) => {
    const label = target.kind === "pipeline" ? `${glyphs.bolt}${target.label}` : (target.name ?? target.label);
    const after = (target.after ?? []).flatMap((name) => (byName.has(name) ? [byName.get(name) as number] : []));
    return { label, ok: true, state: "waiting" as const, after, ...(target.held ? { detail: "not trusted yet" } : {}) };
  });
}

export function stepLines(context: { read: WorkspaceRead; bolt: Pipeline; reads: WorkspaceRead[]; runs: RunStatus[]; containers: Container[]; glyphs: Glyphs; after?: boolean }): Line[] {
  const { glyphs } = context;
  const lines: Line[] = [];
  const done = new Set<string>();

  const walk = (read: WorkspaceRead, bolt: Pipeline, depth: number, tag: string) => {
    const indent = "   ".repeat(depth);
    const withheld = new Set(read.withheld.map((item) => item.id));
    const all = shownTargets(read, bolt);
    const stages = stagesOfTargets(all);

    all.forEach((target, index) => {
      const key = `${read.workspace.file}#${bolt.label}#${tag}${index}`;
      const shown = `${indent}${`${tag}${stages[index]}.`.padStart(3)} `;
      const after = target.after && (context.after !== false || depth > 0 || tag !== "") ? <Text dimColor>{`  after ${target.after.join(", ")}`}</Text> : null;
      if (target.kind === "pipeline") {
        const found = findPipeline(read, target.label);
        const twice = found ? done.has(`${read.workspace.file}#${found.label}`) : false;
        lines.push({
          key,
          node: (
            <Text wrap="truncate-end">
              <Text dimColor>{shown}</Text>
              <Text color={found?.color ?? TONE.accent} bold>{`${glyphs.bolt}${found?.label ?? target.label}`}</Text>
              {!found ? <Text color="red">{`  ${glyphs.fail} no pipeline by that name`}</Text> : twice ? <Text dimColor>  — already run above, not again</Text> : null}
              {after}
            </Text>
          ),
        });
        if (found && !twice) {
          done.add(`${read.workspace.file}#${found.label}`);
          walk(read, found, depth + 1, tag);
        }
        return;
      }
      const status = target.held || withheld.has(target.id) ? { text: "not trusted yet — t", color: "yellow" } : statusOf(target, read, context.runs, context.containers, glyphs);
      lines.push({
        key,
        node: (
          <Box flexGrow={1}>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate-end">
                <Text dimColor>{shown}</Text>
                <Text>{describeStep(target)}</Text>
                {after}
              </Text>
            </Box>
            {status ? (
              <Box flexShrink={0}>
                <Text color={status.color}>{`  ${status.text}`}</Text>
              </Box>
            ) : null}
          </Box>
        ),
      });
      const detail = details(target, read);
      if (detail) {
        lines.push({
          key: `${key}:detail`,
          node: (
            <Text wrap="truncate-end" dimColor>
              {`${" ".repeat(shown.length)}${detail}`}
            </Text>
          ),
        });
      }
    });
  };

  done.add(`${context.read.workspace.file}#${context.bolt.label}`);
  walk(context.read, context.bolt, 0, "");
  if (context.bolt.down && context.bolt.down.length > 0) {
    lines.push({ key: "down:gap", node: <Text> </Text> });
    lines.push({ key: "down", node: <Text dimColor>When you take it down (x), after stopping what it started:</Text> });
    walk(context.read, { ...context.bolt, steps: context.bolt.down }, 0, "↓");
  }
  return lines;
}

/** What a step is, below the sentence: the command and where, how it restarts, the address. */
function details(target: SwitchTarget, read: WorkspaceRead): string {
  const root = read.workspace.file.replace(/\/[^/]+$/, "");
  const where = target.cwd && target.cwd !== root ? `in ${target.cwd.startsWith(`${root}/`) ? target.cwd.slice(root.length + 1) : tildify(target.cwd)}` : "";
  switch (target.kind) {
    case "command":
      return [
        target.value !== target.label ? target.value : "",
        where,
        target.restart === "always" ? "always restarted" : target.restart === "on-failure" ? "restarted if it crashes" : "",
        target.timeout ? `stopped after ${describeDuration(target.timeout)}` : "",
        target.env && Object.keys(target.env).length > 0 ? `${Object.keys(target.env).length} env var${Object.keys(target.env).length === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    case "compose":
      return target.compose ? tildify(target.compose.file).replace(`${tildify(root)}/`, "") : "";
    case "link":
      return target.label !== target.value ? shortUrl(target.value) : "";
    case "wait":
      return "";
    default:
      return target.openWith ? `with ${target.openWith}` : "";
  }
}

/**
 * What a step's thing is doing right now — said only when it is up, or up and in trouble.
 * Not running is how a bolt normally sits until you run it, so it is left blank rather than
 * shown as "stopped" or "exited", which would read as something wrong.
 */
function statusOf(target: SwitchTarget, read: WorkspaceRead, runs: RunStatus[], containers: Container[], glyphs: Glyphs): Status {
  if (target.kind === "command") {
    const run = runs.find((candidate) => candidate.workspace === read.workspace.file && candidate.asset === target.id && candidate.alive);
    return run ? { text: `${glyphs.dot} running`, color: TONE.up } : undefined;
  }
  if (target.kind === "compose" && target.compose) {
    const wanted = target.compose.services;
    const mine = containers.filter((container) => container.file === target.compose?.file && (wanted.length === 0 || wanted.includes(container.service)) && (container.state === "running" || container.state === "restarting"));
    if (mine.length === 0) return undefined;
    const bad = mine.filter((container) => container.state === "restarting" || container.health === "unhealthy");
    if (bad.length > 0) return { text: `${glyphs.dot} ${bad.map((container) => `${container.service} ${containerMood(container).word}`).join(", ")}`, color: TONE.failed };
    return { text: `${glyphs.dot} ${mine.length === 1 ? containerMood(mine[0] as Container).word : `${mine.length} up`}`, color: TONE.up };
  }
  return undefined;
}

function findPipeline(read: WorkspaceRead, name: string): Pipeline | undefined {
  return read.workspace.bolts.find((candidate) => candidate.label.toLowerCase() === name.toLowerCase() || candidate.id === name);
}

