/** Questions that need an answer before going on: trusting a file, setting a folder up. */

import { Box, type DOMElement, Text, useInput } from "ink";
import { useRef, useState } from "react";

import { tildify } from "../core/paths.js";
import type { WorkspaceRead } from "../core/types.js";
import { Choice } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { type SetupSuggestion, windowed } from "./model.js";
import { useMouse, useRefs } from "./mouse.js";
import { KIND } from "./state.js";
import { TONE } from "./tones.js";

export function TrustPanel({ read, then, glyphs, height, onAnswer }: { read: WorkspaceRead; then?: string; glyphs: Glyphs; height: number; onAnswer: (yes: boolean) => void }) {
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor="yellow" paddingX={1}>
      <Text bold>{`Trust ${read.workspace.name}?`}</Text>
      <Text dimColor wrap="truncate-start">{tildify(read.workspace.file) + (read.workspace.local ? "  + local" : "")}</Text>
      {read.trust === "stale" ? <Text color="yellow">this file has changed since you last trusted it</Text> : null}
      {then ? <Text color="yellow">{`"${then}" needs some of these. Run it without them and only part of it would start.`}</Text> : null}
      <Text> </Text>
      <Text>{`It would be allowed to run ${read.withheld.length} thing${read.withheld.length === 1 ? "" : "s"}:`}</Text>
      {windowed(read.withheld, 0, height - 12).items.map((item) => (
        <Text key={item.id} wrap="truncate-end">
          <Text dimColor>{`  ${KIND[item.kind].padEnd(8)} `}</Text>
          <Text color="cyan">{tildify(item.value)}</Text>
          {item.cwd && item.cwd !== read.workspace.file.replace(/\/[^/]+$/, "") ? <Text dimColor>{` in ${tildify(item.cwd)}`}</Text> : null}
          {item.reason ? <Text dimColor>{` (${item.reason})`}</Text> : null}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>These run on your machine, as you. Any later edit to the file asks again.</Text>
      <Text> </Text>
      <Choice yes={then ? "Trust and run" : "Trust this file"} no="Cancel" danger onAnswer={onAnswer} />
    </Box>
  );
}

/** "I looked at this folder, and here's what I'd set up" — the first thing a new project sees. */
/**
 * "I looked at this folder, and here's what I'd set up" — the first thing a new project sees.
 * Every suggested bolt is a box to tick, all ticked to start: keep what you want, untick the
 * rest. A kept bolt that needed an unticked one simply stops asking for it.
 */
export function SetupPanel({ suggestion, glyphs, height, onAnswer }: { suggestion: SetupSuggestion; glyphs: Glyphs; height: number; onAnswer: (chosen: string[] | undefined | "never") => void }) {
  const [index, setIndexState] = useState(0);
  const indexRef = useRef(0);
  const [ticked, setTickedState] = useState<Set<string>>(() => new Set(suggestion.bolts.map((bolt) => bolt.label)));
  const tickedRef = useRef(ticked);
  const answered = useRef(false);
  const setIndex = (next: number) => {
    indexRef.current = next;
    setIndexState(next);
  };
  const toggle = (label: string) => {
    const next = new Set(tickedRef.current);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    tickedRef.current = next;
    setTickedState(next);
  };
  // The answer lands after the key is done, so the screen behind never hears the same ⏎.
  const answer = (chosen: string[] | undefined | "never") => {
    if (answered.current) return;
    answered.current = true;
    setTimeout(() => onAnswer(chosen), 0);
  };

  useInput((input, key) => {
    if (answered.current) return;
    if (key.escape || input === "q" || input === "n") return answer(undefined);
    if (input === "N") return answer("never");
    if (key.upArrow || input === "k") return setIndex(Math.max(0, indexRef.current - 1));
    if (key.downArrow || input === "j") return setIndex(Math.min(suggestion.bolts.length - 1, indexRef.current + 1));
    if (input === " ") {
      const bolt = suggestion.bolts[indexRef.current];
      if (bolt) toggle(bolt.label);
      return;
    }
    if (input === "a") {
      const all = tickedRef.current.size === suggestion.bolts.length;
      const next = new Set(all ? [] : suggestion.bolts.map((bolt) => bolt.label));
      tickedRef.current = next;
      return setTickedState(next);
    }
    if (key.return) {
      const chosen = suggestion.bolts.map((bolt) => bolt.label).filter((label) => tickedRef.current.has(label));
      if (chosen.length > 0) answer(chosen);
    }
  });

  // A click on a bolt ticks or unticks it; on the button, sets up the ones ticked.
  const rows = useRefs<number>();
  const button = useRef<DOMElement>(null);
  const later = useRef<DOMElement>(null);
  const never = useRef<DOMElement>(null);
  useMouse((event, at) => {
    if (event.kind !== "click" || answered.current) return false;
    if (at(button.current)) {
      const chosen = suggestion.bolts.map((bolt) => bolt.label).filter((label) => tickedRef.current.has(label));
      if (chosen.length > 0) answer(chosen);
      return true;
    }
    if (at(later.current)) return answer(undefined), true;
    if (at(never.current)) return answer("never"), true;
    const hit = rows.entries().find(([, node]) => at(node));
    const bolt = hit ? suggestion.bolts[hit[0]] : undefined;
    if (!hit || !bolt) return false;
    setIndex(hit[0]);
    toggle(bolt.label);
    return true;
  });

  const count = ticked.size;
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1} overflow="hidden">
      <Text bold color={TONE.accent}>{`Set up ${suggestion.name}?`}</Text>
      <Text dimColor wrap="truncate-start">{tildify(suggestion.dir)}</Text>
      <Text> </Text>
      <Text>I looked at this folder and found:</Text>
      {suggestion.found.map((line) => (
        <Text key={line} wrap="truncate-end" dimColor>{`  ${glyphs.dot} ${line}`}</Text>
      ))}
      <Text> </Text>
      <Text>So you could run these. Keep the ones you want:</Text>
      {suggestion.bolts.map((bolt, at) => {
        const on = ticked.has(bolt.label);
        const selected = at === index;
        return (
          <Box key={bolt.label} ref={rows.set(at)} flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={TONE.accent}>{selected ? `${glyphs.pointer} ` : "  "}</Text>
              <Text color={on ? TONE.accent : undefined} dimColor={!on}>{on ? "[✓] " : "[ ] "}</Text>
              <Text bold={selected} color={on ? (selected ? TONE.accent : undefined) : undefined} dimColor={!on}>{`${glyphs.bolt}${bolt.label}`}</Text>
            </Text>
            <Text wrap="truncate-end" dimColor>{`        ${bolt.steps.join(", then ")}`}</Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>It's saved as .wisp.json in this folder, and you can change all of it afterwards with e.</Text>
      <Box>
        <Box ref={button}>
          <Text color={count > 0 ? "black" : undefined} backgroundColor={count > 0 ? TONE.accent : undefined} bold dimColor={count === 0}>{count > 0 ? ` ▸ ${count === 1 ? (suggestion.bolts.length === 1 ? "Set up this pipeline" : "Set up 1 pipeline") : count === suggestion.bolts.length ? `Set up all ${count} pipelines` : `Set up ${count} pipelines`} ` : " Tick at least one "}</Text>
        </Box>
        <Box ref={later} marginLeft={1}>
          <Text dimColor>{" [ Not now ] "}</Text>
        </Box>
        <Box ref={never} marginLeft={1}>
          <Text dimColor>{" [ Don't ask again ] "}</Text>
        </Box>
      </Box>
      <Text dimColor>{"space tick · a all/none · ⏎ set up · n not now · N don't ask again"}</Text>
    </Box>
  );
}
