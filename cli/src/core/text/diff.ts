import { diffLines as changedLines } from "diff";

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

export function diffLines(before: string, after: string): DiffLine[] {
  return changedLines(withNewline(before), withNewline(after)).flatMap((change) => {
    const kind = change.added ? "added" : change.removed ? "removed" : "same";
    return change.value.replace(/\n$/, "").split("\n").map((text) => ({ kind, text }) as DiffLine);
  });
}

function withNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

export function hunks(lines: DiffLine[], context = 2): DiffLine[][] {
  const near = lines.map(() => false);
  lines.forEach((line, at) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, at - context); k <= Math.min(lines.length - 1, at + context); k += 1) near[k] = true;
  });

  const out: DiffLine[][] = [];
  let current: DiffLine[] | undefined;
  lines.forEach((line, at) => {
    if (!near[at]) {
      current = undefined;
      return;
    }
    if (!current) {
      current = [];
      out.push(current);
    }
    current.push(line);
  });
  return out;
}

export function unifiedDiff(lines: DiffLine[], context = 2): string {
  const mark = { same: " ", added: "+", removed: "-" } as const;
  return hunks(lines, context)
    .map((hunk) => hunk.map((line) => `${mark[line.kind]} ${line.text}`).join("\n"))
    .join("\n…\n");
}
