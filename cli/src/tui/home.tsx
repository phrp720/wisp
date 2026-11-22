/** The main screen: workspaces on the left, the selected one's bolts on the right; and search. */

import { Box, Text } from "ink";
import { Fragment, type ReactNode } from "react";

import type { Container } from "../core/docker.js";
import { baseLabel, type HistoryEntry } from "../core/history.js";
import { tildify } from "../core/paths.js";
import type { RunStatus } from "../core/processes.js";
import { pipelineStatus } from "../core/switch.js";
import type { Pipeline, Diagnostic, WorkspaceRead } from "../core/types.js";
import { sharedNames, slugify } from "../core/workspaces.js";
import { shortest } from "../cli/lib/render.js";
import { AskHere } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { type SearchHit, windowed } from "./model.js";
import { flow, planGraph, stepLines, usedBy } from "./steps.js";
import { fitGraph, StepGraph } from "./graph.js";
import { counts, needsTrust, since } from "./state.js";
import { TONE } from "./tones.js";

/**
 * Every workspace, grouped by where it comes from — said in words rather than marks: the
 * project of the folder Wisp was opened in, the other projects you have used, and the
 * personal workspaces.
 */
export interface Asking {
  question: string;
  yes: string;
  no?: string;
  onAnswer: (yes: boolean) => void;
}

export function WorkspaceList(props: { reads: WorkspaceRead[]; index: number; here?: string | undefined; focused: boolean; glyphs: Glyphs; height: number; width: number; confirming?: Asking | undefined }) {
  const { reads, index, here, focused, glyphs, height, width, confirming } = props;
  const items = workspaceRows(reads, here, index, height - (confirming ? 3 : 0));
  const shared = sharedNames(reads.map((read) => read.workspace));

  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle={glyphs.border} borderColor={focused ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
      <Text bold dimColor={!focused}>
        Workspaces
      </Text>
      {items.map((row) => {
        if ("heading" in row) {
          return (
            <Text key={`h:${row.heading}`} dimColor>
              {row.heading.toUpperCase()}
            </Text>
          );
        }
        const { read, at } = row;
        const selected = at === index;
        const warn = !read.workspace.personal && read.withheld.length > 0 && !read.workspace.trusted;
        return (
          // Only the name is highlighted: inverting coloured pieces separately makes a patchwork.
          // "!" marks a file not allowed to run its commands yet — the panel beside says why.
          <Fragment key={read.workspace.file}>
            <Text wrap="truncate-end" bold={selected}>
              {selected ? glyphs.pointer : " "}{" "}
              {read.workspace.icon && glyphs.border === "round" ? `${read.workspace.icon} ` : ""}
              <Text color={selected && confirming ? "red" : selected && focused ? undefined : read.workspace.color} inverse={selected && (focused || Boolean(confirming))}>{read.workspace.name}</Text>
              {warn ? <Text color={TONE.busy} bold>{" !"}</Text> : null}
              {shared.has(slugify(read.workspace.name)) ? <Text dimColor>{` ${read.workspace.personal ? "personal" : tildify(read.workspace.file.replace(/[\\/]\.wisp\.json$/, ""))}`}</Text> : null}
            </Text>
            {selected && confirming ? <AskHere stacked question={confirming.question} yes={confirming.yes} onAnswer={confirming.onAnswer} /> : null}
          </Fragment>
        );
      })}
    </Box>
  );
}

/** How wide the workspace list is, the bolts panel taking the rest. */
export function workspaceListWidth(columns: number): number {
  return Math.min(32, Math.max(18, Math.floor(columns * 0.28)));
}

/**
 * The workspace list's lines that fit: headings and workspaces as rows, so a long list
 * scrolls with its headings in place. Drawn from this, and clicks are matched against it.
 */
export function workspaceRows(reads: WorkspaceRead[], here: string | undefined, index: number, height: number): ({ heading: string } | { read: WorkspaceRead; at: number })[] {
  const group = (read: WorkspaceRead) => (read.workspace.file === here ? "This folder" : read.workspace.personal ? "Yours" : "Projects");
  const rows: ({ heading: string } | { read: WorkspaceRead; at: number })[] = [];
  reads.forEach((read, at) => {
    const previous = reads[at - 1];
    if (!previous || group(previous) !== group(read)) rows.push({ heading: group(read) });
    rows.push({ read, at });
  });
  const selectedRow = Math.max(0, rows.findIndex((row) => "at" in row && row.at === index));
  return windowed(rows, selectedRow, height - 3).items;
}

/** The line of the bolts panel its first bolt is on, counted from the panel's top border. */
export const FIRST_PIPELINE_LINE = 5;

const HEAD = 6;

export function pipelineWindow<T>(bolts: T[], pipelineIndex: number, height: number, asking = false): { items: T[]; offset: number; split: boolean; topHeight: number; stepRoom: number } {
  if (height >= 18 && bolts.length > 0) {
    const rows = Math.max(1, Math.min(bolts.length, Math.floor(height / 2) - HEAD));
    return { ...windowed(bolts, pipelineIndex, rows), split: true, topHeight: HEAD + rows + (asking ? 1 : 0), stepRoom: 0 };
  }
  const listRoom = Math.max(2, height - HEAD - 2);
  const rows = Math.max(1, Math.min(bolts.length, Math.ceil(listRoom / 2)));
  return { ...windowed(bolts, pipelineIndex, rows), split: false, topHeight: height, stepRoom: Math.max(1, listRoom - rows - (asking ? 1 : 0)) };
}

interface PipelineState {
  text: string;
  color: string;
  dim?: boolean;
}

export function WorkspacePanel(props: {
  read: WorkspaceRead;
  reads: WorkspaceRead[];
  pipelineIndex: number;
  focused: boolean;
  glyphs: Glyphs;
  height: number;
  width?: number;
  here?: boolean;
  runs: RunStatus[];
  containers: Container[];
  history: HistoryEntry[];
  confirming?: Asking | undefined;
  scroll?: number;
  scrollLimit?: { current: number };
  instead?: ((room: number) => ReactNode) | undefined;
  diagnostics?: Diagnostic[];
  graph?: boolean;
}) {
  const { read, reads, pipelineIndex, focused, glyphs, height, width = 80, here = false, runs, containers, history, confirming, scroll = 0, scrollLimit, instead, graph = true } = props;
  const problems = (props.diagnostics ?? read.diagnostics).filter((entry) => entry.level !== "note" && entry.at !== "trust");
  const problemsOf = (entry: Pipeline) => problems.filter((problem) => problem.pipeline?.toLowerCase() === entry.label.toLowerCase());
  const fileProblems = problems.filter((problem) => !problem.pipeline || !read.workspace.bolts.some((entry) => entry.label.toLowerCase() === problem.pipeline?.toLowerCase()));
  const lastRun = (label: string) => history.find((entry) => baseLabel(entry.bolt) === label);
  const { workspace } = read;
  const bolts = workspace.bolts;
  const selected = bolts[Math.min(pipelineIndex, Math.max(0, bolts.length - 1))];
  const { items: shownPipelines, offset, split, topHeight, stepRoom } = pipelineWindow(bolts, pipelineIndex, height, Boolean(confirming));

  const stateOf = (entry: Pipeline): PipelineState | undefined => {
    const status = pipelineStatus(workspace, entry, runs, containers);
    if (status.failing > 0) return { text: `${glyphs.dot} something stopped`, color: "red" };
    if (status.running > 0) {
      const all = status.running === status.commands;
      return { text: `${glyphs.dot} ${all ? "running" : `${status.running} of ${status.commands} running`}`, color: all ? "green" : "yellow" };
    }
    const errors = problemsOf(entry).filter((problem) => problem.level === "error").length;
    if (errors > 0) return { text: `${glyphs.fail} ${errors} problem${errors === 1 ? "" : "s"}`, color: "red" };
    const last = lastRun(entry.label);
    if (!last) return undefined;
    if (last.running) return { text: `${glyphs.dot} running, step ${Math.min(last.steps.length + 1, last.total ?? last.steps.length + 1)} of ${last.total ?? "?"}`, color: "cyan" };
    if (last.interrupted) return { text: `! interrupted ${since(last.startedAt)}`, color: "yellow" };
    return last.ok ? { text: `${glyphs.ok} ${since(last.startedAt)}`, color: "green", dim: true } : { text: `${glyphs.fail} failed ${since(last.startedAt)}`, color: "red" };
  };

  const rows = shownPipelines.map((entry) => ({ entry, state: stateOf(entry) }));
  const stateWidth = Math.max(0, ...rows.map(({ state }) => state?.text.length ?? 0));
  const stateColumn = stateWidth > 0 ? stateWidth + 3 : 0;
  const longest = Math.max(0, ...rows.map(({ entry }) => entry.label.length));
  const showSteps = 2 + Math.min(longest, 24) + stateColumn + 10 <= width;
  const labelWidth = Math.max(10, Math.min(longest, width - 2 - stateColumn - (showSteps ? 10 : 0)));

  const header = (
    <>
      <Text wrap="truncate-end">
        {workspace.icon && glyphs.border === "round" ? `${workspace.icon} ` : ""}
        <Text bold color={workspace.color}>{workspace.name}</Text>
        <Text dimColor>{`  ${counts(read)}`}</Text>
        {reads.some((other) => other.workspace.file !== workspace.file && slugify(other.workspace.name) === slugify(workspace.name)) ? (
          <Text color="yellow">{`  ! another workspace is called ${workspace.name} too: rename one with e on the left`}</Text>
        ) : null}
      </Text>
      <Text dimColor wrap="truncate-start">{tildify(workspace.file) + (workspace.local ? "  + local" : "")}</Text>
      <Text wrap="truncate-end">
        {needsTrust(read) ? (
          <Text color="yellow">{`${read.trust === "stale" ? "Changed since you trusted it" : "Not trusted yet"}: press t to review ${read.withheld.length === 1 ? "it" : `the ${read.withheld.length}`}`}</Text>
        ) : workspace.personal ? (
          <Text dimColor>Yours — its commands run without asking</Text>
        ) : read.declaredCommands.length > 0 ? (
          <Text color="green">{`${glyphs.ok} Trusted`}</Text>
        ) : (
          <Text dimColor>nothing here runs code</Text>
        )}
        {fileProblems[0] ? <Text color={fileProblems[0].level === "error" ? "red" : "yellow"}>{`  ${fileProblems[0].level === "error" ? glyphs.fail : "!"} ${fileProblems[0].message}`}</Text> : null}
      </Text>
      <Text> </Text>
    </>
  );

  const list =
    bolts.length === 0 ? (
      <>
        <Text bold={focused}>
          {focused ? glyphs.pointer : " "} <Text color={focused ? undefined : "magenta"} inverse={focused}>+ add a pipeline</Text>
        </Text>
        <Text> </Text>
        <Text dimColor>{"  A pipeline is one thing you do, like \"Work on the API\": what to start, in order."}</Text>
      </>
    ) : (
      rows.map(({ entry, state }, position) => {
        const isSelected = offset + position === pipelineIndex;
        const name = clip(entry.label, Math.max(4, labelWidth));
        const gap = " ".repeat(Math.max(0, labelWidth - name.length));
        const count = entry.steps.length;
        return (
          <Fragment key={entry.id}>
            <Text wrap="truncate-end" bold={isSelected}>
              {isSelected ? glyphs.pointer : " "} <Text color={isSelected && confirming ? "red" : isSelected && focused ? undefined : entry.color} inverse={isSelected && focused}>{name}</Text>
              {gap}
              {stateWidth > 0 ? (
                state ? <Text color={state.color} dimColor={state.dim ?? false}>{`   ${state.text.padEnd(stateWidth)}`}</Text> : <Text>{" ".repeat(stateWidth + 3)}</Text>
              ) : null}
              {showSteps ? <Text dimColor>{`   ${count} step${count === 1 ? "" : "s"}`}</Text> : null}
            </Text>
            {isSelected && confirming ? <AskHere question={confirming.question} yes={confirming.yes} {...(confirming.no ? { no: confirming.no } : {})} onAnswer={confirming.onAnswer} /> : null}
          </Fragment>
        );
      })
    );

  const room = split ? Math.max(1, height - topHeight - 2) : stepRoom;
  const details = selected ? (
    <PipelineDetails
      read={read}
      bolt={selected}
      state={stateOf(selected)}
      last={lastRun(selected.label)}
      here={here}
      glyphs={glyphs}
      full={split}
      room={room}
      reads={reads}
      runs={runs}
      containers={containers}
      scroll={scroll}
      scrollLimit={scrollLimit}
      problems={[...problemsOf(selected), ...fileProblems]}
      width={Math.max(10, width - 4)}
      graph={graph}
    />
  ) : null;

  if (!split) {
    if (selected && instead) return <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>{instead(height)}</Box>;
    return (
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} borderStyle={glyphs.border} borderColor={focused ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
        {header}
        {list}
        {details ? <Text> </Text> : null}
        {details}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
      <Box flexDirection="column" height={topHeight} flexShrink={0} borderStyle={glyphs.border} borderColor={focused ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
        {header}
        {list}
      </Box>
      {selected && instead ? (
        instead(Math.max(3, height - topHeight))
      ) : (
        <Box flexDirection="column" flexGrow={1} borderStyle={glyphs.border} borderColor="gray" paddingX={1} overflow="hidden">
          {details}
        </Box>
      )}
    </Box>
  );
}

function PipelineDetails(props: {
  read: WorkspaceRead;
  bolt: Pipeline;
  state: PipelineState | undefined;
  last: HistoryEntry | undefined;
  here: boolean;
  glyphs: Glyphs;
  full: boolean;
  room: number;
  reads: WorkspaceRead[];
  runs: RunStatus[];
  containers: Container[];
  scroll: number;
  scrollLimit?: { current: number } | undefined;
  problems: Diagnostic[];
  width: number;
  graph: boolean;
}) {
  const { read, bolt, state, last, here, glyphs, full, room, reads, runs, containers, scroll, scrollLimit, problems, width } = props;
  const notes = bolt.notes ? twoLines(bolt.notes, full ? width : width - 2) : [];
  const inputNames = (bolt.inputs ?? []).map((input) => input.name);
  const { workspace } = read;
  const plan = full && props.graph ? planGraph(read, bolt, glyphs) : [];
  const stages = planGraph(read, bolt, glyphs);
  const together = stages.length === 1 && bolt.steps.every((step) => step.kind !== "pipeline") ? (stages[0]?.length ?? 0) : 0;
  const needs = flow(read, bolt);
  const neededBy = usedBy(read, bolt);
  const typed = here ? shortest(bolt, workspace.bolts, true) : `${slugify(workspace.name)} ${shortest(bolt, workspace.bolts)}`;

  const problemLines = problems.length > 0 ? problems.reduce((sum, problem) => sum + 1 + (problem.hint ? 1 : 0), 0) + 1 : 0;
  const above = (full ? 1 + notes.length + (needs.length > 1 ? 1 : 0) + 2 : notes.length + 1) + problemLines;
  const bottom = full ? 3 + (inputNames.length > 0 ? 1 : 0) : 0;
  const drawn = fitGraph(plan, width, Math.floor((room - above - bottom) * 0.45));
  const lines = stepLines({ read, bolt, reads, runs, containers, glyphs, after: !drawn });
  const space = Math.max(1, room - above - bottom - (drawn ? drawn.height + 1 : 0));
  const overflow = lines.length > space;
  const fit = overflow ? Math.max(1, space - 1) : lines.length;
  const most = Math.max(0, lines.length - fit);
  if (scrollLimit) scrollLimit.current = most;
  const top = Math.min(scroll, most);
  const below = lines.length - top - fit;

  const facts = [
    bolt.confirm ? `asks first: ${bolt.confirm}` : "",
    last ? (last.running ? `running now, #${last.number ?? ""}` : `last run ${last.interrupted ? "!" : last.ok ? glyphs.ok : glyphs.fail} #${last.number ?? ""} ${since(last.startedAt)}`) : "never run yet",
    neededBy.length > 0 ? `needed by ${neededBy.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      {full ? (
        <Text wrap="truncate-end">
          <Text color={TONE.accent}>{glyphs.bolt}</Text>
          <Text bold color={bolt.color}>{bolt.label}</Text>
          {state ? <Text color={state.color} dimColor={state.dim ?? false}>{`   ${state.text}`}</Text> : null}
        </Text>
      ) : null}
      {notes.map((line, at) => (
        <Text key={`note${at}`} wrap="truncate-end">{full ? line : `  ${line}`}</Text>
      ))}
      {full && needs.length > 1 ? (
        <Text wrap="truncate-end">
          <Text dimColor>order  </Text>
          {needs.map((name, at) => (
            <Text key={name}>
              {at > 0 ? <Text dimColor>{` ${glyphs.border === "round" ? "──▶" : "->"} `}</Text> : null}
              <Text bold={at === needs.length - 1}>{name}</Text>
            </Text>
          ))}
        </Text>
      ) : null}
      {full ? <Text> </Text> : null}
      {problems.length > 0 ? (
        <Box flexDirection="column" paddingLeft={full ? 0 : 2} flexShrink={0}>
          {problems.map((problem, at) => (
            <Box key={`${problem.at}:${at}`} flexDirection="column">
              <Text color={problem.level === "error" ? "red" : "yellow"} wrap="wrap">{`${problem.level === "error" ? glyphs.fail : "!"} ${problem.pipeline && problem.pipeline.toLowerCase() === bolt.label.toLowerCase() ? "" : "In the file: "}${problem.message}`}</Text>
              {problem.hint ? <Text dimColor wrap="wrap">{`  ${problem.hint}`}</Text> : null}
            </Box>
          ))}
          <Text> </Text>
        </Box>
      ) : null}
      {lines.length === 0 ? (
        <Text dimColor>{full ? "It has no steps yet — press e to add some." : "  It has no steps yet — press e to add some."}</Text>
      ) : (
        <Box flexDirection="column" paddingLeft={full ? 0 : 2} flexShrink={0}>
          <Text dimColor>{together > 1 ? `When you run it, these ${together} run at the same time${bolt.keepGoing ? ", and it keeps going if one fails" : ""}:` : bolt.keepGoing ? "When you run it, it will (and keep going if a step fails):" : "When you run it, it will:"}</Text>
          {drawn ? (
            <Box marginBottom={1}>
              <StepGraph graph={drawn.graph} compact={drawn.compact} glyphs={glyphs} />
            </Box>
          ) : null}
          {lines.slice(top, top + fit).map((line) => (
            <Box key={line.key}>{line.node}</Box>
          ))}
          {overflow ? <Text dimColor>{[top > 0 ? `${top} above` : "", below > 0 ? `${below} more below` : "", "u d scroll"].filter(Boolean).join(" · ")}</Text> : null}
        </Box>
      )}
      {full ? (
        <>
          <Box flexGrow={1} />
          <Box borderStyle={glyphs.border === "round" ? "single" : "classic"} borderColor="gray" borderDimColor borderTop borderBottom={false} borderLeft={false} borderRight={false} />
          {inputNames.length > 0 ? (
            <Text wrap="truncate-end">
              <Text dimColor>inputs: </Text>
              <Text>{inputNames.join(", ")}</Text>
            </Text>
          ) : null}
          <Text dimColor wrap="truncate-end">{facts}</Text>
          <Text wrap="truncate-end">
            <Text dimColor>from a terminal: </Text>
            <Text color="cyan">{`wisp ${typed}`}</Text>
          </Text>
        </>
      ) : null}
    </>
  );
}

function twoLines(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const [at, word] of words.entries()) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width || !line) {
      line = next;
      continue;
    }
    if (lines.length === 1) return [...lines, clip(`${line} ${words.slice(at).join(" ")}`, width)];
    lines.push(line);
    line = word;
  }
  return [...lines, clip(line, width)];
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function SearchPanel({ hits, index, query, glyphs, height }: { hits: SearchHit[]; index: number; query: string; glyphs: Glyphs; height: number }) {
  const { items, offset } = windowed(hits, index, height - 4);
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1}>
      <Text>
        <Text color={TONE.accent}>/ </Text>
        {query}
        <Text inverse> </Text>
      </Text>
      <Text> </Text>
      {hits.length === 0 ? <Text dimColor>no matches</Text> : null}
      {items.map((hit, position) => {
        const selected = offset + position === index;
        return (
          <Text key={`${hit.workspace}:${hit.bolt ?? ""}`} wrap="truncate-end" inverse={selected}>
            {selected ? glyphs.pointer : " "} {hit.label}
            {hit.bolt ? null : <Text dimColor> workspace</Text>}
          </Text>
        );
      })}
    </Box>
  );
}

export function Empty({ glyphs, height, unreadable }: { glyphs: Glyphs; height: number; unreadable: number }) {
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} paddingX={1}>
      <Text bold>No workspaces yet</Text>
      <Text> </Text>
      <Text>In a project, quit and run <Text color="cyan">wisp init</Text> to give it a .wisp.json.</Text>
      <Text>Already have some? <Text color="cyan">wisp scan ~/dev</Text> finds them.</Text>
      {unreadable > 0 ? <Text color="red">{`${unreadable} workspace file(s) could not be read — wisp list`}</Text> : null}
    </Box>
  );
}
