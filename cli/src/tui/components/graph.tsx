import { Box, Text } from "ink";

import type { StepProgress } from "../../core/history.js";
import type { RunState } from "../state.js";
import type { Glyphs } from "../terminal/glyphs.js";
import { collapseDag, drawDag, type DagLine } from "./dag.js";

export interface GraphNode {
  label: string;
  detail?: string;
  ok: boolean;
  skipped?: boolean;
  state?: StepProgress;
  cancelled?: boolean;
  more?: boolean;
  after: number[];
}

export interface FittedGraph {
  lines: DagLine[];
  nodes: GraphNode[];
  compact: boolean;
  height: number;
}

export function Mark({ ok, skipped, running, waiting, interrupted, cancelled, glyphs }: { ok: boolean; skipped?: boolean | undefined; running?: boolean | undefined; waiting?: boolean | undefined; interrupted?: boolean | undefined; cancelled?: boolean | undefined; glyphs: Glyphs }) {
  const { char, color } = markOf({ ok, skipped, running, waiting, interrupted, cancelled }, glyphs);
  return color === "dim" ? <Text dimColor>{char}</Text> : <Text color={color}>{char}</Text>;
}

function markOf(state: { ok: boolean; skipped?: boolean | undefined; running?: boolean | undefined; waiting?: boolean | undefined; interrupted?: boolean | undefined; cancelled?: boolean | undefined }, glyphs: Glyphs): { char: string; color: string } {
  if (state.running) return { char: glyphs.dot, color: "cyan" };
  if (state.cancelled) return { char: glyphs.cancel, color: "gray" };
  if (state.waiting) return { char: glyphs.pending, color: "dim" };
  if (state.skipped) return { char: glyphs.skip, color: "dim" };
  if (state.interrupted) return { char: "!", color: "yellow" };
  return state.ok ? { char: glyphs.ok, color: "green" } : { char: glyphs.fail, color: "red" };
}

function nodeMark(node: GraphNode, glyphs: Glyphs) {
  return markOf({ ok: node.ok, skipped: node.skipped, running: node.state === "running", waiting: node.state === "waiting", cancelled: node.cancelled }, glyphs);
}

function borderColor(node: GraphNode): string {
  if (node.state === "running") return "cyan";
  if (node.state === "waiting" || node.skipped || node.cancelled) return "gray";
  return node.ok ? "green" : "red";
}

export function hasEdges(nodes: GraphNode[]): boolean {
  return nodes.some((node) => node.after.length > 0);
}

export function graphBudget(space: number): number {
  return Math.max(Math.floor(space * 0.45), Math.min(space - 8, 9));
}

export function fitGraph(nodes: GraphNode[], width: number, budget: number, glyphs: Glyphs): FittedGraph | undefined {
  if (!hasEdges(nodes) || budget < 2) return undefined;
  const ascii = glyphs.border !== "round";
  const dag = nodes.map((node) => ({ mark: nodeMark(node, glyphs).char, label: node.label, detail: node.detail, after: node.after }));
  const boxes = drawDag(dag, { width, boxed: true, ascii });
  const wraps = boxes.some((line) => line.length === 0);
  if (!wraps && boxes.length + 1 <= budget) return { lines: boxes, nodes, compact: false, height: boxes.length + 1 };
  const lines = drawDag(dag, { width, boxed: false, ascii });
  if (lines.length + 1 <= budget) return { lines, nodes, compact: true, height: lines.length + 1 };
  for (let most = budget - 1; most >= 2; most -= 1) {
    const collapsed = collapseDag(dag, most);
    if (collapsed.nodes.length === dag.length) continue;
    const lines = drawDag(collapsed.nodes, { width, boxed: false, ascii });
    if (lines.length + 1 > budget) continue;
    const merged = collapsed.members.map((group, index): GraphNode => {
      if (group.length === 1) return { ...(nodes[group[0] as number] as GraphNode), after: (collapsed.nodes[index] as { after: number[] }).after };
      const parts = group.map((at) => nodes[at] as GraphNode);
      return {
        label: (collapsed.nodes[index] as { label: string }).label,
        ok: parts.every((part) => part.ok),
        after: (collapsed.nodes[index] as { after: number[] }).after,
        more: true,
        ...(parts.some((part) => part.state === "running") ? { state: "running" as const } : parts.every((part) => part.state === "waiting") ? { state: "waiting" as const } : {}),
      };
    });
    return { lines, nodes: merged, compact: true, height: lines.length + 1 };
  }
  return undefined;
}

export function StepGraph({ graph, glyphs }: { graph: FittedGraph; glyphs: Glyphs }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {graph.lines.map((line, at) => (
        <Text key={at} wrap="truncate-end">
          {line.length === 0 ? " " : null}
          {line.map((run, index) => {
            const node = run.node !== undefined ? graph.nodes[run.node] : undefined;
            if (run.kind === "edge" || run.kind === "detail" || (node?.more && run.kind === "label")) return <Text key={index} dimColor>{run.text}</Text>;
            if (run.kind === "border" && node) return <Text key={index} color={borderColor(node)}>{run.text}</Text>;
            if (run.kind === "mark" && node) {
              const { color } = nodeMark(node, glyphs);
              return color === "dim" ? <Text key={index} dimColor>{run.text}</Text> : <Text key={index} color={color}>{run.text}</Text>;
            }
            return <Text key={index}>{run.text}</Text>;
          })}
        </Text>
      ))}
    </Box>
  );
}

export type StepNode = GraphNode & { owner?: string | undefined; ms?: number };

function duration(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function groupByPipeline(steps: StepNode[], mark: string): GraphNode[] {
  const keys = steps.map((step, at) => (step.owner ? `pipeline:${step.owner}` : `step:${at}`));
  const order = [...new Set(keys)];
  const indexOf = new Map(order.map((key, at) => [key, at]));
  return order.map((key, index) => {
    const members = steps.filter((_step, at) => keys[at] === key);
    const after = [...new Set(steps.flatMap((step, at) => (keys[at] === key ? step.after.map((dep) => indexOf.get(keys[dep] as string) as number) : [])))].filter((dep) => dep !== undefined && dep !== index);
    const first = members[0] as StepNode;
    if (!first.owner) {
      const { owner: _owner, ms: _ms, ...node } = first;
      return { ...node, after };
    }
    const done = members.filter((step) => !step.state);
    const ms = done.reduce((sum, step) => sum + (step.ms ?? 0), 0);
    const failed = done.some((step) => !step.ok && !step.skipped && !step.cancelled);
    const running = members.some((step) => step.state === "running") || (done.length > 0 && done.length < members.length);
    const waiting = members.every((step) => step.state === "waiting");
    const count = `${members.length} step${members.length === 1 ? "" : "s"}`;
    return {
      label: `${mark}${first.owner}`,
      detail: [count, running || waiting ? "" : duration(ms)].filter(Boolean).join(" "),
      ok: !failed,
      after,
      ...(running ? { state: "running" as const } : waiting ? { state: "waiting" as const } : {}),
      ...(!running && !waiting && !failed && done.some((step) => step.cancelled) ? { cancelled: true } : {}),
      ...(!running && !waiting && done.every((step) => step.skipped) ? { skipped: true } : {}),
    };
  });
}

export function liveGraph(active: RunState, mark = ""): GraphNode[] {
  const steps = active.steps.map((step, at): StepNode => {
    const result = step.result;
    const ms = step.state === "done" ? (result?.durationMs ?? 0) : 0;
    const detail = duration(ms);
    const owner = active.owners?.[at];
    return {
      label: step.target.name ?? step.target.label,
      after: active.waits?.[at] ?? [],
      ok: step.state !== "done" || Boolean(result?.ok),
      ms,
      ...(owner ? { owner } : {}),
      ...(detail ? { detail } : {}),
      ...(step.state === "running" ? { state: "running" as const } : step.state === "pending" ? { state: "waiting" as const } : {}),
      ...(result?.skipped ? { skipped: true } : {}),
      ...(result?.cancelled ? { cancelled: true } : {}),
    };
  });
  return groupByPipeline(steps, mark);
}
