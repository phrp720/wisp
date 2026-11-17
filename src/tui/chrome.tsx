/** The line along the top and the keys along the bottom, on every screen. */

import { Box, Text } from "ink";

import type { Glyphs } from "./glyphs.js";
import { type Services } from "./model.js";
import type { Notice, View } from "./state.js";
import { TONE } from "./tones.js";

export function Header({ services, glyphs, columns, here, running, failing }: { services: Services; glyphs: Glyphs; columns: number; here?: string | undefined; running: number; failing: string[] }) {
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
          {running > 0 ? <Text color="green">{`  ${glyphs.dot} ${running} running`}</Text> : null}
          {failing.length === 1 ? <Text color="red">{`  ${glyphs.dot} ${failing[0]} — p to see why`}</Text> : failing.length > 1 ? <Text color="red">{`  ${glyphs.dot} ${failing.length} need attention — p`}</Text> : null}
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

export function Footer({ view, message, notice }: { view: View; message?: string | undefined; notice?: Notice | undefined }) {
  const keys: Record<View["kind"], string> = {
    browse: "⏎ run · v view · e edit · a add · p running · h history · x stop · / search · ? keys · q quit",
    editor: "",
    "new-bolt": "",
    "new-workspace": "",
    "delete-bolt": "",
    view: "",
    "stop-bolt": "",
    setup: "⏎ set it up · esc not now",
    search: "type to search  ↑↓ choose  ⏎ run  esc back",
    run: "",
    check: "↑↓ scroll  t trust  esc back",
    trust: "←→ choose · ⏎ confirm · esc cancel",
    processes: "↑↓ choose · / search · a show stopped too · r restart · x stop · s start · f full screen · pgup/pgdn scroll · esc back",
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
