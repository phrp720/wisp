import { Box, Text } from "ink";

import type { StepProgress } from "../core/history.js";
import type { Glyphs } from "./glyphs.js";

export interface GraphNode {
  label: string;
  detail?: string;
  ok: boolean;
  skipped?: boolean;
  state?: StepProgress;
  more?: boolean;
}

export function graphWidth(columns: GraphNode[][]): number {
  return columns.reduce((total, column) => total + Math.max(...column.map((node) => node.label.length + (node.detail?.length ?? 0) + 6)) + 5, 0);
}

export function Mark({ ok, skipped, running, waiting, interrupted, glyphs }: { ok: boolean; skipped?: boolean | undefined; running?: boolean | undefined; waiting?: boolean | undefined; interrupted?: boolean | undefined; glyphs: Glyphs }) {
  if (running) return <Text color="cyan">{glyphs.dot}</Text>;
  if (waiting) return <Text dimColor>{glyphs.pending}</Text>;
  if (skipped) return <Text dimColor>{glyphs.skip}</Text>;
  if (interrupted) return <Text color="yellow">!</Text>;
  return ok ? <Text color="green">{glyphs.ok}</Text> : <Text color="red">{glyphs.fail}</Text>;
}

export function StepGraph({ graph, glyphs, compact = false }: { graph: GraphNode[][]; glyphs: Glyphs; compact?: boolean }) {
  const arrow = glyphs.border === "round" ? " ──▶ " : " --> ";
  if (compact) {
    return (
      <Box flexWrap="wrap" marginTop={1}>
        {graph.map((column, at) => (
          <Box key={at} alignItems="flex-start">
            {at > 0 ? <Text dimColor>{arrow}</Text> : null}
            <Box flexDirection="column">
              {column.map((node, row) => (
                node.more ? (
                  <Text key={row} dimColor wrap="truncate-end">{`  ${node.label}`}</Text>
                ) : (
                  <Text key={row} wrap="truncate-end">
                    <Mark ok={node.ok} skipped={node.skipped} running={node.state === "running"} waiting={node.state === "waiting"} glyphs={glyphs} /> {node.label}
                    {node.detail ? <Text dimColor>{` ${node.detail}`}</Text> : null}
                  </Text>
                )
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    );
  }
  return (
    <Box flexWrap="wrap" marginTop={1}>
      {graph.map((column, at) => (
        <Box key={at} alignItems="flex-start">
          {at > 0 ? <Box marginTop={1}><Text dimColor>{glyphs.border === "round" ? " ──▶ " : " --> "}</Text></Box> : null}
          <Box flexDirection="column">
            {column.map((node, row) => (
              <Box key={row} borderStyle="round" borderColor={node.state === "running" ? "cyan" : node.state === "waiting" || node.skipped ? "gray" : node.ok ? "green" : "red"} paddingX={1}>
                <Text wrap="truncate-end">
                  <Mark ok={node.ok} skipped={node.skipped} running={node.state === "running"} waiting={node.state === "waiting"} glyphs={glyphs} /> {node.label}
                  {node.detail ? <Text dimColor>{` ${node.detail}`}</Text> : null}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function rowsOf(graph: GraphNode[][], width: number, boxed: boolean): number {
  let rows = 1;
  let used = 0;
  for (const column of graph) {
    const wide = Math.max(...column.map((node) => node.label.length + (node.detail ? node.detail.length + 1 : 0) + 2)) + (boxed ? 4 : 0) + 5;
    if (used > 0 && used + wide > width) {
      rows += 1;
      used = 0;
    }
    used += wide;
  }
  return rows;
}

export function graphHeight(graph: GraphNode[][], width: number, boxed = true): number {
  if (graph.flat().length < 2) return 0;
  const tallest = Math.max(1, ...graph.map((column) => column.length));
  return rowsOf(graph, width, boxed) * tallest * (boxed ? 3 : 1) + 1;
}

function capped(graph: GraphNode[][], most: number): GraphNode[][] {
  return graph.map((column) => (column.length <= most ? column : [...column.slice(0, most - 1), { label: `+${column.length - most + 1} more`, ok: true, state: "waiting", more: true }]));
}

export function fitGraph(graph: GraphNode[][], width: number, budget: number): { graph: GraphNode[][]; compact: boolean; height: number } | undefined {
  if (graph.length < 2 || budget < 2) return undefined;
  const boxed = graphHeight(graph, width, true);
  if (boxed <= budget) return { graph, compact: false, height: boxed };
  const flat = graphHeight(graph, width, false);
  if (flat <= budget) return { graph, compact: true, height: flat };
  const rows = rowsOf(graph, width, false);
  const most = Math.floor((budget - 1) / rows);
  if (most < 2) return undefined;
  const shown = capped(graph, most);
  return { graph: shown, compact: true, height: graphHeight(shown, width, false) };
}
