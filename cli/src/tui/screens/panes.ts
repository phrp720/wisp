import { cleanOutput } from "../../core/text/ansi.js";
import { type Container, containerMood, type ContainerStats } from "../../core/system/docker.js";
import { allSteps, baseLabel, type HistoryEntry, type HistoryStep } from "../../core/history.js";
import { tildify } from "../../core/paths.js";
import type { RunStatus } from "../../core/system/processes.js";
import { RESTART_MARK } from "../../core/system/shell.js";
import type { WorkspaceRead } from "../../core/types.js";
import type { Glyphs } from "../terminal/glyphs.js";
import { describeHistoryStep } from "./history.js";
import { filterLog } from "../components/logfilter.js";
import { matchesAll, windowed } from "../model.js";
import { clock, type PaneGroup, type PaneItem, type PaneTab, type RunState, since } from "../state.js";
import { spell } from "../terminal/spells.js";
import { TONE } from "../terminal/tones.js";

/**
 * The Running list, structured: the run in progress first, then each workspace's pipelines with
 * their pipeline under them — in the order the pipeline's last run went: what it waited for and
 * opened, the pipelines it needed, and what it started, which shows live.
 */
export function groupPanes(head: PaneItem[], runs: RunStatus[], containers: Container[], reads: WorkspaceRead[], history: HistoryEntry[] = []): PaneItem[] {
  const groups = new Map<string, { group: PaneGroup; members: PaneItem[] }>();
  const add = (group: PaneGroup, member: PaneItem) => {
    const found = groups.get(group.key) ?? { group, members: [] };
    found.members.push(member);
    groups.set(group.key, found);
  };
  const nameOf = (file: string, fallback: string) => reads.find((read) => read.workspace.file === file)?.workspace.name ?? fallback;

  for (const run of runs) {
    const pipeline = run.pipeline;
    const key = `${run.workspace}#${pipeline ?? ""}`;
    add({ key, workspace: run.workspace, workspaceName: nameOf(run.workspace, run.workspaceName), ...(pipeline ? { pipeline } : {}), title: pipeline ?? "Not from a pipeline" }, { type: "run", run, group: key });
  }
  for (const container of containers) {
    // The pipeline whose compose step starts this file is the container's owner.
    let owner: { read: WorkspaceRead; pipeline: string } | undefined;
    for (const read of reads) {
      for (const pipeline of read.workspace.pipelines) {
        if (pipeline.steps.some((step) => step.kind === "compose" && step.file === container.file)) owner = owner ?? { read, pipeline: pipeline.label };
      }
    }
    const key = owner ? `${owner.read.workspace.file}#${owner.pipeline}` : `compose#${container.project}`;
    add(
      owner
        ? { key, workspace: owner.read.workspace.file, workspaceName: owner.read.workspace.name, pipeline: owner.pipeline, title: owner.pipeline }
        : { key, workspaceName: container.project, title: `${container.project} (docker compose)` },
      { type: "container", container, group: key },
    );
  }

  for (const { group } of [...groups.values()]) {
    if (!group.pipeline || !group.workspace) continue;
    const latest = history.find((candidate) => candidate.workspace === group.workspace && !candidate.pipeline.endsWith(" (down)") && allSteps(candidate).some((step) => (step.pipeline ?? baseLabel(candidate.pipeline)) === group.pipeline));
    const caller = latest && baseLabel(latest.pipeline);
    if (!latest || !caller || caller === group.pipeline) continue;
    const key = `${group.workspace}#${caller}`;
    if (!groups.has(key)) groups.set(key, { group: { key, workspace: group.workspace, workspaceName: group.workspaceName, pipeline: caller, title: caller }, members: [] });
  }

  for (const found of groups.values()) {
    found.members = pipeline(found.group, found.members, history);
    const from = found.members.find((member) => member.type === "step");
    if (from?.type === "step" && baseLabel(from.entry.pipeline) === found.group.pipeline && from.entry.number) found.group.number = from.entry.number;
  }
  nestNeededPipelines(groups, history);

  // Within a workspace, its pipelines by name, and what no pipeline started last.
  const ordered = [...groups.values()].sort(
    (left, right) =>
      left.group.workspaceName.localeCompare(right.group.workspaceName) ||
      Number(!left.group.pipeline) - Number(!right.group.pipeline) ||
      left.group.title.localeCompare(right.group.title),
  );
  return [...head, ...ordered.flatMap(({ group, members }) => [{ type: "group" as const, group }, ...members])];
}

/**
 * A pipeline that came up only because another pipeline needed it is part of that run, the way
 * GitHub shows a called workflow inside the run that called it: its containers and commands
 * move under the "⚡ Services" line of the pipeline that needed it, and its own group goes.
 * Run on its own since, it keeps its own place.
 */
function nestNeededPipelines(groups: Map<string, { group: PaneGroup; members: PaneItem[] }>, history: HistoryEntry[]): void {
  for (const [key, found] of groups) {
    const { pipeline, workspace } = found.group;
    if (!pipeline || !workspace || !groups.has(key)) continue;
    const entry = history.find((candidate) => candidate.workspace === workspace && baseLabel(candidate.pipeline) === pipeline);
    if (!entry) continue;
    for (const member of [...found.members]) {
      if (member.type !== "step" || member.step.kind !== "pipeline" || member.entry !== entry) continue;
      const neededKey = `${workspace}#${member.step.label}`;
      const needed = groups.get(neededKey);
      if (!needed || neededKey === key) continue;
      // Only when this run is the newest that touched it: run on its own later, it's its own.
      const latest = history.find(
        (candidate) => candidate.workspace === workspace && (baseLabel(candidate.pipeline) === member.step.label || candidate.steps.some((step) => step.pipeline === member.step.label)),
      );
      if (latest !== entry) continue;
      const inside = needed.members.filter((item) => item.type === "run" || item.type === "container").map((item) => ({ ...item, group: key, depth: 2 }));
      if (inside.length === 0) continue;
      const position = found.members.indexOf(member);
      found.members.splice(position + 1, 0, ...inside);
      groups.delete(neededKey);
    }
  }
}

/**
 * A pipeline's members in pipeline order. Its last run in History gives the order and the
 * finished steps; what is running takes the place of the step that started it. A pipeline it
 * needed is one line, however many steps it had — it has its own place in the list.
 */
export function pipeline(group: PaneGroup, members: PaneItem[], history: HistoryEntry[]): PaneItem[] {
  if (!group.pipeline || !group.workspace) return members;
  const owns = (entry: HistoryEntry, step: HistoryStep) => (step.pipeline ?? baseLabel(entry.pipeline)) === group.pipeline;
  const entry = history.find((candidate) => candidate.workspace === group.workspace && !candidate.pipeline.endsWith(" (down)") && (baseLabel(candidate.pipeline) === group.pipeline || allSteps(candidate).some((step) => owns(candidate, step))));
  if (!entry) return members;

  const left = [...members];
  const take = (match: (member: PaneItem) => boolean): PaneItem[] => {
    const hits = left.filter(match);
    for (const hit of hits) left.splice(left.indexOf(hit), 1);
    return hits;
  };
  const ordered: PaneItem[] = [];
  const needed = new Set<string>();
  // The run was this pipeline's own, or it came up as another pipeline's dependency: only then are
  // the other pipelines in that run ones it needed, rather than its siblings.
  const own = baseLabel(entry.pipeline) === group.pipeline;
  const all = allSteps(entry);
  all.forEach((step, index) => {
    if (!owns(entry, step)) {
      if (!own) return;
      // A step of a pipeline this one needed: one line for that pipeline, where it ran — its output
      // the last thing it printed.
      const name = step.pipeline ?? "";
      if (!name || needed.has(name)) return;
      needed.add(name);
      const its = all.filter((candidate) => candidate.pipeline === name);
      const done = its.filter((candidate) => !candidate.state);
      const printed = [...its].reverse().find((candidate) => candidate.log && candidate.state !== "waiting")?.log;
      const state = its.some((candidate) => candidate.state === "running") ? "running" : done.length === 0 ? "waiting" : undefined;
      ordered.push({
        type: "step",
        entry,
        index,
        group: group.key,
        step: { kind: "pipeline", label: name, value: name, ok: done.every((candidate) => candidate.ok), ...(done.length > 0 && done.every((candidate) => candidate.skipped) ? { skipped: true } : {}), durationMs: done.reduce((sum, candidate) => sum + candidate.durationMs, 0), ...(printed ? { log: printed } : {}), ...(state ? { state } : {}) },
      });
      return;
    }
    if (step.kind === "command" && !step.finishes && !step.state) {
      const live = take((member) => member.type === "run" && member.run.label === step.label);
      if (live.length > 0) return void ordered.push(...live);
    }
    if (step.kind === "compose" && !step.state) {
      const live = take((member) => member.type === "container");
      if (live.length > 0) return void ordered.push(...live);
    }
    ordered.push({ type: "step", step, entry, index, group: group.key });
  });
  // Anything running that the last run did not start — an older run's, say — goes last.
  return [...ordered, ...left];
}

/**
 * The Running list narrowed to a search. A pipeline that matches keeps all of its tasks; a task
 * that matches keeps its pipeline, so you still see where it belongs, and so does a task inside
 * a pipeline this one needed keep that pipeline's line ("⚡ Services" over postgres). The run in
 * progress stays when its pipeline matches.
 */
export function filterPanes(items: PaneItem[], query: string, running?: string): PaneItem[] {
  if (!query.trim()) return items;
  const textOf = (item: PaneItem): string[] =>
    item.type === "group"
      ? [item.group.title, item.group.workspaceName]
      : item.type === "run"
        ? [item.run.label, item.run.command, item.run.workspaceName, item.run.alive ? "running" : endedAs(item.run)]
        : item.type === "container"
          ? [item.container.service, item.container.name, item.container.image, item.container.project, containerMood(item.container).word, "container"]
          : item.type === "step"
            ? [item.step.label, item.step.value, item.step.ok ? "done" : "failed"]
            : [];
  const groups = items.filter((item): item is PaneItem & { type: "group" } => item.type === "group");
  const keep = new Set<PaneItem>();
  for (const group of groups) {
    const members = allMembers(items, group.group.key);
    if (matchesAll(query, ...textOf(group))) {
      keep.add(group);
      for (const member of members) keep.add(member);
      continue;
    }
    const hits = members.filter((member) => matchesAll(query, ...textOf(member), group.group.title, group.group.workspaceName));
    if (hits.length > 0) {
      keep.add(group);
      for (const hit of hits) {
        keep.add(hit);
        if ((hit.type === "run" || hit.type === "container") && (hit.depth ?? 1) > 1) {
          // Nested: the line it sits under is the nearest shallower one above it.
          for (let at = members.indexOf(hit) - 1; at >= 0; at -= 1) {
            const above = members[at] as PaneItem & { depth?: number };
            if ((above.depth ?? 1) < (hit.depth ?? 1)) {
              keep.add(above);
              break;
            }
          }
        }
      }
    }
  }
  for (const item of items) if (item.type === "current" && running && matchesAll(query, running)) keep.add(item);
  return items.filter((item) => keep.has(item));
}

/** The pipeline a group in the Running list stands for. */
export function groupPipeline(items: PaneItem[], key: string): string | undefined {
  const found = items.find((item): item is PaneItem & { type: "group" } => item.type === "group" && item.group.key === key);
  return found?.group.pipeline;
}

/**
 * Which run started a task, as History numbers it: " #4" under its own pipeline, or
 * " from Work on web #2" when another pipeline's run brought it up as a dependency. `long`
 * always names the pipeline. Nothing while that run is still going and not in History yet.
 */
export function startedBy(run: RunStatus, history: HistoryEntry[], pipeline: string | undefined, long = false): string {
  const entry = run.historyId ? history.find((candidate) => candidate.id === run.historyId) : undefined;
  if (!entry?.number) return "";
  const name = entry.pipeline.replace(/ \((retry|down)\)$/, "");
  return !long && name === pipeline ? ` #${entry.number}` : ` from ${name} #${entry.number}`;
}

/** The tasks under a pipeline in the Running list. */
/** Everything under a pipeline in the Running list: its pipeline's steps and what is running. */
export function allMembers(items: PaneItem[], key: string): PaneItem[] {
  return items.filter((item) => (item.type === "run" || item.type === "container" || item.type === "step") && item.group === key);
}

export function groupMembers(items: PaneItem[], key: string): (PaneItem & { type: "run" | "container" })[] {
  return items.filter((item): item is PaneItem & { type: "run" | "container" } => (item.type === "run" || item.type === "container") && item.group === key);
}

/** How many of a pipeline's tasks are up, and how many are in trouble. */
export function groupTally(items: PaneItem[], key: string): { up: number; bad: number; total: number } {
  const members = groupMembers(items, key);
  const up = members.filter((item) => (item.type === "run" ? item.run.alive : item.container.state === "running")).length;
  const bad = members.filter((item) => (item.type === "run" ? false : containerMood(item.container).tone === "bad")).length;
  return { up, bad, total: members.length };
}

/** How a pane is found again after the list changes under it. */
export function paneKey(item: PaneItem): string {
  if (item.type === "current") return "current";
  if (item.type === "group") return `group:${item.group.key}`;
  if (item.type === "step") return `step:${item.group}:${item.index}`;
  return item.type === "run" ? item.run.id : `container:${item.container.name}`;
}

/** A line of the Running list: a heading, the gap before one, or one of the items. */
export type PaneRow = { key: string; kind: "gap" | "heading"; text: string } | { key: string; kind: "item"; at: number };

/**
 * The Running list, line by line: each workspace's heading before its pipelines, and the items.
 * Drawn from this, and clicks are matched against it, so the two can't disagree.
 */
export function paneRows(items: PaneItem[], active: RunState | undefined): PaneRow[] {
  const rows: PaneRow[] = [];
  let section = "";
  items.forEach((entry, at) => {
    if (entry.type === "current" || entry.type === "group") {
      const heading = entry.type === "current" ? (active?.done ? "Just finished" : "Running now") : entry.group.workspaceName;
      if (heading !== section) {
        if (section) rows.push({ key: `gap:${heading}`, kind: "gap", text: "" });
        section = heading;
        rows.push({ key: `h:${heading}`, kind: "heading", text: heading.toUpperCase() });
      }
    }
    // The run in progress has a line only while there is one.
    if (entry.type === "current" && !active) return;
    rows.push({ key: paneKey(entry), kind: "item", at });
  });
  return rows;
}

/**
 * The part of the Running list that fits, kept around the selection; and the room the
 * activity log takes under it, when there is room and something to say.
 */
export function paneList(options: { items: PaneItem[]; active: RunState | undefined; index: number; height: number; searching: boolean; activity: number }): { visible: PaneRow[]; logRoom: number } {
  const { items, active, index, height, searching, activity } = options;
  const logRoom = activity === 0 || height < 16 ? 0 : Math.min(activity + 1, 6);
  const rows = paneRows(items, active);
  const item = items[index];
  const selected = Math.max(0, rows.findIndex((row) => row.key === (item ? paneKey(item) : "")));
  // Borders and the title, and the search line while there is one.
  return { visible: windowed(rows, selected, height - (searching ? 4 : 3) - logRoom).items, logRoom };
}

/** What is under the mouse on the Running screen. */
export type PaneSpot = { area: "row"; at: number } | { area: "tab"; tab: PaneTab } | { area: "list" } | { area: "panel" };

/**
 * What is at a point of the Running screen, for a click or the wheel. `y` counts from the
 * panels' top border, the first line under the tabs along the top. Worked out from the same
 * layout the screen is drawn from: `paneList` for the rows, and the tab bar's titles.
 */
export function paneSpotAt(options: {
  x: number;
  y: number;
  items: PaneItem[];
  active: RunState | undefined;
  index: number;
  height: number;
  columns: number;
  full: boolean;
  searching: boolean;
  activity: number;
  dockerError?: string | undefined;
  glyphs: Glyphs;
}): PaneSpot | undefined {
  const { x, y, items, index, height, columns, full, searching, glyphs } = options;
  if (y < 0 || y >= height || x < 0 || x >= columns) return undefined;
  const listWidth = full ? 0 : paneListWidth(columns);
  if (x < listWidth) {
    // Under the border and the title: the search line, Docker's error (wrapped), then the rows.
    const docker = options.dockerError ? Math.ceil(`Docker: ${options.dockerError}`.length / Math.max(1, listWidth - 4)) : 0;
    const top = 2 + (searching ? 1 : 0) + docker;
    const row = paneList(options).visible[y - top];
    return row?.kind === "item" ? { area: "row", at: row.at } : { area: "list" };
  }
  // The tab bar is the panel's first line, inside its border and padding.
  const tabs = tabsOf(items[index]);
  if (y === 1 && tabs.length > 0) {
    const tab = tabAt(tabs, glyphs, x - listWidth - 2);
    if (tab) return { area: "tab", tab };
  }
  return { area: "panel" };
}

/** The tab whose title is at `column` of the tab bar. */
export function tabAt(tabs: PaneTab[], glyphs: Glyphs, column: number): PaneTab | undefined {
  let at = 0;
  for (const tab of tabs) {
    const width = TAB_TITLE[tab].length;
    if (column >= at && column < at + width) return tab;
    at += width + tabSeparator(glyphs).length;
  }
  return undefined;
}

/** How often a command has been brought back, read from the marks its restart loop logs. */
export function restartsOf(lines: string[]): { count: number; gaveUp: boolean } {
  let count = 0;
  let gaveUp = false;
  for (const line of lines) {
    if (line.includes(RESTART_MARK)) count += 1;
    if (line.includes("[wisp]") && line.includes("gave up after")) gaveUp = true;
  }
  return { count, gaveUp };
}

export function restartNote(lines: string[]): string | undefined {
  const { count } = restartsOf(lines);
  return count > 0 ? `restarted ${count}× — ${lastLine(lines) ?? ""}` : undefined;
}

export function lastLine(lines: string[]): string | undefined {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]?.replace(/\u001B\[[0-9;]*m/g, "").trim();
    if (line) return line;
  }
  return undefined;
}

/**
 * Beside a run that has not reached its first step: the words while it starts, with their star,
 * when some fit in `room` whole. A narrow list gets the plain "starting…", never a cut spell.
 */
export function waitingWords(glyphs: Glyphs, room: number, now = Date.now()): string {
  const words = spell(7, now, room - 3);
  return words.length + 3 <= room ? `${glyphs.spark} ${words}…` : "starting…";
}

/** At most `max` characters, with an ellipsis when cut — the right side of a row never wraps. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** A finished step in a few words, to fit the list: "wait for port 5050", "open Acme". */
export function shortStep(step: HistoryStep): string {
  if (step.kind === "wait") {
    if (/^\d+(\.\d+)?s$/.test(step.label)) return `wait ${step.label}`;
    return `wait for ${step.label.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }
  return describeHistoryStep(step);
}

/** How a command that is no longer running ended: by itself, with a failure, or stopped. */
export function endedAs(run: { exitCode?: number }): string {
  if (run.exitCode === 0) return "finished";
  if (run.exitCode !== undefined) return `failed (exit ${run.exitCode})`;
  return "stopped";
}

/**
 * The log the panel beside the list shows, and how much of it fits: its lines, the ones the
 * filter keeps, and the room for them. The panel is drawn from this, and scrolling stops at
 * the top of it, rather than counting on past it.
 */
export function logWindow(options: { item: PaneItem | undefined; tab: PaneTab | undefined; log: string; logQuery: string; logTyping: boolean; height: number }): {
  lines: string[];
  filtering: boolean;
  matched: { at: number; text: string }[] | undefined;
  room: number;
  total: number;
  /** As far back as scrolling can go: the first lines filling the panel. */
  most: number;
} {
  const { item, log, logQuery, logTyping, height } = options;
  const tab = shownTab(item, options.tab);
  const lines = cleanLines(log);
  // The log filter applies to whatever log the panel shows: a command's, a container's, a step's.
  const filtering = tab === "logs" && item?.type !== "group" && (logTyping || logQuery !== "");
  const matched = filtering && logQuery ? filterLog(lines, logQuery) : undefined;
  // Borders, the header, the tab bar when the row has tabs, and the filter line while there is one.
  const room = Math.max(1, height - 3 - (tabsOf(item).length > 0 ? 1 : 0) - (filtering ? 1 : 0));
  const total = matched ? matched.length : lines.length;
  return { lines, filtering, matched, room, total, most: Math.max(0, total - room) };
}

// The last log cleaned, and its lines. The panel redraws many times a second while a run is
// going (its spinner), and on every key; the log only changes when the command prints.
let cleaned: { log: string; lines: string[] } | undefined;

/** A log as lines to show: played out as a terminal would (`cleanOutput`), once per change. */
export function cleanLines(log: string): string[] {
  if (cleaned?.log === log) return cleaned.lines;
  const lines = cleanOutput(log)
    .split("\n")
    .filter((line, at, every) => line !== "" || at < every.length - 1);
  cleaned = { log, lines };
  return lines;
}

/** The next row with a log of its own, going `by` from `at`: pipeline rows have none, so they are passed over. */
export function nextWithLog(items: PaneItem[], at: number, by: 1 | -1): number {
  for (let next = at + by; next >= 0 && next < items.length; next += by) {
    if ((items[next] as PaneItem).type !== "group") return next;
  }
  return at;
}

/** How wide the Running list is, the rest going to the panel beside it. */
export function paneListWidth(columns: number): number {
  return Math.min(42, Math.max(26, Math.floor(columns * 0.32)));
}

export const TAB_TITLE: Record<PaneTab, string> = { logs: "Logs", info: "Info", runs: "Runs" };

/**
 * The tabs of the panel beside the list, for the selected row. A command has its logs, what
 * it is, and the times it ran before; a container its logs and what it is. Anything else (a
 * pipeline, a finished step) has one view, and no tabs.
 */
export function tabsOf(item: PaneItem | undefined): PaneTab[] {
  if (item?.type === "run") return ["logs", "info", "runs"];
  if (item?.type === "container") return ["logs", "info"];
  return [];
}

/** The tab to show: the one chosen, where the selected row has it, and its logs otherwise. */
export function shownTab(item: PaneItem | undefined, tab: PaneTab | undefined): PaneTab {
  return tab && tabsOf(item).includes(tab) ? tab : "logs";
}

/** The tab after (or before) the one shown, going round. */
export function nextTab(item: PaneItem | undefined, tab: PaneTab | undefined, by: 1 | -1): PaneTab | undefined {
  const tabs = tabsOf(item);
  if (tabs.length === 0) return undefined;
  const at = tabs.indexOf(shownTab(item, tab));
  return tabs[(at + by + tabs.length) % tabs.length];
}

/** Between two tab titles; a plain bar where box-drawing characters would show as boxes. */
export function tabSeparator(glyphs: Glyphs): string {
  return glyphs.border === "round" ? " │ " : " | ";
}

/** One line of an Info tab: what it is, its value, and a colour when the value is a state. */
export type Detail = { label: string; value: string; color?: string | undefined };

/**
 * Env names that usually hold a secret. Their values are hidden on the Info tab, which is
 * the kind of screen that ends up shared in a call or a screenshot.
 */
const SECRET_NAME = /secret|token|passw|pwd|private|credential|api_?key|(^|_)key$/i;

/** An env value as the Info tab shows it: secrets hidden, and so is a password inside a URL. */
export function maskEnv(name: string, value: string): string {
  if (SECRET_NAME.test(name) && value) return "****";
  return value.replace(/(:\/\/[^:/@\s]+:)[^@\s]+@/, "$1****@");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When something started: the time today, with the day before that. */
export function when(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = clock(date.getTime());
  return date.toDateString() === now.toDateString() ? time : `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`;
}

/**
 * What a command is, for its Info tab: what it runs and where, its env and restart policy
 * as the file says, how it is doing, and what to type to reach it from a shell.
 */
export function runDetails(run: RunStatus, reads: WorkspaceRead[], history: HistoryEntry[], lines: string[]): Detail[] {
  const read = reads.find((candidate) => candidate.workspace.file === run.workspace);
  const command = read?.workspace.commands.find((candidate) => candidate.id === run.asset);
  const restarts = restartsOf(lines);
  const failed = restarts.gaveUp || (!run.alive && run.exitCode !== undefined && run.exitCode !== 0);
  const rows: Detail[] = [{ label: "Command", value: run.command }];
  if (run.cwd) rows.push({ label: "Folder", value: tildify(run.cwd) });
  Object.entries(command?.env ?? {}).forEach(([name, value], at) => rows.push({ label: at === 0 ? "Env" : "", value: `${name}=${maskEnv(name, value)}` }));
  if (command?.shell) rows.push({ label: "Shell", value: command.shell });
  rows.push(
    run.alive && run.waiting
      ? { label: "State", value: `waiting for an answer: "${run.waiting}"`, color: TONE.busy }
      : run.alive
        ? { label: "State", value: run.pid > 0 ? `running, PID ${run.pid}` : "running", color: TONE.up }
        : { label: "State", value: restarts.gaveUp ? "gave up restarting" : endedAs(run), color: failed ? TONE.failed : TONE.stopped },
  );
  const restart = command?.restart ?? "off";
  rows.push({ label: "Restart", value: restarts.count > 0 ? `${restart}, restarted ${restarts.count}×` : restart, ...(restarts.count > 0 ? { color: TONE.busy } : {}) });
  rows.push({ label: "Started", value: `${when(run.startedAt)}, ${since(run.startedAt)}${startedBy(run, history, undefined, true)}` });
  rows.push({ label: "Runs in", value: run.kind === "window" ? (run.where ?? "a terminal window") : "the background" });
  if (run.log) rows.push({ label: "Output", value: tildify(run.log) });
  rows.push({ label: "Workspace", value: `${read?.workspace.name ?? run.workspaceName}  ${tildify(run.workspace)}` });
  rows.push({ label: "From a shell", value: `wisp logs ${run.id} -f · wisp stop ${run.id}` });
  return rows;
}

/** What a container is, for its Info tab: image, state, ports, and what it is using now. */
export function containerDetails(container: Container, stats: ContainerStats | undefined): Detail[] {
  const mood = containerMood(container);
  const color = mood.tone === "good" ? TONE.up : mood.tone === "busy" ? TONE.busy : mood.tone === "bad" ? TONE.failed : TONE.stopped;
  const rows: Detail[] = [
    { label: "Service", value: container.service },
    { label: "Image", value: container.image },
    { label: "State", value: `${mood.word}, ${container.status}`, color },
    { label: "Ports", value: container.ports.length > 0 ? container.ports.map((port) => `localhost:${port.split("→")[0]}`).join(", ") : "none published" },
  ];
  if (stats) rows.push({ label: "CPU", value: stats.cpu }, { label: "Memory", value: stats.memory });
  rows.push({ label: "Container", value: container.name }, { label: "Compose", value: `${tildify(container.file)}, project ${container.project}` });
  return rows;
}

/** Every time Wisp ran this command that it still remembers, newest first. */
export function pastRuns(run: RunStatus, runs: RunStatus[]): RunStatus[] {
  return runs
    .filter((candidate) => candidate.workspace === run.workspace && candidate.asset === run.asset)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}
