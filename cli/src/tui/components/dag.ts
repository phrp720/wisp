export interface DagNode {
  mark: string;
  label: string;
  detail?: string | undefined;
  after: number[];
}

export type RunKind = "edge" | "border" | "mark" | "label" | "detail" | "space";

export interface DagRun {
  text: string;
  kind: RunKind;
  node?: number;
}

export type DagLine = DagRun[];

export interface DagOptions {
  width: number;
  boxed: boolean;
  ascii?: boolean;
  tight?: boolean;
}

const MAX_LABEL = 28;

const LEFT = 1;
const RIGHT = 2;
const UP = 4;
const DOWN = 8;

const ROUND: Record<number, string> = {
  [LEFT]: "─", [RIGHT]: "─", [LEFT | RIGHT]: "─",
  [UP]: "│", [DOWN]: "│", [UP | DOWN]: "│",
  [RIGHT | DOWN]: "╭", [RIGHT | UP]: "╰", [LEFT | DOWN]: "╮", [LEFT | UP]: "╯",
  [LEFT | RIGHT | DOWN]: "┬", [LEFT | RIGHT | UP]: "┴", [UP | DOWN | RIGHT]: "├", [UP | DOWN | LEFT]: "┤",
  [LEFT | RIGHT | UP | DOWN]: "┼",
};

function lineChar(bits: number, ascii: boolean): string {
  if (bits === 0) return " ";
  if (!ascii) return ROUND[bits] ?? "┼";
  if (bits === LEFT || bits === RIGHT || bits === (LEFT | RIGHT)) return "-";
  if (bits === UP || bits === DOWN || bits === (UP | DOWN)) return "|";
  return "+";
}

export function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/[\p{Mn}‍︎️]/u.test(char)) continue;
    width += /[\p{Emoji_Presentation}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char) ? 2 : 1;
  }
  return width;
}

export function clip(text: string, most: number): string {
  if (cellWidth(text) <= most) return text;
  let out = "";
  for (const char of text) {
    if (cellWidth(`${out}${char}…`) > most) break;
    out += char;
  }
  return `${out}…`;
}

interface Item {
  layer: number;
  node?: number;
  preds: number[];
  succs: number[];
}

interface Gap {
  width: number;
  start: number;
  channel: Map<number, number>;
  groups: { sources: number[]; targets: number[] }[];
}

export function layerDag(nodes: DagNode[]): number[] {
  const parents = nodes.map((node, at) => [...new Set(node.after.filter((dep) => dep !== at && dep >= 0 && dep < nodes.length))]);
  const layer = nodes.map(() => -1);
  const visiting = new Set<number>();
  const layerOf = (at: number): number => {
    if ((layer[at] as number) >= 0) return layer[at] as number;
    if (visiting.has(at)) return 0;
    visiting.add(at);
    const deps = parents[at] as number[];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(layerOf));
    visiting.delete(at);
    layer[at] = value;
    return value;
  };
  nodes.forEach((_node, at) => layerOf(at));
  return layer;
}

export function reduceDeps(nodes: DagNode[], layer: number[] = layerDag(nodes)): number[][] {
  const deps = nodes.map((node, at) => [...new Set(node.after)].filter((dep) => dep !== at && dep >= 0 && dep < nodes.length && (layer[dep] as number) < (layer[at] as number)));
  const above: (Set<number> | undefined)[] = nodes.map(() => undefined);
  const ancestors = (at: number): Set<number> => {
    const known = above[at];
    if (known) return known;
    const found = new Set<number>();
    above[at] = found;
    for (const dep of deps[at] as number[]) {
      found.add(dep);
      for (const higher of ancestors(dep)) found.add(higher);
    }
    return found;
  };
  return deps.map((own) => own.filter((dep) => !own.some((other) => other !== dep && ancestors(other).has(dep))));
}

function buildItems(nodes: DagNode[]): Item[] {
  const layer = layerDag(nodes);
  const items: Item[] = nodes.map((_node, at) => ({ layer: layer[at] as number, node: at, preds: [], succs: [] }));
  const link = (from: number, to: number) => {
    const source = items[from] as Item;
    if (source.succs.includes(to)) return;
    source.succs.push(to);
    (items[to] as Item).preds.push(from);
  };
  const dummies = new Map<string, number>();
  const direct = reduceDeps(nodes, layer);
  nodes.forEach((_node, at) => {
    for (const dep of direct[at] as number[]) {
      let previous = dep;
      for (let through = (layer[dep] as number) + 1; through < (layer[at] as number); through += 1) {
        const key = `${dep}:${through}`;
        let dummy = dummies.get(key);
        if (dummy === undefined) {
          dummy = items.length;
          items.push({ layer: through, preds: [], succs: [] });
          dummies.set(key, dummy);
        }
        link(previous, dummy);
        previous = dummy;
      }
      link(previous, at);
    }
  });
  return items;
}

function crossings(order: number[][], items: Item[]): number {
  let total = 0;
  for (let layer = 0; layer + 1 < order.length; layer += 1) {
    const here = new Map((order[layer] as number[]).map((item, at) => [item, at]));
    const next = new Map((order[layer + 1] as number[]).map((item, at) => [item, at]));
    const edges = (order[layer] as number[]).flatMap((item) => (items[item] as Item).succs.map((succ) => [here.get(item) as number, next.get(succ) as number] as const));
    for (let one = 0; one < edges.length; one += 1) {
      for (let two = one + 1; two < edges.length; two += 1) {
        const [a1, b1] = edges[one] as readonly [number, number];
        const [a2, b2] = edges[two] as readonly [number, number];
        if ((a1 - a2) * (b1 - b2) < 0) total += 1;
      }
    }
  }
  return total;
}

function orderLayers(items: Item[]): number[][] {
  const depth = Math.max(0, ...items.map((item) => item.layer)) + 1;
  const order: number[][] = Array.from({ length: depth }, () => []);
  const seen = new Set<number>();
  const place = (at: number) => {
    if (seen.has(at)) return;
    seen.add(at);
    (order[(items[at] as Item).layer] as number[]).push(at);
    for (const succ of (items[at] as Item).succs) place(succ);
  };
  items.forEach((item, at) => {
    if (item.node !== undefined && item.preds.length === 0) place(at);
  });
  items.forEach((_item, at) => place(at));

  const sortBy = (layer: number, neighbours: (item: Item) => number[], reference: number[]) => {
    const at = new Map(reference.map((item, index) => [item, index]));
    const current = order[layer] as number[];
    const keyed = current.map((item, index) => {
      const near = neighbours(items[item] as Item).map((other) => at.get(other)).filter((value): value is number => value !== undefined);
      return { item, index, key: near.length > 0 ? near.reduce((sum, value) => sum + value, 0) / near.length : index };
    });
    keyed.sort((left, right) => left.key - right.key || left.index - right.index);
    order[layer] = keyed.map((entry) => entry.item);
  };

  let best = order.map((layer) => [...layer]);
  let fewest = crossings(order, items);
  for (let pass = 0; pass < 8 && fewest > 0; pass += 1) {
    if (pass % 2 === 0) for (let layer = 1; layer < depth; layer += 1) sortBy(layer, (item) => item.preds, order[layer - 1] as number[]);
    else for (let layer = depth - 2; layer >= 0; layer -= 1) sortBy(layer, (item) => item.succs, order[layer + 1] as number[]);
    const count = crossings(order, items);
    if (count < fewest) {
      fewest = count;
      best = order.map((layer) => [...layer]);
    }
  }
  return best;
}

function assignRows(order: number[][], items: Item[]): number[] {
  const row = items.map(() => 0);
  for (const layer of order) {
    let next = 0;
    for (const item of layer) {
      const above = (items[item] as Item).preds.map((pred) => row[pred] as number).sort((left, right) => left - right);
      const wanted = above.length > 0 ? (above[Math.floor((above.length - 1) / 2)] as number) : next;
      row[item] = Math.max(wanted, next);
      next = (row[item] as number) + 1;
    }
  }
  return row;
}

function planGap(layer: number[], items: Item[], row: number[], tight = false): Gap {
  const byTargets = new Map<string, { sources: number[]; targets: number[] }>();
  for (const source of layer) {
    const targets = [...(items[source] as Item).succs].sort((left, right) => left - right);
    if (targets.length === 0) continue;
    const key = targets.join(",");
    const group = byTargets.get(key) ?? { sources: [], targets };
    group.sources.push(source);
    byTargets.set(key, group);
  }
  const groups = [...byTargets.values()];
  const span = groups.map((group) => {
    const rows = [...group.sources, ...group.targets].map((item) => row[item] as number);
    return [Math.min(...rows), Math.max(...rows)] as const;
  });

  const groupOfSource = new Map<number, number>();
  groups.forEach((group, at) => group.sources.forEach((source) => groupOfSource.set(row[source] as number, at)));
  const before = groups.map(() => new Set<number>());
  groups.forEach((group, at) => {
    for (const target of group.targets) {
      const first = groupOfSource.get(row[target] as number);
      if (first !== undefined && first !== at) (before[at] as Set<number>).add(first);
    }
  });

  const done: number[] = [];
  const left = new Set(groups.map((_group, at) => at));
  while (left.size > 0) {
    const ready = [...left].filter((at) => [...(before[at] as Set<number>)].every((first) => !left.has(first)));
    const pick = (ready.length > 0 ? ready : [...left]).sort((one, two) => (span[one] as readonly [number, number])[0] - (span[two] as readonly [number, number])[0])[0] as number;
    done.push(pick);
    left.delete(pick);
  }

  const channelOf = new Map<number, number>();
  for (const at of done) {
    let channel = Math.max(-1, ...[...(before[at] as Set<number>)].map((first) => channelOf.get(first) ?? -1)) + 1;
    const [low, high] = span[at] as readonly [number, number];
    const clashes = (candidate: number) =>
      [...channelOf.entries()].some(([other, used]) => used === candidate && (span[other] as readonly [number, number])[0] <= high && low <= (span[other] as readonly [number, number])[1]);
    while (clashes(channel)) channel += 1;
    channelOf.set(at, channel);
  }
  const channels = Math.max(0, ...channelOf.values()) + 1;
  return { width: 2 * channels + (tight ? 3 : 4), start: tight ? 1 : 2, channel: channelOf, groups };
}

export function drawDag(nodes: DagNode[], options: DagOptions): DagLine[] {
  if (nodes.length === 0) return [];
  const ascii = options.ascii ?? false;
  const items = buildItems(nodes);
  const order = orderLayers(items);
  const row = assignRows(order, items);
  const shown = nodes.map((node) => ({ ...node, label: clip(node.label, MAX_LABEL) }));
  const content = (node: number) => {
    const entry = shown[node] as DagNode;
    return cellWidth(entry.mark) + 1 + cellWidth(entry.label) + (entry.detail ? 1 + cellWidth(entry.detail) : 0);
  };
  const boxWidth = (node: number) => content(node) + (options.boxed ? 4 : 0);
  const columnWidth = order.map((layer) => Math.max(1, ...layer.flatMap((item) => ((items[item] as Item).node !== undefined ? [boxWidth((items[item] as Item).node as number)] : []))));
  const gaps = order.slice(0, -1).map((layer) => planGap(layer, items, row, options.tight ?? false));

  const ENTRY = 4;
  const EXIT = 3;
  const bands: [number, number][] = [];
  let start = 0;
  while (start < order.length) {
    let end = start;
    let used = (start > 0 ? ENTRY : 0) + (columnWidth[start] as number);
    while (end + 1 < order.length) {
      const more = (gaps[end] as Gap).width + (columnWidth[end + 1] as number) + (end + 2 < order.length ? EXIT : 0);
      if (used + more > options.width) break;
      used += (gaps[end] as Gap).width + (columnWidth[end + 1] as number);
      end += 1;
    }
    bands.push([start, end]);
    start = end + 1;
  }

  const height = options.boxed ? 3 : 1;
  const middle = options.boxed ? 1 : 0;
  const lines: DagLine[] = [];
  bands.forEach(([first, last], band) => {
    if (band > 0) lines.push([]);
    const used = [...new Set(order.slice(first, last + 1).flat().map((item) => row[item] as number))].sort((a, b) => a - b);
    const local = new Map(used.map((value, at) => [value, at]));
    const lineOf = (item: number) => (local.get(row[item] as number) as number) * height + middle;
    const total = used.length * height;
    const grid: DagRun[][] = Array.from({ length: total }, () => []);
    const put = (y: number, text: string, kind: RunKind, node?: number) => {
      const runs = grid[y] as DagRun[];
      const previous = runs[runs.length - 1];
      if (previous && previous.kind === kind && previous.node === node) previous.text += text;
      else runs.push({ text, kind, ...(node !== undefined ? { node } : {}) });
    };
    const blank = (y: number, width: number) => put(y, " ".repeat(width), "space");
    const dash = ascii ? "-" : "─";

    if (first > 0) {
      const at = new Map((order[first] as number[]).map((item) => [lineOf(item), item]));
      for (let y = 0; y < total; y += 1) {
        const item = at.get(y);
        if (item === undefined) blank(y, ENTRY);
        else put(y, (items[item] as Item).node !== undefined ? (ascii ? "..> " : `…${dash}▶ `) : ascii ? "...-" : `…${dash}${dash}${dash}`, "edge");
      }
    }

    for (let layer = first; layer <= last; layer += 1) {
      const width = columnWidth[layer] as number;
      const at = new Map<number, number>();
      for (const item of order[layer] as number[]) at.set(local.get(row[item] as number) as number, item);
      for (let slot = 0; slot < used.length; slot += 1) {
        const item = at.get(slot);
        const top = slot * height;
        if (item === undefined) {
          for (let y = top; y < top + height; y += 1) blank(y, width);
          continue;
        }
        const entry = items[item] as Item;
        const continues = entry.succs.length > 0;
        if (entry.node === undefined) {
          for (let y = top; y < top + height; y += 1) {
            if (y === top + middle) put(y, dash.repeat(width), "edge");
            else blank(y, width);
          }
          continue;
        }
        const node = shown[entry.node] as DagNode;
        const own = boxWidth(entry.node);
        const fill = (y: number) => {
          if (own >= width) return;
          if (y === top + middle && continues) {
            put(y, " ", "space");
            if (width - own > 1) put(y, dash.repeat(width - own - 1), "edge");
          }
          else blank(y, width - own);
        };
        const body = (y: number) => {
          put(y, node.mark, "mark", entry.node);
          put(y, " ", "space");
          put(y, node.label, "label", entry.node);
          if (node.detail) {
            put(y, " ", "space");
            put(y, node.detail, "detail", entry.node);
          }
        };
        if (options.boxed) {
          const inner = own - 2;
          put(top, ascii ? `+${"-".repeat(inner)}+` : `╭${"─".repeat(inner)}╮`, "border", entry.node);
          put(top + 1, ascii ? "| " : "│ ", "border", entry.node);
          body(top + 1);
          put(top + 1, ascii ? " |" : " │", "border", entry.node);
          put(top + 2, ascii ? `+${"-".repeat(inner)}+` : `╰${"─".repeat(inner)}╯`, "border", entry.node);
          for (let y = top; y < top + 3; y += 1) fill(y);
        } else {
          body(top);
          fill(top);
        }
      }

      if (layer === last) {
        if (layer < order.length - 1) {
          const leaving = new Map<number, number>();
          for (const item of order[layer] as number[]) if ((items[item] as Item).succs.length > 0) leaving.set(lineOf(item), item);
          for (let y = 0; y < total; y += 1) {
            const item = leaving.get(y);
            if (item === undefined) blank(y, EXIT);
            else {
              const from = (items[item] as Item).node;
              const flush = from === undefined || boxWidth(from) < width;
              put(y, flush ? (ascii ? "--." : `${dash}${dash}…`) : ascii ? " -." : ` ${dash}…`, "edge");
            }
          }
        }
        continue;
      }

      const gap = gaps[layer] as Gap;
      const bits: number[][] = Array.from({ length: total }, () => Array.from({ length: gap.width }, () => 0));
      const arrows = new Set<number>();
      const throughLeft = new Set<number>();
      const throughRight = new Set<number>();
      const add = (y: number, x: number, value: number) => {
        (bits[y] as number[])[x] = ((bits[y] as number[])[x] as number) | value;
      };
      gap.groups.forEach((group, index) => {
        const x = gap.start + 2 * (gap.channel.get(index) as number);
        const ys: number[] = [];
        for (const source of group.sources) {
          const y = lineOf(source);
          ys.push(y);
          const from = (items[source] as Item).node;
          if (from === undefined || boxWidth(from) < (columnWidth[layer] as number)) throughLeft.add(y);
          for (let cell = 1; cell < x; cell += 1) add(y, cell, LEFT | RIGHT);
          add(y, x, LEFT);
        }
        for (const target of group.targets) {
          const y = lineOf(target);
          ys.push(y);
          if ((items[target] as Item).node === undefined) throughRight.add(y);
          else arrows.add(y);
          add(y, x, RIGHT);
          for (let cell = x + 1; cell < gap.width - 1; cell += 1) add(y, cell, LEFT | RIGHT);
        }
        const low = Math.min(...ys);
        const high = Math.max(...ys);
        for (let y = low; y <= high; y += 1) {
          if (y > low) add(y, x, UP);
          if (y < high) add(y, x, DOWN);
        }
      });
      for (let y = 0; y < total; y += 1) {
        const cells = bits[y] as number[];
        let text = throughLeft.has(y) ? dash : " ";
        for (let x = 1; x < gap.width - 1; x += 1) {
          text += x === gap.width - 2 && arrows.has(y) ? (ascii ? ">" : "▶") : lineChar(cells[x] as number, ascii);
        }
        text += throughRight.has(y) ? dash : " ";
        put(y, text, "edge");
      }
    }
    lines.push(...grid);
  });
  return lines;
}

export function dagText(lines: DagLine[]): string[] {
  return lines.map((line) => line.map((run) => run.text).join("").replace(/\s+$/, ""));
}

export function collapseDag(nodes: DagNode[], most: number): { nodes: DagNode[]; members: number[][] } {
  const layer = layerDag(nodes);
  const byLayer = new Map<number, number[]>();
  nodes.forEach((_node, at) => byLayer.set(layer[at] as number, [...(byLayer.get(layer[at] as number) ?? []), at]));
  const target = nodes.map((_node, at) => at);
  const members: number[][] = [];
  const kept: number[] = [];
  for (const at of nodes.keys()) {
    const column = byLayer.get(layer[at] as number) as number[];
    const position = column.indexOf(at);
    if (column.length <= most || position < most - 1) {
      target[at] = members.length;
      members.push([at]);
      kept.push(at);
    }
  }
  for (const column of byLayer.values()) {
    if (column.length <= most) continue;
    const rest = column.slice(most - 1);
    const index = members.length;
    members.push(rest);
    for (const at of rest) target[at] = index;
  }
  const collapsed = members.map((group, index) => {
    const after = [...new Set(group.flatMap((at) => (nodes[at] as DagNode).after.map((dep) => target[dep] as number)))].filter((dep) => dep !== index && dep !== undefined);
    if (group.length === 1) return { ...(nodes[group[0] as number] as DagNode), after };
    return { mark: " ", label: `+${group.length} more`, after };
  });
  return { nodes: collapsed, members };
}
