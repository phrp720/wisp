/** Questions that need an answer before going on: trusting a file, setting a folder up. */

import { Box, Text } from "ink";

import { tildify } from "../core/paths.js";
import type { WorkspaceRead } from "../core/types.js";
import { Choice } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { type SetupSuggestion, windowed } from "./model.js";
import { KIND } from "./state.js";
import { TONE } from "./tones.js";

export function TrustPanel({ read, glyphs, height, onAnswer }: { read: WorkspaceRead; glyphs: Glyphs; height: number; onAnswer: (yes: boolean) => void }) {
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor="yellow" paddingX={1}>
      <Text bold>{`Trust ${read.workspace.name}?`}</Text>
      <Text dimColor wrap="truncate-start">{tildify(read.workspace.file) + (read.workspace.local ? "  + local" : "")}</Text>
      {read.trust === "stale" ? <Text color="yellow">this file has changed since you last trusted it</Text> : null}
      <Text> </Text>
      <Text>{`It would be allowed to run ${read.withheld.length} thing${read.withheld.length === 1 ? "" : "s"}:`}</Text>
      {windowed(read.withheld, 0, height - 12).items.map((item) => (
        <Text key={item.id} wrap="truncate-end">
          <Text dimColor>{`  ${KIND[item.kind].padEnd(6)} `}</Text>
          <Text color="cyan">{tildify(item.value)}</Text>
          {item.cwd && item.cwd !== read.workspace.file.replace(/\/[^/]+$/, "") ? <Text dimColor>{` in ${tildify(item.cwd)}`}</Text> : null}
          {item.reason ? <Text dimColor>{` (${item.reason})`}</Text> : null}
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>These run on your machine, as you. Any later edit to the file asks again.</Text>
      <Text> </Text>
      <Choice yes="Trust this file" no="Cancel" danger onAnswer={onAnswer} />
    </Box>
  );
}

/** "I looked at this folder, and here's what I'd set up" — the first thing a new project sees. */
export function SetupPanel({ suggestion, glyphs, height, onAnswer }: { suggestion: SetupSuggestion; glyphs: Glyphs; height: number; onAnswer: (yes: boolean) => void }) {
  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1} overflow="hidden">
      <Text bold>{`Set up ${suggestion.name}?`}</Text>
      <Text dimColor wrap="truncate-start">{tildify(suggestion.dir)}</Text>
      <Text> </Text>
      <Text>I looked at this folder and found:</Text>
      {suggestion.found.map((line) => (
        <Text key={line} wrap="truncate-end">{`  ${glyphs.dot} ${line}`}</Text>
      ))}
      <Text> </Text>
      <Text>So you could run:</Text>
      {suggestion.bolts.map((bolt) => (
        <Box key={bolt.label} flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold color={TONE.accent}>{`  ${glyphs.bolt}${bolt.label}`}</Text>
            {bolt.job ? <Text color="cyan"> — a job: stops at the first failure</Text> : null}
          </Text>
          <Text wrap="truncate-end" dimColor>{`     ${(bolt.job ? bolt.steps.map((step) => step.replace(/^start /, "run ")) : bolt.steps).join(", then ")}`}</Text>
        </Box>
      ))}
      <Box flexGrow={1} />
      <Text dimColor>It's saved as .wisp.json in this folder — you can change all of it afterwards with e.</Text>
      <Choice yes="Set it up" no="Not now" onAnswer={onAnswer} />
    </Box>
  );
}
