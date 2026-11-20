import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { containerMood, type Container } from "../core/docker.js";
import { tildify } from "../core/paths.js";
import type { RunStatus } from "../core/processes.js";
import { collectBoltTargets } from "../core/switch.js";
import type { Bolt, SwitchTarget, WorkspaceRead } from "../core/types.js";
import type { Glyphs } from "./glyphs.js";
import { TONE } from "./tones.js";
import { describeStep, groupMarks, shortUrl } from "./model.js";

/** One line of a bolt's steps, already laid out. */
export interface Line {
  key: string;
  node: ReactNode;
}

type Status = { text: string; color: string } | undefined;

export function usedBy(read: WorkspaceRead, bolt: Bolt, reads: WorkspaceRead[]): string[] {
  return reads.flatMap((other) =>
    other.workspace.bolts
      .filter((candidate) => candidate.steps.some((step) => step.kind === "bolt" && step.bolt.toLowerCase() === bolt.label.toLowerCase() && (step.workspace ? sameWorkspace(other, step.workspace, read) : other === read)))
      .map((candidate) => (other === read ? candidate.label : `${other.workspace.name} › ${candidate.label}`)),
  );
}

/** The bolts in the order a run goes through them: what it needs, deepest first, then itself. */
export function flow(read: WorkspaceRead, bolt: Bolt, reads: WorkspaceRead[], seen = new Set<string>()): string[] {
  const order: string[] = [];
  for (const step of bolt.steps) {
    if (step.kind !== "bolt") continue;
    const found = findBolt(read, step.bolt, step.workspace, reads);
    if (!found) continue;
    const key = `${found.read.workspace.file}#${found.bolt.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const name of flow(found.read, found.bolt, reads, seen)) if (!order.includes(name)) order.push(name);
  }
  order.push(bolt.label);
  return order;
}

/** Every step, numbered, each needed bolt opened up beneath its own number. */
export function stepLines(context: { read: WorkspaceRead; bolt: Bolt; reads: WorkspaceRead[]; runs: RunStatus[]; containers: Container[]; glyphs: Glyphs }): Line[] {
  const { glyphs } = context;
  const lines: Line[] = [];
  const done = new Set<string>();

  const walk = (read: WorkspaceRead, bolt: Bolt, prefix: string, depth: number) => {
    const indent = "   ".repeat(depth);
    const targets = collectBoltTargets(read.workspace, bolt);
    const withheld = new Set(read.withheld.map((item) => item.id));
    // Steps the file is not yet allowed to run are not in the targets; they are said anyway,
    // where the file lists them, so the order on screen is the order in the file.
    const held = read.withheld.filter((item) => bolt.steps.some((step) => step.kind === "asset" && step.id === item.id));
    const all: (SwitchTarget & { held?: boolean })[] = [...targets, ...held.filter((item) => !targets.some((target) => target.id === item.id)).map((item) => ({ kind: item.kind, label: item.label, id: item.id, value: item.value, ...(item.cwd ? { cwd: item.cwd } : {}), held: true }))];

    const marks = groupMarks(all, glyphs);
    all.forEach((target, index) => {
      const number = `${prefix}${index + 1}`;
      const key = `${read.workspace.file}#${bolt.label}#${number}`;
      const shown = `${indent}${depth === 0 ? `${number}.`.padStart(3) : number} `;
      if (target.kind === "bolt") {
        const found = findBolt(read, target.label, target.workspace, context.reads);
        const where = found && found.read !== context.read ? ` (${found.read.workspace.name})` : "";
        const twice = found ? done.has(`${found.read.workspace.file}#${found.bolt.label}`) : false;
        lines.push({
          key,
          node: (
            <Text wrap="truncate-end">
              <Text dimColor>{shown}</Text>
              <Text color={found?.bolt.color ?? TONE.accent} bold>{`${glyphs.bolt}${target.label}`}</Text>
              <Text dimColor>{where}</Text>
              <Text dimColor>{!found ? "  — no bolt by that name" : twice ? "  — already run above, not again" : " first"}</Text>
            </Text>
          ),
        });
        if (found && !twice) {
          done.add(`${found.read.workspace.file}#${found.bolt.label}`);
          walk(found.read, found.bolt, `${number}.`, depth + 1);
        }
        return;
      }
      const status = target.held || withheld.has(target.id) ? { text: "not allowed yet — t", color: "yellow" } : statusOf(target, read, context.runs, context.containers, glyphs);
      lines.push({
        key,
        node: (
          <Box flexGrow={1}>
            <Box flexGrow={1} minWidth={0}>
              <Text wrap="truncate-end">
                <Text dimColor>{shown}</Text>
                <Text>{`${marks[index]}${describeStep(target)}`}</Text>
                {marks[index] && all[index - 1]?.together !== target.together ? <Text dimColor>  together</Text> : null}
              </Text>
            </Box>
            {status ? <Text color={status.color}>{`  ${status.text}`}</Text> : null}
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
  walk(context.read, context.bolt, "", 0);
  if (context.bolt.down && context.bolt.down.length > 0) {
    lines.push({ key: "down:gap", node: <Text> </Text> });
    lines.push({ key: "down", node: <Text dimColor>When you take it down (x), after stopping what it started:</Text> });
    walk(context.read, { ...context.bolt, steps: context.bolt.down }, "↓", 0);
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

function findBolt(read: WorkspaceRead, name: string, workspace: string | undefined, reads: WorkspaceRead[]): { read: WorkspaceRead; bolt: Bolt } | undefined {
  const where = workspace ? reads.find((candidate) => sameWorkspace(candidate, workspace, read)) : read;
  const bolt = where?.workspace.bolts.find((candidate) => candidate.label.toLowerCase() === name.toLowerCase() || candidate.id === name);
  return where && bolt ? { read: where, bolt } : undefined;
}

/** A dependency's `workspace` names another workspace: by name, or by the path to its file or folder. */
function sameWorkspace(candidate: WorkspaceRead, ref: string, from: WorkspaceRead): boolean {
  const file = candidate.workspace.file;
  const lowered = ref.toLowerCase();
  if (candidate.workspace.name.toLowerCase() === lowered) return true;
  const base = from.workspace.file.replace(/\/[^/]+$/, "");
  const resolved = ref.startsWith("/") ? ref : ref.startsWith("~") ? ref : `${base}/${ref}`.replace(/\/\.\//g, "/");
  return file === resolved || file.replace(/\/[^/]+$/, "") === resolved.replace(/\/$/, "") || tildify(file) === ref;
}

