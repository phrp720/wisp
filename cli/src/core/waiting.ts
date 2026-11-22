import type { Withheld, WorkspaceRead } from "./types.js";

/**
 * What running a bolt would skip for want of trust: its own steps, and those of the bolts in
 * the same workspace that it needs first. Run anyway, it would start only part of what it
 * lists, so the TUI and the command line both ask before it starts anything.
 *
 * With no bolt (`--all`), everything the file holds back.
 */
export function waitingForTrust(read: WorkspaceRead, label?: string): Withheld[] {
  const { workspace } = read;
  if (workspace.personal || workspace.trusted || read.withheld.length === 0) return [];
  if (label === undefined) return read.withheld;

  const held = new Map(read.withheld.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const found = new Map<string, Withheld>();
  const visit = (name: string) => {
    const bolt = workspace.bolts.find((entry) => entry.label === name);
    if (!bolt || seen.has(bolt.label)) return;
    seen.add(bolt.label);
    for (const step of bolt.steps) {
      const id = step.kind === "asset" ? step.id : step.kind === "compose" ? `compose:${step.file}` : step.kind === "wait" ? step.held : undefined;
      const item = id ? held.get(id) : undefined;
      if (item) found.set(item.id, item);
      if (step.kind === "pipeline") visit(step.bolt);
    }
  };
  visit(label);
  return [...found.values()];
}
