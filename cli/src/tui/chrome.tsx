/** The line along the top and the keys along the bottom, on every screen. */

import { Box, Text } from "ink";

import { VERSION } from "../cli/version.js";
import { ASK_KEYS } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { type Services } from "./model.js";
import type { Notice, View } from "./state.js";
import { TONE } from "./tones.js";

/** While a filter is being typed, the keys do something else: say what. */
function typingHint(view: View): string | undefined {
  if (view.kind !== "processes") return undefined;
  if (view.logTyping) return "type to filter the log · ⏎ keep it · esc clear";
  if (view.typing) return "type to filter the list · ⏎ keep it · esc clear";
  return view.full ? "↑↓ scroll · ←→ next command · / filter · f back · ? keys · esc" : undefined;
}

/** The three screens, as tabs along the top: the one you are on, and the key for each. */
export type Tab = "bolts" | "running" | "history";

export function Header({ services, glyphs, columns, here, running, failing, tab }: { services: Services; glyphs: Glyphs; columns: number; here?: string | undefined; running: number; failing: string[]; tab: Tab }) {
  const { environment } = services;
  // Where a command will go, said up front: it is the one thing that differs by place.
  const badges: string[] = [];
  const status = runningStatus(glyphs, running, failing);
  if (!environment.gui) badges.push(environment.ssh ? "over ssh — links are shown, not opened" : "no display — links are shown, not opened");
  return (
    <Box width={columns} height={1} paddingX={1} justifyContent="space-between" overflow="hidden">
      <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text bold color={TONE.accent}>
            {glyphs.border === "round" ? "🔮 " : ""}wisp
          </Text>
          {"   "}
          <TabLabel number="1" title="Bolts" on={tab === "bolts"} />
          {"   "}
          <TabLabel number="2" title="Running" on={tab === "running"} />
          {/* The Running tab says how things are: how many are up, or what needs you. */}
          {status ? <Text color={status.color}>{status.text}</Text> : null}
          {"   "}
          <TabLabel number="3" title="History" on={tab === "history"} />
          {badges.length > 0 ? <Text color="yellow">{`  ${badges.join(" · ")}`}</Text> : null}
        </Text>
      </Box>
      {here && columns >= 70 ? (
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{here}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Beside the Running tab: what needs you, or how many things are up. */
export function runningStatus(glyphs: Glyphs, running: number, failing: string[]): { text: string; color: string } | undefined {
  if (failing.length === 1) return { text: ` ${glyphs.dot} ${failing[0]}`, color: TONE.failed };
  if (failing.length > 1) return { text: ` ${glyphs.dot} ${failing.length} need you`, color: TONE.failed };
  if (running > 0) return { text: ` ${glyphs.dot} ${running}`, color: TONE.up };
  return undefined;
}

/**
 * The tab along the top under a column, for a click. Worked out from what the header
 * draws: the padding, the name (and its crystal ball, two columns wide), three spaces
 * between the tabs, and the status beside Running.
 */
export function headerTabAt(x: number, glyphs: Glyphs, status: string): Tab | undefined {
  let at = 1 + (glyphs.border === "round" ? 3 : 0) + "wisp".length + 3;
  for (const [tab, width] of [["bolts", "1 Bolts".length], ["running", "2 Running".length + status.length], ["history", "3 History".length]] as const) {
    if (x >= at && x < at + width) return tab;
    at += width + 3;
  }
  return undefined;
}

function TabLabel({ number, title, on }: { number: string; title: string; on: boolean }) {
  return on ? (
    <Text bold color={TONE.accent} underline>{`${number} ${title}`}</Text>
  ) : (
    <Text dimColor>{`${number} ${title}`}</Text>
  );
}

export function Footer({ view, message, notice, hint, columns = 0 }: { view: View; message?: string | undefined; notice?: Notice | undefined; hint?: string | undefined; columns?: number }) {
  const keys: Record<View["kind"], string> = {
    browse: "⏎ run · e edit · a add · x stop · / search · ? keys · q quit",
    editor: "",
    "new-bolt": "",
    "new-workspace": "",
    "edit-workspace": "",
    "delete-bolt": `Its steps go too; what it started keeps running · ${ASK_KEYS}`,
    "confirm-run": `y or ← ⏎ runs it · esc cancels`,
    "run-inputs": "",
    "delete-workspace": view.kind === "delete-workspace" && view.personal
      ? `Its file and bolts go; what it started keeps running · ${ASK_KEYS}`
      : `Only from this list; its .wisp.json stays in the repository · ${ASK_KEYS}`,
    "stop-bolt": "",
    settings: "",
    setup: "",
    search: "type to search · ↑↓ choose · ⏎ run · esc back",
    check: "↑↓ scroll · t trust · esc back",
    trust: "",
    processes: "↑↓ choose · [ ] tabs · f full log · x stop · r restart · ? keys · esc",
    history: "",
    help: "any key to go back",
  };
  return (
    <Box paddingX={1}>
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {notice ? (
          <Text color={notice.tone === "bad" ? "red" : notice.tone === "good" ? "green" : "cyan"} bold={notice.tone === "bad"} wrap="truncate-end">
            {`${notice.tone === "bad" ? "! " : ""}${notice.text}`}
          </Text>
        ) : message ? (
          <Text color="cyan" wrap="truncate-end">{message}</Text>
        ) : (
          <Text dimColor wrap="truncate-end">{typingHint(view) ?? hint ?? keys[view.kind]}</Text>
        )}
      </Box>
      {columns >= 60 ? (
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>{`v${VERSION}`}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
