/** The Running screen: what bolts started, grouped under them, with live output and an activity log. */

import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { cleanOutput } from "../core/ansi.js";
import { type Container, containerMood, type ContainerStats, shortStatus } from "../core/docker.js";
import { baseLabel, type HistoryEntry, type HistoryStep } from "../core/history.js";
import type { RunStatus } from "../core/processes.js";
import { RESTART_MARK } from "../core/shell.js";
import type { WorkspaceRead } from "../core/types.js";
import type { Glyphs } from "./glyphs.js";
import { describeHistoryStep, SearchLine } from "./history.js";
import { describeStep, matchesAll, windowed } from "./model.js";
import { type Activity, clock, type PaneGroup, type PaneItem, type RunState, since } from "./state.js";
import { TONE } from "./tones.js";

/**
 * What Wisp is running, each in a pane of its own: the list on the left, each with its
 * last line, and the selected one's live output filling the rest — colours and all.
 */
/**
 * What is running, each in a pane of its own: Wisp's commands and Docker's containers
 * together, in a list on the left with how each is doing, and the selected one's live
 * output filling the rest — colours and all.
 */
export function PanesPanel(props: {
  items: PaneItem[];
  activity: Activity[];
  history: HistoryEntry[];
  query: string;
  typing: boolean;
  runs: RunStatus[];
  containers: Container[];
  active: RunState | undefined;
  tick: number;
  stats: Map<string, ContainerStats>;
  dockerError?: string | undefined;
  all: boolean;
  index: number;
  log: string;
  scroll: number;
  full: boolean;
  glyphs: Glyphs;
  height: number;
  columns: number;
}) {
  const { items, activity, history, query, typing, active, tick, stats, dockerError, all, index, log, scroll, full, glyphs, height, columns } = props;
  const listWidth = Math.min(42, Math.max(26, Math.floor(columns * 0.32)));
  // The activity log takes the bottom of the list when there is room and something to say.
  const logRoom = activity.length === 0 || height < 16 ? 0 : Math.min(activity.length + 1, 6);
  const item = items[index];
  const lines = cleanOutput(log)
    .split("\n")
    .filter((line, at, every) => line !== "" || at < every.length - 1);
  const room = Math.max(1, height - 3);
  const end = Math.max(room, lines.length - scroll);
  const shown = lines.slice(Math.max(0, end - room), end);

  // Rows for the list: workspace headings, each bolt, then its pipeline — one line a step,
  // in the order its run went, with how each one is doing on the right.
  type Row = { key: string; node: ReactNode };
  const rows: Row[] = [];
  let section = "";
  const width = listWidth - 4;
  /** One line: the left part truncates; the right part is always shown. */
  const line = (key: string, selected: boolean, depth: number, mark: ReactNode, label: ReactNode, right: string, rightColor?: string | undefined) =>
    rows.push({
      key,
      node: (
        <Box width={width}>
          <Box flexGrow={1} minWidth={0}>
            <Text wrap="truncate-end">
              <Text color={TONE.accent}>{selected ? glyphs.pointer : " "}</Text>
              {" ".repeat(depth * 2 + 1)}
              {mark}
              {mark ? " " : ""}
              <Text bold={selected} color={selected ? TONE.accent : undefined}>{label}</Text>
            </Text>
          </Box>
          {right ? <Text color={rightColor} dimColor={!rightColor} wrap="truncate-end">{` ${clip(right, Math.floor(width * 0.45))}`}</Text> : null}
        </Box>
      ),
    });
  items.forEach((entry, at) => {
    if (entry.type === "current" || entry.type === "group") {
      const heading = entry.type === "current" ? (active?.done ? "Just finished" : "Running now") : entry.group.workspaceName;
      if (heading !== section) {
        if (section) rows.push({ key: `gap:${heading}`, node: <Text> </Text> });
        section = heading;
        rows.push({ key: `h:${heading}`, node: <Text bold dimColor>{heading.toUpperCase()}</Text> });
      }
    }
    const selected = at === index;
    if (entry.type === "group") {
      const tally = groupTally(items, entry.group.key);
      const state =
        tally.bad > 0
          ? { text: `${glyphs.dot} ${tally.bad} in trouble`, color: TONE.failed }
          : tally.total === 0
            ? { text: "", color: TONE.stopped }
            : tally.up === tally.total
              ? { text: `${glyphs.dot} up`, color: TONE.up }
              : tally.up > 0
                ? { text: `${glyphs.dot} ${tally.up} of ${tally.total} up`, color: TONE.busy }
                : { text: `${glyphs.dot} stopped`, color: TONE.stopped };
      // The run the pipeline below comes from, as History numbers it.
      const from = allMembers(items, entry.group.key).find((member) => member.type === "step");
      const number = from?.type === "step" && baseLabel(from.entry.bolt) === entry.group.bolt ? from.entry.number : undefined;
      line(
        `group:${entry.group.key}`,
        selected,
        0,
        null,
        <Text>
          {entry.group.bolt ? `${glyphs.bolt}${entry.group.title}` : entry.group.title}
          {number ? <Text dimColor bold={false}>{` #${number}`}</Text> : null}
        </Text>,
        state.text,
        state.color,
      );
      return;
    }
    if (entry.type === "current") {
      if (!active) return;
      const now = active.steps.find((step) => step.state === "running");
      const failed = active.steps.some((step) => step.result && !step.result.ok && !step.result.skipped);
      const mark = !active.done ? (
        <Text color={TONE.accent}>{glyphs.running[tick % glyphs.running.length]}</Text>
      ) : failed || active.error || active.stopped ? (
        <Text color={TONE.failed}>{glyphs.fail}</Text>
      ) : (
        <Text color={TONE.up}>{glyphs.ok}</Text>
      );
      line("current", selected, 0, mark, `${glyphs.bolt}${active.bolt}`, active.stopped ? "stopped" : now ? describeStep(now.target, true, active.job) : active.done ? (failed ? "failed" : "done") : "starting…", failed || active.stopped ? TONE.failed : undefined);
      return;
    }
    if (entry.type === "step") {
      const step = entry.step;
      const mark = step.skipped ? <Text dimColor>{glyphs.skip}</Text> : step.ok ? <Text color={TONE.up}>{glyphs.ok}</Text> : <Text color={TONE.failed}>{glyphs.fail}</Text>;
      const label = step.kind === "bolt" ? `${glyphs.bolt}${step.label}` : shortStep(step, entry.entry.job ?? false);
      line(`${paneKey(entry)}`, selected, 1, mark, label, step.skipped ? "" : !step.ok ? "failed" : step.durationMs >= 1000 ? `${(step.durationMs / 1000).toFixed(1)}s` : "", !step.ok && !step.skipped ? TONE.failed : undefined);
      return;
    }
    if (entry.type === "run") {
      const run = entry.run;
      const restarts = selected ? restartsOf(lines) : { count: 0, gaveUp: false };
      const right = run.alive
        ? [`up ${since(run.startedAt).replace(" ago", "").replace("just now", "<1m")}`, restarts.count > 0 ? `${restarts.count}× restarted` : ""].filter(Boolean).join(" · ")
        : restarts.gaveUp
          ? "gave up"
          : "stopped";
      line(run.id, selected, 1, <Text color={run.alive ? TONE.up : restarts.gaveUp ? TONE.failed : TONE.stopped}>{glyphs.dot}</Text>, run.label, right, restarts.gaveUp ? TONE.failed : undefined);
      return;
    }
    const container = entry.container;
    const mood = containerMood(container);
    const color = mood.tone === "good" ? TONE.up : mood.tone === "busy" ? TONE.busy : mood.tone === "bad" ? TONE.failed : TONE.stopped;
    line(`container:${container.name}`, selected, 1, <Text color={color}>{glyphs.dot}</Text>, container.service, mood.word, mood.tone === "bad" ? TONE.failed : undefined);
  });

  const header =
    item?.type === "current" && active ? (
      <Text wrap="truncate-end">
        <Text bold>{active.bolt}</Text>
        <Text dimColor>{`  ${active.outputOf ? `output of ${active.outputOf}  ` : ""}`}</Text>
        {!active.done ? <Text color={TONE.accent}>running — x stops it</Text> : active.stopped ? <Text color="red">stopped</Text> : <Text dimColor>finished — ⏎ for its steps</Text>}
      </Text>
    ) : item?.type === "group" ? (
      <Text wrap="truncate-end">
        <Text bold>{item.group.title}</Text>
        <Text dimColor>{`  ${item.group.workspaceName}`}</Text>
      </Text>
    ) : item?.type === "container" ? (
      <Text wrap="truncate-end">
        <Text bold>{item.container.service}</Text>
        <Text dimColor>{`  ${item.container.image}  `}</Text>
        <Text color={containerMood(item.container).tone === "good" ? "green" : containerMood(item.container).tone === "bad" ? "red" : "yellow"}>{`${glyphs.dot} ${containerMood(item.container).word}`}</Text>
        {item.container.ports.length > 0 ? <Text dimColor>{`  on ${item.container.ports.map((port) => `localhost:${port.split("→")[0]}`).join(", ")}`}</Text> : null}
      </Text>
    ) : item?.type === "run" ? (
      <Text wrap="truncate-end">
        <Text bold>{item.run.label}</Text>
        {item.run.command !== item.run.label ? <Text dimColor>{`  ${item.run.command}`}</Text> : null}
        {item.run.alive ? <Text color={TONE.up}>{`  ${glyphs.dot} running`}</Text> : <Text color={TONE.stopped}>{`  ${glyphs.dot} stopped`}</Text>}
        <Text dimColor>{startedBy(item.run, history, undefined, true).replace(" from ", "  started by ")}</Text>
        {restartsOf(lines).count > 0 ? <Text color={TONE.busy}>{`  restarted ${restartsOf(lines).count}×`}</Text> : null}
      </Text>
    ) : item?.type === "step" ? (
      <Text wrap="truncate-end">
        <Text bold>{item.step.kind === "bolt" ? item.step.label : describeHistoryStep(item.step, item.entry.job ?? false)}</Text>
        {item.step.skipped ? <Text dimColor>{"  not reached"}</Text> : item.step.ok ? <Text color={TONE.up}>{`  ${glyphs.ok} done`}</Text> : <Text color={TONE.failed}>{`  ${glyphs.fail} failed`}</Text>}
        <Text dimColor>{`  in ${baseLabel(item.entry.bolt)} #${item.entry.number ?? ""} · ${since(item.entry.startedAt)}`}</Text>
      </Text>
    ) : (
      <Text bold>Output</Text>
    );

  return (
    <Box height={height}>
      {full ? null : (
        <Box flexDirection="column" width={listWidth} flexShrink={0} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1} overflow="hidden">
          <Text bold>
            {all ? "Running and stopped" : "Running"}
          </Text>
          {typing || query ? <SearchLine query={query} typing={typing} /> : null}
          {items.length === 0 ? <Text dimColor>{query ? `Nothing matches “${query}”. esc clears it.` : all ? "Nothing has run yet." : "Nothing is running. Run a bolt with ⏎, or a shows stopped ones."}</Text> : null}
          {dockerError ? <Text color="yellow" wrap="wrap">{`Docker: ${dockerError}`}</Text> : null}
          {windowed(rows, Math.max(0, rows.findIndex((row) => row.key === (item ? paneKey(item) : ""))), height - (typing || query ? 4 : 3) - logRoom).items.map((row) => (
            <Box key={row.key}>{row.node}</Box>
          ))}
          <Box flexGrow={1} />
          {logRoom > 0 ? (
            <Box flexDirection="column">
              <Text bold dimColor>ACTIVITY</Text>
              {activity.slice(0, logRoom - 1).map((entry) => (
                <Text key={`${entry.at}:${entry.text}`} wrap="truncate-end">
                  <Text dimColor>{`${clock(entry.at)} `}</Text>
                  <Text color={entry.tone === "bad" ? TONE.failed : entry.tone === "good" ? TONE.up : undefined} dimColor={entry.tone === "info"}>{entry.text}</Text>
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )}
      <Box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        overflow="hidden"
        borderStyle={glyphs.border}
        borderColor={
          item?.type === "current"
            ? active && !active.done ? TONE.accent : "gray"
            : item?.type === "group"
              ? groupTally(items, item.group.key).bad > 0 ? "red" : TONE.accent
              : item?.type === "step"
                ? item.step.ok || item.step.skipped ? "gray" : TONE.failed
                : item && (item.type === "run" ? item.run.alive : containerMood(item.container).tone === "good") ? TONE.up : "gray"
        }
        paddingX={1}
      >
        <Text wrap="truncate-end">
          {header}
          {scroll > 0 ? <Text color="yellow">{`  ↑ ${scroll} lines back — G to follow`}</Text> : null}
        </Text>
        {item?.type === "run" && !item.run.log ? <Text dimColor>{`It runs in ${item.run.where ?? "a terminal window"} — its output is there.`}</Text> : null}
        {item?.type === "group" ? (
          <GroupSummary items={items} group={item.group} history={history} stats={stats} glyphs={glyphs} />
        ) : item?.type === "step" && shown.length === 0 ? (
          <Text dimColor wrap="wrap">
            {item.step.kind === "bolt"
              ? `${item.step.label} ran first and printed nothing.`
              : item.step.skipped
                ? item.step.note ?? "It was not reached."
                : item.step.error ?? `It printed nothing${item.step.durationMs ? ` and took ${item.step.durationMs >= 1000 ? `${(item.step.durationMs / 1000).toFixed(1)}s` : `${item.step.durationMs}ms`}` : ""}.`}
          </Text>
        ) : (
          shown.map((line, at) => (
            <Text key={at} wrap="truncate-end">{line || " "}</Text>
          ))
        )}
      </Box>
    </Box>
  );
}

/**
 * The Running list, structured: the run in progress first, then each workspace's bolts with
 * their pipeline under them — in the order the bolt's last run went: what it waited for and
 * opened, the bolts it needed, and what it started, which shows live.
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
    const bolt = run.bolt;
    const key = `${run.workspace}#${bolt ?? ""}`;
    add({ key, workspace: run.workspace, workspaceName: nameOf(run.workspace, run.workspaceName), ...(bolt ? { bolt } : {}), title: bolt ?? "Not from a bolt" }, { type: "run", run, group: key });
  }
  for (const container of containers) {
    // The bolt whose compose step starts this file is the container's owner.
    let owner: { read: WorkspaceRead; bolt: string } | undefined;
    for (const read of reads) {
      for (const bolt of read.workspace.bolts) {
        if (bolt.steps.some((step) => step.kind === "compose" && step.file === container.file)) owner = owner ?? { read, bolt: bolt.label };
      }
    }
    const key = owner ? `${owner.read.workspace.file}#${owner.bolt}` : `compose#${container.project}`;
    add(
      owner
        ? { key, workspace: owner.read.workspace.file, workspaceName: owner.read.workspace.name, bolt: owner.bolt, title: owner.bolt }
        : { key, workspaceName: container.project, title: `${container.project} (docker compose)` },
      { type: "container", container, group: key },
    );
  }

  for (const found of groups.values()) found.members = pipeline(found.group, found.members, history);

  // Within a workspace, its bolts by name, and what no bolt started last.
  const ordered = [...groups.values()].sort(
    (left, right) =>
      left.group.workspaceName.localeCompare(right.group.workspaceName) ||
      Number(!left.group.bolt) - Number(!right.group.bolt) ||
      left.group.title.localeCompare(right.group.title),
  );
  return [...head, ...ordered.flatMap(({ group, members }) => [{ type: "group" as const, group }, ...members])];
}

/**
 * A bolt's members in pipeline order. Its last run in History gives the order and the
 * finished steps; what is running takes the place of the step that started it. A bolt it
 * needed is one line, however many steps it had — it has its own place in the list.
 */
function pipeline(group: PaneGroup, members: PaneItem[], history: HistoryEntry[]): PaneItem[] {
  if (!group.bolt || !group.workspace) return members;
  const owns = (entry: HistoryEntry, step: HistoryStep) => (step.bolt ?? baseLabel(entry.bolt)) === group.bolt;
  const entry = history.find((candidate) => candidate.workspace === group.workspace && !candidate.bolt.endsWith(" (down)") && candidate.steps.some((step) => owns(candidate, step)));
  if (!entry) return members;

  const left = [...members];
  const take = (match: (member: PaneItem) => boolean): PaneItem[] => {
    const hits = left.filter(match);
    for (const hit of hits) left.splice(left.indexOf(hit), 1);
    return hits;
  };
  const ordered: PaneItem[] = [];
  const needed = new Set<string>();
  // The run was this bolt's own, or it came up as another bolt's dependency: only then are
  // the other bolts in that run ones it needed, rather than its siblings.
  const own = baseLabel(entry.bolt) === group.bolt;
  entry.steps.forEach((step, index) => {
    if (!owns(entry, step)) {
      if (!own) return;
      // A step of a bolt this one needed: one line for that bolt, where it ran — its output
      // the last thing it printed.
      const name = step.bolt ?? "";
      if (!name || needed.has(name)) return;
      needed.add(name);
      const its = entry.steps.filter((candidate) => candidate.bolt === name);
      const printed = [...its].reverse().find((candidate) => candidate.log)?.log;
      ordered.push({
        type: "step",
        entry,
        index,
        group: group.key,
        step: { kind: "bolt", label: name, value: name, ok: its.every((candidate) => candidate.ok), ...(its.every((candidate) => candidate.skipped) ? { skipped: true } : {}), durationMs: its.reduce((sum, candidate) => sum + candidate.durationMs, 0), ...(printed ? { log: printed } : {}) },
      });
      return;
    }
    if (step.kind === "command" && !entry.job) {
      const live = take((member) => member.type === "run" && member.run.label === step.label);
      if (live.length > 0) return void ordered.push(...live);
    }
    if (step.kind === "compose") {
      const live = take((member) => member.type === "container");
      if (live.length > 0) return void ordered.push(...live);
    }
    ordered.push({ type: "step", step, entry, index, group: group.key });
  });
  // Anything running that the last run did not start — an older run's, say — goes last.
  return [...ordered, ...left];
}

/**
 * The Running list narrowed to a search. A bolt that matches keeps all of its tasks; a task
 * that matches keeps its bolt, so you still see where it belongs.
 */
export function filterPanes(items: PaneItem[], query: string): PaneItem[] {
  if (!query.trim()) return items;
  const textOf = (item: PaneItem): string[] =>
    item.type === "group"
      ? [item.group.title, item.group.workspaceName]
      : item.type === "run"
        ? [item.run.label, item.run.command, item.run.workspaceName, item.run.alive ? "running" : "stopped"]
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
      for (const hit of hits) keep.add(hit);
    }
  }
  return items.filter((item) => keep.has(item));
}

/** The bolt a group in the Running list stands for. */
export function groupBolt(items: PaneItem[], key: string): string | undefined {
  const found = items.find((item): item is PaneItem & { type: "group" } => item.type === "group" && item.group.key === key);
  return found?.group.bolt;
}

/**
 * Which run started a task, as History numbers it: " #4" under its own bolt, or
 * " from Work on web #2" when another bolt's run brought it up as a dependency. `long`
 * always names the bolt. Nothing while that run is still going and not in History yet.
 */
export function startedBy(run: RunStatus, history: HistoryEntry[], bolt: string | undefined, long = false): string {
  const entry = run.historyId ? history.find((candidate) => candidate.id === run.historyId) : undefined;
  if (!entry?.number) return "";
  const name = entry.bolt.replace(/ \((retry|down)\)$/, "");
  return !long && name === bolt ? ` #${entry.number}` : ` from ${name} #${entry.number}`;
}

/** The tasks under a bolt in the Running list. */
/** Everything under a bolt in the Running list: its pipeline's steps and what is running. */
export function allMembers(items: PaneItem[], key: string): PaneItem[] {
  return items.filter((item) => (item.type === "run" || item.type === "container" || item.type === "step") && item.group === key);
}

export function groupMembers(items: PaneItem[], key: string): (PaneItem & { type: "run" | "container" })[] {
  return items.filter((item): item is PaneItem & { type: "run" | "container" } => (item.type === "run" || item.type === "container") && item.group === key);
}

/** How many of a bolt's tasks are up, and how many are in trouble. */
export function groupTally(items: PaneItem[], key: string): { up: number; bad: number; total: number } {
  const members = groupMembers(items, key);
  const up = members.filter((item) => (item.type === "run" ? item.run.alive : item.container.state === "running")).length;
  const bad = members.filter((item) => (item.type === "run" ? false : containerMood(item.container).tone === "bad")).length;
  return { up, bad, total: members.length };
}

/**
 * A bolt selected in the Running list. The list beside it already says how each step is
 * doing; this says what each of its commands and containers actually is, and what keys do.
 */
export function GroupSummary({ items, group }: { items: PaneItem[]; group: PaneGroup; history: HistoryEntry[]; stats: Map<string, ContainerStats>; glyphs: Glyphs }) {
  const members = groupMembers(items, group.key);
  return (
    <Box flexDirection="column" marginTop={1}>
      {members.map((member) =>
        member.type === "run" ? (
          <Text key={member.run.id} wrap="truncate-end">
            <Text bold>{member.run.label.padEnd(14)}</Text>
            <Text dimColor>{member.run.command}</Text>
            {member.run.cwd && member.run.cwd !== member.run.workspace.replace(/\/[^/]+$/, "") ? <Text dimColor>{`  in ${member.run.cwd.replace(/^.*\//, "")}`}</Text> : null}
          </Text>
        ) : (
          <Text key={member.container.name} wrap="truncate-end">
            <Text bold>{member.container.service.padEnd(14)}</Text>
            <Text dimColor>{`${member.container.image}${member.container.ports.length > 0 ? `  on localhost:${member.container.ports.map((port) => port.split("→")[0]).join(", ")}` : ""}`}</Text>
          </Text>
        ),
      )}
      <Text> </Text>
      <Text dimColor>
        {group.bolt ? `x stops all of ${group.bolt} · r restarts it · ↓ to a step for its output` : "Not started by a bolt — choose one to stop it or see its output."}
      </Text>
    </Box>
  );
}

/** How a pane is found again after the list changes under it. */
export function paneKey(item: PaneItem): string {
  if (item.type === "current") return "current";
  if (item.type === "group") return `group:${item.group.key}`;
  if (item.type === "step") return `step:${item.group}:${item.index}`;
  return item.type === "run" ? item.run.id : `container:${item.container.name}`;
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

/** At most `max` characters, with an ellipsis when cut — the right side of a row never wraps. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** A finished step in a few words, to fit the list: "wait for port 5050", "open Cymph". */
function shortStep(step: HistoryStep, job: boolean): string {
  if (step.kind === "wait") {
    if (/^\d+(\.\d+)?s$/.test(step.label)) return `wait ${step.label}`;
    return `wait for ${step.label.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }
  return describeHistoryStep(step, job);
}
