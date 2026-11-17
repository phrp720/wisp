/** The line along the top and the keys along the bottom, on every screen. */

import { Box, Text } from "ink";

import type { Glyphs } from "./glyphs.js";
import { type Services } from "./model.js";
import type { Notice, View } from "./state.js";
import { TONE } from "./tones.js";

/** The three screens, as tabs along the top: the one you are on, and the key for each. */
export type Tab = "bolts" | "running" | "history";

export function Header({ services, glyphs, columns, here, running, failing, tab }: { services: Services; glyphs: Glyphs; columns: number; here?: string | undefined; running: number; failing: string[]; tab: Tab }) {
  const { environment } = services;
  // Where a command will go, said up front: it is the one thing that differs by place.
  const badges: string[] = [];
  if (!environment.gui) badges.push(environment.ssh ? "over ssh — links are shown, not opened" : "no display — links are shown, not opened");
  return (
    <Box width={columns} height={1} paddingX={1} justifyContent="space-between" overflow="hidden">
      <Box flexShrink={1} overflow="hidden">
        <Text wrap="truncate-end">
          <Text bold color={TONE.accent}>
            {glyphs.border === "round" ? "🔮 " : ""}specter
          </Text>
          {"   "}
          <TabLabel number="1" title="Bolts" on={tab === "bolts"} />
          {"   "}
          <TabLabel number="2" title="Running" on={tab === "running"} />
          {/* The Running tab says how things are: how many are up, or what needs you. */}
          {failing.length === 1 ? (
            <Text color={TONE.failed}>{` ${glyphs.dot} ${failing[0]}`}</Text>
          ) : failing.length > 1 ? (
            <Text color={TONE.failed}>{` ${glyphs.dot} ${failing.length} need you`}</Text>
          ) : running > 0 ? (
            <Text color={TONE.up}>{` ${glyphs.dot} ${running}`}</Text>
          ) : null}
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

function TabLabel({ number, title, on }: { number: string; title: string; on: boolean }) {
  return on ? (
    <Text bold color={TONE.accent} underline>{`${number} ${title}`}</Text>
  ) : (
    <Text dimColor>{`${number} ${title}`}</Text>
  );
}

export function Footer({ view, message, notice }: { view: View; message?: string | undefined; notice?: Notice | undefined }) {
  const keys: Record<View["kind"], string> = {
    browse: "⏎ run · v view · e edit · a add · x stop · / search · 1 2 3 tabs · ? keys · q quit",
    editor: "",
    "new-bolt": "",
    "new-workspace": "",
    "delete-bolt": "",
    view: "",
    "stop-bolt": "",
    setup: "",
    search: "type to search · ↑↓ choose · ⏎ run · esc back",
    run: "",
    check: "↑↓ scroll · t trust · esc back",
    trust: "",
    processes: "↑↓ choose · u d scroll · G newest · x stop · r restart · f full · / search · a stopped too · esc",
    history: "",
    help: "any key to go back",
  };
  return (
    <Box paddingX={1}>
      {notice ? (
        <Text color={notice.tone === "bad" ? "red" : notice.tone === "good" ? "green" : "cyan"} bold={notice.tone === "bad"} wrap="truncate-end">
          {`${notice.tone === "bad" ? "! " : ""}${notice.text}`}
        </Text>
      ) : message ? (
        <Text color="cyan" wrap="truncate-end">{message}</Text>
      ) : (
        <Text dimColor wrap="truncate-end">{keys[view.kind]}</Text>
      )}
    </Box>
  );
}
