/** Your own settings on this machine: the app that opens folders and files, where commands run, and when Wisp tells you about a run. */

import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import { webhookProblem } from "../core/notify.js";
import { Form, Picker } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import { useMouse, useRefs } from "./mouse.js";
import type { NotifyChoice, OpenWith, Services } from "./model.js";
import { TONE } from "./tones.js";

type Key = "folder" | "file" | "terminal";

const ROWS: { key: Key | "mouse" | "notify" | "webhook"; label: string; what: string }[] = [
  { key: "folder", label: "Folders open in", what: "a bolt's folder steps, like apps/api" },
  { key: "file", label: "Files open in", what: "a bolt's file steps, like docs/runbook.md" },
  { key: "terminal", label: "Commands run", what: "a bolt's commands, like pnpm dev" },
  { key: "mouse", label: "Mouse", what: "click rows and tabs, scroll output with the wheel. Off: select text without holding Shift" },
  { key: "notify", label: "Tell me", what: "about a run you might have missed: nobody watched it, or it took over 30s" },
  { key: "webhook", label: "Webhook", what: "also post it here, for a server: Slack, Discord, ntfy or your own" },
];

const WHEN = { failures: "when a run fails", all: "when any run ends", off: "never" } as const;

const DEFAULT = "__default";
const OTHER = "__other";

type Mode = { kind: "list" } | { kind: "pick"; key: Key } | { kind: "other"; key: Key } | { kind: "notify" } | { kind: "webhook" };

export function SettingsScreen({ services, glyphs, height, onClose, onSaved, onMouse }: { services: Services; glyphs: Glyphs; height: number; onClose: () => void; onSaved: (text: string) => void; onMouse?: (on: boolean) => void }) {
  const [current, setCurrent] = useState<OpenWith>();
  const [mouse, setMouse] = useState<boolean>();
  const [notify, setNotify] = useState<NotifyChoice>();
  const [index, setIndexState] = useState(0);
  const indexRef = useRef(0);
  const setIndex = (next: number) => {
    indexRef.current = next;
    setIndexState(next);
  };
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const choices = useRef(services.settings.choices()).current;

  useEffect(() => {
    void services.settings.get().then(setCurrent);
    void services.settings.mouse().then(setMouse);
    void services.settings.notify().then(setNotify);
  }, [services]);

  // On and off, so ⏎ flips it rather than opening a list of two.
  const toggleMouse = async () => {
    const next = await services.settings.setMouse(!(mouse ?? true));
    setMouse(next);
    onMouse?.(next);
    onSaved(`Mouse: ${next ? "on" : "off"}`);
  };

  const save = async (key: Key, value: string) => {
    const next = await services.settings.set({ [key]: value });
    setCurrent(next);
    setMode({ kind: "list" });
    const row = ROWS.find((entry) => entry.key === key)!;
    onSaved(`${row.label}: ${describe(key, next[key])}`);
  };

  // Open the selected setting: a list to choose from, or on and off for the mouse.
  const change = (at: number) => {
    const chosen = (ROWS[at] as (typeof ROWS)[number]).key;
    if (chosen === "mouse") return void toggleMouse();
    if (chosen === "notify" || chosen === "webhook") return setMode({ kind: chosen });
    setMode({ kind: "pick", key: chosen });
  };
  // A click chooses a setting; a click on the chosen one changes it, as ⏎ does.
  const rowNodes = useRefs<number>();
  useMouse(
    (event, at) => {
      if (event.kind !== "click") return false;
      const hit = rowNodes.entries().find(([, node]) => at(node));
      if (!hit) return false;
      if (hit[0] === indexRef.current) change(hit[0]);
      else setIndex(hit[0]);
      return true;
    },
    mode.kind === "list",
  );

  useInput(
    (input, key) => {
      if (key.escape || input === "q" || input === "s") return onClose();
      if (key.upArrow || input === "k") return setIndex(Math.max(0, indexRef.current - 1));
      if (key.downArrow || input === "j") return setIndex(Math.min(ROWS.length - 1, indexRef.current + 1));
      if (key.return || input === " ") return change(indexRef.current);
    },
    { isActive: mode.kind === "list" },
  );

  if (mode.kind === "pick") {
    const row = ROWS.find((entry) => entry.key === mode.key)!;
    const options =
      mode.key === "terminal"
        ? [
            { key: DEFAULT, title: "In the background", detail: "no windows: watch them in the Running tab", group: "Default" },
            ...choices.terminals
              .filter((name) => name !== "tmux" && name !== "zellij")
              .map((name) => ({ key: name, title: `A ${name} window`, detail: "each command in a window of its own", group: "A terminal" })),
            ...choices.terminals
              .filter((name) => name === "tmux" || name === "zellij")
              .map((name) => ({ key: name, title: `A ${name} session`, detail: name === "tmux" ? "the one for servers over SSH: attach later with tmux attach -t wisp" : "inside the zellij you are in", group: "A multiplexer" })),
          ]
        : [
            { key: DEFAULT, title: "The system default", detail: "Finder, or your desktop's file manager or app", group: "Default" },
            ...choices.editors.map((editor) => ({ key: editor.value, title: editor.label, detail: "installed here", group: "An editor" })),
            { key: OTHER, title: "Another app…", detail: "type its name", group: "Other" },
          ];
    return (
      <Picker
        title={row.label}
        intro={`For ${row.what}. Saved on this machine only.`}
        options={options}
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onPick={(picked) => {
          if (picked === OTHER) return setMode({ kind: "other", key: mode.key });
          void save(mode.key, picked === DEFAULT ? "" : picked);
        }}
      />
    );
  }

  if (mode.kind === "notify") {
    return (
      <Picker
        title="Tell me"
        intro="About a run you might have missed: one nobody watched (cron, a script), or one that took over 30 seconds. On this screen, and at the webhook if you set one."
        options={[
          { key: "failures", title: "When a run fails", detail: "the default", group: "Choose" },
          { key: "all", title: "When any run ends", detail: "passed or failed", group: "Choose" },
          { key: "off", title: "Never", detail: "", group: "Choose" },
        ]}
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onPick={(picked) => {
          void services.settings.setNotify({ when: picked as NotifyChoice["when"] }).then((next) => {
            setNotify(next);
            setMode({ kind: "list" });
            onSaved(`Tell me: ${WHEN[next.when]}`);
          });
        }}
      />
    );
  }

  if (mode.kind === "webhook") {
    return (
      <Form
        title="Webhook"
        intro="Where to post it as well, so a server can reach you. Slack, Discord and ntfy get a message they show as it is; any other address gets JSON."
        fields={[{ key: "url", label: "Address", hint: "leave it empty for none", placeholder: "https://ntfy.sh/my-server" }]}
        initial={{ url: notify?.webhook ?? "" }}
        submitLabel="Save"
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "list" })}
        onSubmit={async (values) => {
          const url = values["url"]?.trim() ?? "";
          const refused = url ? webhookProblem(url) : undefined;
          if (refused) return { url: refused };
          const next = await services.settings.setNotify({ webhook: url });
          setNotify(next);
          setMode({ kind: "list" });
          onSaved(`Webhook: ${next.webhook ?? "none"}`);
          return undefined;
        }}
      />
    );
  }

  if (mode.kind === "other") {
    const row = ROWS.find((entry) => entry.key === mode.key)!;
    return (
      <Form
        title={row.label}
        intro={`For ${row.what}.`}
        fields={[{ key: "app", label: "App", hint: "its name on macOS, or a command on Linux and Windows", placeholder: "Visual Studio Code", required: true }]}
        initial={{ app: current?.[mode.key] ?? "" }}
        submitLabel="Save"
        glyphs={glyphs}
        height={height}
        onCancel={() => setMode({ kind: "pick", key: mode.key })}
        onSubmit={async (values) => {
          await save(mode.key, values["app"]?.trim() ?? "");
          return undefined;
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={TONE.accent} paddingX={1}>
      <Text bold color={TONE.accent}>Settings</Text>
      <Text dimColor>Your own choices, saved on this machine only. A project's file never changes them.</Text>
      <Text> </Text>
      {ROWS.map((row, at) => {
        const selected = at === index;
        return (
          <Box key={row.key} ref={rowNodes.set(at)} flexDirection="column" flexShrink={0}>
            <Text wrap="truncate-end">
              <Text color={TONE.accent}>{selected ? `${glyphs.pointer} ` : "  "}</Text>
              <Text bold={selected} color={selected ? TONE.accent : undefined}>{row.label.padEnd(18)}</Text>
              <Text>
                {row.key === "mouse"
                  ? mouse === undefined
                    ? "…"
                    : mouse
                      ? "on"
                      : "off"
                  : row.key === "notify"
                    ? notify
                      ? WHEN[notify.when]
                      : "…"
                    : row.key === "webhook"
                      ? notify
                        ? (notify.webhook ?? "none")
                        : "…"
                      : current
                        ? describe(row.key, current[row.key])
                        : "…"}
              </Text>
            </Text>
            {selected ? <Text dimColor wrap="truncate-end">{`    ${row.what}`}</Text> : null}
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor>{"↑↓ choose · ⏎ change · esc back   (also on the command line: wisp open-with, wisp notify)"}</Text>
    </Box>
  );
}

/** A setting in words: what it is, or what happens when nothing is chosen. */
function describe(key: Key, value: string | undefined): string {
  if (value) return key === "terminal" ? (value === "tmux" || value === "zellij" ? `in a ${value} session` : `in a ${value} window`) : value;
  return key === "terminal" ? "in the background, watched in Wisp" : "the system default";
}
