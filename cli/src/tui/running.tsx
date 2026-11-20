/** The Running screen: what bolts started, grouped under them, with live output and an activity log. */

import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { cleanOutput } from "../core/ansi.js";
import { type Container, containerMood, type ContainerStats, shortStatus } from "../core/docker.js";
import { allSteps, baseLabel, type HistoryEntry, type HistoryStep } from "../core/history.js";
import { tildify } from "../core/paths.js";
import { KEEP_FINISHED, type RunStatus } from "../core/processes.js";
import { RESTART_MARK } from "../core/shell.js";
import type { WorkspaceRead } from "../core/types.js";
import type { Glyphs } from "./glyphs.js";
import { describeHistoryStep, SearchLine } from "./history.js";
import { FilterLine, filterLog, MatchLine } from "./logfilter.js";
import { describeStep, matchesAll, windowed } from "./model.js";
import { type Activity, clock, type PaneGroup, type PaneItem, type PaneTab, type RunState, since } from "./state.js";
import { spell } from "./spells.js";
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
  /** The tab chosen for the panel; a row without it shows its logs. */
  tab?: PaneTab | undefined;
  /** The workspaces, to find a command's env and restart policy for its Info tab. */
  reads?: WorkspaceRead[];
  /** The log filter: only lines with every word of it show. `logTyping` while it is written. */
  logQuery?: string | undefined;
  logTyping?: boolean | undefined;
  glyphs: Glyphs;
  height: number;
  columns: number;
}) {
  const { items, activity, history, query, typing, runs, active, tick, stats, dockerError, all, index, log, scroll, full, reads = [], logQuery = "", logTyping = false, glyphs, height, columns } = props;
  const listWidth = paneListWidth(columns);
  const item = items[index];
  const tabs = tabsOf(item);
  const tab = shownTab(item, props.tab);
  const { lines, filtering, matched, room, total } = logWindow({ item, tab: props.tab, log, logQuery, logTyping, height });
  const end = Math.max(room, total - scroll);
  // Scrolled back: said where it can't be cut off. The tab bar has room; a long command in the header may not.
  const back = scroll > 0 && tab === "logs" ? <Text color="yellow">{`↑ ${scroll} lines back — G to follow`}</Text> : null;
  const shown = lines.slice(Math.max(0, end - room), end);
  const shownMatches = matched?.slice(Math.max(0, end - room), end);
  const numberWidth = String(lines.length).length;

  // Rows for the list: workspace headings, each bolt, then its pipeline — one line a step,
  // in the order its run went, with how each one is doing on the right.
  const list = paneList({ items, active, index, height, searching: Boolean(typing || query), activity: activity.length });
  const width = listWidth - 4;
  /** One line: the left part truncates; the right part is always shown. */
  const line = (selected: boolean, depth: number, mark: ReactNode, label: ReactNode, right: string, rightColor?: string | undefined) => (
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
  );
  const nodeOf = (entry: PaneItem, at: number): ReactNode => {
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
      const number = entry.group.number;
      return line(
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
    }
    if (entry.type === "current") {
      if (!active) return null;
      const now = active.steps.find((step) => step.state === "running");
      const failed = active.steps.some((step) => step.result && !step.result.ok && !step.result.skipped);
      const mark = !active.done ? (
        <Text color={TONE.accent}>{glyphs.running[tick % glyphs.running.length]}</Text>
      ) : failed || active.error || active.stopped ? (
        <Text color={TONE.failed}>{glyphs.fail}</Text>
      ) : (
        <Text color={TONE.up}>{glyphs.ok}</Text>
      );
      return line(selected, 0, mark, `${glyphs.bolt}${active.bolt}`, active.stopped ? "stopped" : now ? describeStep(now.target, true, active.job) : active.done ? (failed ? "failed" : "done") : waitingWords(glyphs, Math.floor(width * 0.45)), failed || active.stopped ? TONE.failed : undefined);
    }
    if (entry.type === "step") {
      const step = entry.step;
      const label = step.kind === "bolt" ? `${glyphs.bolt}${step.label}` : shortStep(step, entry.entry.job ?? false);
      if (step.state === "running") return line(selected, entry.depth ?? 1, <Text color={TONE.accent}>{glyphs.running[tick % glyphs.running.length]}</Text>, label, "running");
      if (step.state === "waiting") return line(selected, entry.depth ?? 1, <Text dimColor>{glyphs.pending}</Text>, label, "waiting", "gray");
      const mark = step.skipped ? <Text dimColor>{glyphs.skip}</Text> : step.ok ? <Text color={TONE.up}>{glyphs.ok}</Text> : <Text color={TONE.failed}>{glyphs.fail}</Text>;
      return line(selected, entry.depth ?? 1, mark, label, step.skipped ? "" : !step.ok ? "failed" : step.durationMs >= 1000 ? `${(step.durationMs / 1000).toFixed(1)}s` : "", !step.ok && !step.skipped ? TONE.failed : undefined);
    }
    if (entry.type === "run") {
      const run = entry.run;
      const restarts = selected ? restartsOf(lines) : { count: 0, gaveUp: false };
      const right = run.alive && run.waiting
        ? "waiting for an answer"
        : run.alive
        ? [`up ${since(run.startedAt).replace(" ago", "").replace("just now", "<1m")}`, restarts.count > 0 ? `${restarts.count}× restarted` : ""].filter(Boolean).join(" · ")
        : restarts.gaveUp
          ? "gave up"
          : endedAs(run);
      const failedRun = restarts.gaveUp || (!run.alive && run.exitCode !== undefined && run.exitCode !== 0);
      return line(selected, entry.depth ?? 1, <Text color={run.waiting ? TONE.busy : run.alive ? TONE.up : failedRun ? TONE.failed : TONE.stopped}>{glyphs.dot}</Text>, run.label, right, run.waiting ? TONE.busy : failedRun ? TONE.failed : undefined);
    }
    const container = entry.container;
    const mood = containerMood(container);
    const color = mood.tone === "good" ? TONE.up : mood.tone === "busy" ? TONE.busy : mood.tone === "bad" ? TONE.failed : TONE.stopped;
    return line(selected, entry.depth ?? 1, <Text color={color}>{glyphs.dot}</Text>, container.service, mood.word, mood.tone === "bad" ? TONE.failed : undefined);
  };

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
        {item.run.alive && item.run.waiting ? <Text color={TONE.busy}>{`  ${glyphs.dot} waiting for an answer: "${item.run.waiting}"`}</Text> : item.run.alive ? <Text color={TONE.up}>{`  ${glyphs.dot} running`}</Text> : <Text color={item.run.exitCode ? TONE.failed : TONE.stopped}>{`  ${glyphs.dot} ${endedAs(item.run)}`}</Text>}
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
          {items.length === 0 ? <Text dimColor>{query ? `Nothing matches “${query}”. esc clears it.` : all ? "Nothing has run yet." : "Nothing is running right now. Run a bolt from the Bolts tab (1), or press \"o\" to show the ones that stopped."}</Text> : null}
          {dockerError ? <Text color="yellow" wrap="wrap">{`Docker: ${dockerError}`}</Text> : null}
          {list.visible.map((row) => (
            <Box key={row.key}>{row.kind === "item" ? nodeOf(items[row.at] as PaneItem, row.at) : row.kind === "heading" ? <Text bold dimColor>{row.text}</Text> : <Text> </Text>}</Box>
          ))}
          <Box flexGrow={1} />
          {list.logRoom > 0 ? (
            <Box flexDirection="column">
              <Text bold dimColor>ACTIVITY</Text>
              {activity.slice(0, list.logRoom - 1).map((entry) => (
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
        {tabs.length > 0 ? <TabBar tabs={tabs} tab={tab} glyphs={glyphs} note={back} /> : null}
        <Text wrap="truncate-end">
          {header}
          {back && tabs.length === 0 ? <Text>{"  "}{back}</Text> : null}
        </Text>
        {filtering ? (
          <FilterLine
            query={logQuery}
            typing={logTyping}
            found={matched ? <Text color={matched.length === 0 ? TONE.failed : undefined} dimColor={matched.length > 0}>{matched.length === 0 ? `no line matches, of ${lines.length}` : `${matched.length} of ${lines.length} line${lines.length === 1 ? "" : "s"}`}</Text> : <Text dimColor>type to keep only the lines with it</Text>}
          />
        ) : null}
        {shownMatches ? (
          shownMatches.map((match) => <MatchLine key={match.at} at={match.at} text={match.text} query={logQuery} width={numberWidth} />)
        ) : tab === "info" && item?.type === "run" ? (
          <Details rows={runDetails(item.run, reads, history, lines)} room={room} />
        ) : tab === "info" && item?.type === "container" ? (
          <Details rows={containerDetails(item.container, stats.get(item.container.name))} room={room} />
        ) : tab === "runs" && item?.type === "run" ? (
          <PastRuns run={item.run} runs={runs} history={history} glyphs={glyphs} room={room} />
        ) : item?.type === "run" && !item.run.log ? (
          <Text dimColor>{`It runs in ${item.run.where ?? "a terminal window"} — its output is there.`}</Text>
        ) : item?.type === "group" ? (
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

  for (const found of groups.values()) {
    found.members = pipeline(found.group, found.members, history);
    const from = found.members.find((member) => member.type === "step");
    if (from?.type === "step" && baseLabel(from.entry.bolt) === found.group.bolt && from.entry.number) found.group.number = from.entry.number;
  }
  nestNeededBolts(groups, history);

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
 * A bolt that came up only because another bolt needed it is part of that run, the way
 * GitHub shows a called workflow inside the run that called it: its containers and commands
 * move under the "⚡ Services" line of the bolt that needed it, and its own group goes.
 * Run on its own since, it keeps its own place.
 */
function nestNeededBolts(groups: Map<string, { group: PaneGroup; members: PaneItem[] }>, history: HistoryEntry[]): void {
  for (const [key, found] of groups) {
    const { bolt, workspace } = found.group;
    if (!bolt || !workspace || !groups.has(key)) continue;
    const entry = history.find((candidate) => candidate.workspace === workspace && baseLabel(candidate.bolt) === bolt);
    if (!entry) continue;
    for (const member of [...found.members]) {
      if (member.type !== "step" || member.step.kind !== "bolt" || member.entry !== entry) continue;
      const neededKey = `${workspace}#${member.step.label}`;
      const needed = groups.get(neededKey);
      if (!needed || neededKey === key) continue;
      // Only when this run is the newest that touched it: run on its own later, it's its own.
      const latest = history.find(
        (candidate) => candidate.workspace === workspace && (baseLabel(candidate.bolt) === member.step.label || candidate.steps.some((step) => step.bolt === member.step.label)),
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
 * A bolt's members in pipeline order. Its last run in History gives the order and the
 * finished steps; what is running takes the place of the step that started it. A bolt it
 * needed is one line, however many steps it had — it has its own place in the list.
 */
function pipeline(group: PaneGroup, members: PaneItem[], history: HistoryEntry[]): PaneItem[] {
  if (!group.bolt || !group.workspace) return members;
  const owns = (entry: HistoryEntry, step: HistoryStep) => (step.bolt ?? baseLabel(entry.bolt)) === group.bolt;
  const entry = history.find((candidate) => candidate.workspace === group.workspace && !candidate.bolt.endsWith(" (down)") && allSteps(candidate).some((step) => owns(candidate, step)));
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
  const all = allSteps(entry);
  all.forEach((step, index) => {
    if (!owns(entry, step)) {
      if (!own) return;
      // A step of a bolt this one needed: one line for that bolt, where it ran — its output
      // the last thing it printed.
      const name = step.bolt ?? "";
      if (!name || needed.has(name)) return;
      needed.add(name);
      const its = all.filter((candidate) => candidate.bolt === name);
      const done = its.filter((candidate) => !candidate.state);
      const printed = [...its].reverse().find((candidate) => candidate.log && candidate.state !== "waiting")?.log;
      const state = its.some((candidate) => candidate.state === "running") ? "running" : done.length === 0 ? "waiting" : undefined;
      ordered.push({
        type: "step",
        entry,
        index,
        group: group.key,
        step: { kind: "bolt", label: name, value: name, ok: done.every((candidate) => candidate.ok), ...(done.length > 0 && done.every((candidate) => candidate.skipped) ? { skipped: true } : {}), durationMs: done.reduce((sum, candidate) => sum + candidate.durationMs, 0), ...(printed ? { log: printed } : {}), ...(state ? { state } : {}) },
      });
      return;
    }
    if (step.kind === "command" && !entry.job && !step.state) {
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
 * The Running list narrowed to a search. A bolt that matches keeps all of its tasks; a task
 * that matches keeps its bolt, so you still see where it belongs, and so does a task inside
 * a bolt this one needed keep that bolt's line ("⚡ Services" over postgres). The run in
 * progress stays when its bolt matches.
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

/** A line of the Running list: a heading, the gap before one, or one of the items. */
export type PaneRow = { key: string; kind: "gap" | "heading"; text: string } | { key: string; kind: "item"; at: number };

/**
 * The Running list, line by line: each workspace's heading before its bolts, and the items.
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
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** A finished step in a few words, to fit the list: "wait for port 5050", "open Acme". */
function shortStep(step: HistoryStep, job: boolean): string {
  if (step.kind === "wait") {
    if (/^\d+(\.\d+)?s$/.test(step.label)) return `wait ${step.label}`;
    return `wait for ${step.label.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }
  return describeHistoryStep(step, job);
}

/** How a command that is no longer running ended: by itself, with a failure, or stopped. */
function endedAs(run: { exitCode?: number }): string {
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

/** The next row with a log of its own, going `by` from `at`: bolt rows have none, so they are passed over. */
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
 * bolt, a finished step) has one view, and no tabs.
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

function TabBar({ tabs, tab, glyphs, note }: { tabs: PaneTab[]; tab: PaneTab; glyphs: Glyphs; note?: ReactNode }) {
  return (
    <Text wrap="truncate-end">
      {tabs.map((entry, at) => (
        <Text key={entry}>
          {at > 0 ? <Text dimColor>{tabSeparator(glyphs)}</Text> : null}
          {entry === tab ? (
            <Text bold underline color={TONE.accent}>
              {TAB_TITLE[entry]}
            </Text>
          ) : (
            <Text dimColor>{TAB_TITLE[entry]}</Text>
          )}
        </Text>
      ))}
      {note ? <Text>{"   "}{note}</Text> : <Text dimColor>{"   [ ] switch"}</Text>}
    </Text>
  );
}

/** One line of an Info tab: what it is, its value, and a colour when the value is a state. */
export type Detail = { label: string; value: string; color?: string | undefined };

function Details({ rows, room }: { rows: Detail[]; room: number }) {
  const width = Math.max(...rows.map((row) => row.label.length)) + 2;
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.slice(0, Math.max(1, room - 1)).map((row, at) => (
        <Text key={`${row.label}:${at}`} wrap="truncate-end">
          <Text dimColor>{row.label.padEnd(width)}</Text>
          <Text color={row.color}>{row.value}</Text>
        </Text>
      ))}
    </Box>
  );
}

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

function PastRuns({ run, runs, history, glyphs, room }: { run: RunStatus; runs: RunStatus[]; history: HistoryEntry[]; glyphs: Glyphs; room: number }) {
  const all = pastRuns(run, runs);
  const list = all.length > 0 ? all : [run];
  // Room for the list, a blank line above it and the note under it.
  const fits = Math.max(1, room - 3);
  return (
    <Box flexDirection="column" marginTop={1}>
      {list.slice(0, fits).map((candidate) => {
        const failed = !candidate.alive && candidate.exitCode !== undefined && candidate.exitCode !== 0;
        const state = candidate.alive ? (candidate.waiting ? "waiting for an answer" : "running") : endedAs(candidate);
        const color = candidate.alive ? (candidate.waiting ? TONE.busy : TONE.up) : failed ? TONE.failed : TONE.stopped;
        const self = candidate.id === run.id;
        return (
          <Text key={candidate.id} wrap="truncate-end">
            <Text color={TONE.accent}>{self ? glyphs.pointer : " "}</Text>
            <Text color={color}>{` ${glyphs.dot} `}</Text>
            <Text bold={self}>{when(candidate.startedAt).padEnd(13)}</Text>
            <Text color={failed ? TONE.failed : undefined} dimColor={!failed}>{state.padEnd(18)}</Text>
            <Text dimColor>{`${candidate.id}${startedBy(candidate, history, undefined, true)}`}</Text>
          </Text>
        );
      })}
      {list.length > fits ? <Text dimColor>{`  and ${list.length - fits} more`}</Text> : null}
      <Text dimColor wrap="truncate-end">{`  wisp logs <id> prints any of them. Wisp keeps the last ${KEEP_FINISHED} that ended.`}</Text>
    </Box>
  );
}
