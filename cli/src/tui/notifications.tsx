import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

import { addWebhook, type Delivery, lastDelivery, maskWebhook } from "../core/notify.js";
import { ASK_KEYS, AskHere, Form } from "./forms.js";
import type { Glyphs } from "./glyphs.js";
import type { NotifyChoice, Services } from "./model.js";
import { useMouse, useRefs } from "./mouse.js";
import { TONE } from "./tones.js";

export const WHEN = { failures: "when a run fails", changes: "when a pipeline starts failing or works again", all: "when any run ends", off: "never" } as const;

const MOST_AT_ONCE = 8;

type Row = { kind: "when" } | { kind: "hook"; at: number } | { kind: "add" };
type Open = { kind: "when" } | { kind: "add" } | { kind: "hook"; at: number };

function delivered(delivery: Delivery | undefined): { text: string; failed: boolean } {
  if (!delivery) return { text: "nothing sent yet", failed: false };
  return delivery.ok ? { text: "last one delivered", failed: false } : { text: `✗ last one failed: ${delivery.problem ?? "no reason given"}`, failed: true };
}

export function webhookCount(count: number): string {
  return count === 0 ? "" : count === 1 ? " · 1 webhook" : ` · ${count} webhooks`;
}

export function NotificationsPanel({
  services,
  notify,
  deliveries,
  workspaces,
  glyphs,
  height,
  title,
  intro,
  active,
  onChange,
  onSaved,
  onClose,
}: {
  services: Services;
  notify: NotifyChoice;
  deliveries: Record<string, Delivery>;
  workspaces: { name: string; file: string }[];
  glyphs: Glyphs;
  height: number;
  title: string;
  intro: string;
  active: boolean;
  onChange: (next: NotifyChoice) => void;
  onSaved: (text: string) => void;
  onClose: () => void;
}) {
  const hooks = notify.webhooks;
  const rows: Row[] = [{ kind: "when" }, ...hooks.map((_hook, at): Row => ({ kind: "hook", at })), { kind: "add" }];
  const firstFailing = hooks.findIndex((hook) => lastDelivery(deliveries, hook.url)?.ok === false);
  const [index, setIndexState] = useState(firstFailing >= 0 ? firstFailing + 1 : 0);
  const indexRef = useRef(index);
  const setIndex = (next: number) => {
    indexRef.current = next;
    setIndexState(next);
  };
  const [open, setOpen] = useState<Open>();
  const [removing, setRemoving] = useState<number>();
  const [session, setSession] = useState(0);
  const selected = Math.min(index, rows.length - 1);
  const nameOf = (file: string) => workspaces.find((entry) => entry.file === file)?.name ?? file;
  const ticked = (values: Record<string, string>) => {
    const files = (values["for"] ?? "").split(",").filter(Boolean);
    return workspaces.length > 0 && workspaces.every((entry) => files.includes(entry.file)) ? [] : files;
  };
  const scope = (files: string[] | undefined) => {
    if (!files) return "every workspace";
    if (workspaces.length > 1 && workspaces.every((entry) => files.includes(entry.file))) return "all workspaces";
    return files.map(nameOf).join(", ");
  };

  const back = () => {
    setOpen(undefined);
    setSession((count) => count + 1);
  };
  const save = async (webhooks: NotifyChoice["webhooks"], said: string) => {
    const next = await services.settings.setNotify({ webhooks });
    onChange(next);
    onSaved(said);
    return next;
  };
  const edit = (row: Row) => {
    if (row.kind === "hook" && workspaces.length === 0) return;
    setOpen(row.kind === "hook" ? { kind: "hook", at: row.at } : { kind: row.kind });
  };

  useInput(
    (input, key) => {
      const at = Math.min(indexRef.current, rows.length - 1);
      const row = rows[at] as Row;
      if (key.escape || input === "q") return onClose();
      if (key.upArrow || input === "k") return setIndex(Math.max(0, at - 1));
      if (key.downArrow || input === "j") return setIndex(Math.min(rows.length - 1, at + 1));
      if (key.return || key.rightArrow || input === " ") return edit(row);
      if (input === "a") return setOpen({ kind: "add" });
      if (row.kind === "hook" && (input === "D" || input === "x" || key.delete || key.backspace)) return setRemoving(row.at);
    },
    { isActive: active && open === undefined && removing === undefined },
  );

  const rowNodes = useRefs<number>();
  useMouse(
    (event, at) => {
      if (event.kind !== "click") return false;
      const hit = rowNodes.entries().find(([, node]) => at(node));
      if (!hit) return false;
      if (hit[0] === selected) edit(rows[hit[0]] as Row);
      else setIndex(hit[0]);
      return true;
    },
    active && open === undefined && removing === undefined,
  );

  const forChoices = workspaces.map((entry) => ({ value: entry.file, label: entry.name }));

  if (active && open?.kind === "when") {
    return (
      <Form
        key={`when:${session}`}
        title="Inform me"
        intro="On this screen, and at every webhook."
        fields={[{ key: "when", label: "Inform me", choices: (Object.keys(WHEN) as (keyof typeof WHEN)[]).map((value) => ({ value, label: WHEN[value] })) }]}
        initial={{ when: notify.when }}
        submitLabel="Save"
        cancelLabel="Back"
        glyphs={glyphs}
        height={height}
        onCancel={back}
        onSubmit={async (values) => {
          const next = await services.settings.setNotify({ when: values["when"] as NotifyChoice["when"] });
          onChange(next);
          onSaved(`Inform me ${WHEN[next.when]}${webhookCount(next.webhooks.length)}`);
          back();
          return undefined;
        }}
      />
    );
  }

  if (active && open?.kind === "add") {
    const keys = Array.from({ length: MOST_AT_ONCE }, (_, at) => `url${at}`);
    return (
      <Form
        key={`add:${session}`}
        title="Add webhooks"
        intro="Slack, Discord, Teams and ntfy get a message they show as it is; any other address gets JSON. Fill one in and there's room for the next."
        fields={[
          ...keys.map((key, at) => ({
            key,
            label: at === 0 ? "Address" : `Address ${at + 1}`,
            required: at === 0,
            placeholder: at === 0 ? "https://hooks.slack.com/services/..." : "another one, or leave it empty",
            ...(at > 0 ? { when: (values: Record<string, string>) => Boolean(values[keys[at - 1] as string]?.trim()) } : {}),
          })),
          ...(workspaces.length > 0 ? [{ key: "for", label: "For", hint: "none or all ticked: every workspace", multi: true, choices: forChoices }] : []),
        ]}
        submitLabel="Add"
        cancelLabel="Back"
        glyphs={glyphs}
        height={height}
        onCancel={back}
        onSubmit={async (values) => {
          const files = ticked(values);
          let webhooks = hooks;
          const errors: Record<string, string> = {};
          let added = 0;
          for (const key of keys) {
            const url = values[key]?.trim();
            if (!url) continue;
            try {
              webhooks = addWebhook(webhooks, url, files);
              added += 1;
            } catch (error) {
              errors[key] = error instanceof Error ? error.message.replace(/^"[^"]*": /, "") : String(error);
            }
          }
          if (Object.keys(errors).length > 0) return errors;
          const next = await save(webhooks, added === 1 ? "Added a webhook" : `Added ${added} webhooks`);
          setIndex(next.webhooks.length + 1);
          back();
          return undefined;
        }}
      />
    );
  }

  if (active && open?.kind === "hook") {
    const hook = hooks[open.at];
    if (hook) {
      return (
        <Form
          key={`hook:${open.at}:${session}`}
          title={maskWebhook(hook.url)}
          intro={delivered(lastDelivery(deliveries, hook.url)).text}
          fields={[{ key: "for", label: "For", hint: "none or all ticked: every workspace", multi: true, choices: forChoices }]}
          initial={{ for: (hook.workspaces ?? []).join(",") }}
          submitLabel="Save"
          cancelLabel="Back"
          glyphs={glyphs}
          height={height}
          onCancel={back}
          onSubmit={async (values) => {
            const files = ticked(values);
            const changed = { url: hook.url, ...(files.length > 0 ? { workspaces: files } : {}) };
            await save(
              hooks.map((other, at) => (at === open.at ? changed : other)),
              files.length > 0 ? `It's for ${files.map(nameOf).join(", ")} now` : "It's for every workspace now",
            );
            back();
            return undefined;
          }}
        />
      );
    }
  }

  const pointer = (at: number) => <Text color={TONE.accent}>{active && at === selected ? `${glyphs.pointer} ` : "  "}</Text>;
  const on = (at: number) => active && at === selected;
  const row = rows[selected] as Row;
  const hint =
    removing !== undefined
      ? `It stops getting messages · ${ASK_KEYS}`
      : ["↑↓ choose", row.kind === "hook" ? (workspaces.length > 0 ? "⏎ workspaces" : "") : "⏎ edit", "a add", row.kind === "hook" ? "D remove" : "", "esc back"].filter(Boolean).join(" · ");

  return (
    <Box flexDirection="column" height={height} borderStyle={glyphs.border} borderColor={active ? TONE.accent : "gray"} paddingX={1} overflow="hidden">
      <Text bold color={active ? TONE.accent : undefined}>{title}</Text>
      <Text dimColor wrap="wrap">{intro}</Text>
      <Text> </Text>
      <Box ref={rowNodes.set(0)}>
        <Text wrap="truncate-end">
          {pointer(0)}
          <Text bold={on(0)} color={on(0) ? TONE.accent : undefined}>{"Inform me".padEnd(10)}</Text>
          <Text>{WHEN[notify.when]}</Text>
        </Text>
      </Box>
      <Text> </Text>
      <Text bold>  Webhooks</Text>
      {hooks.map((hook, at) => {
        const state = delivered(lastDelivery(deliveries, hook.url));
        return (
          <Box key={hook.url} flexDirection="column">
            <Box ref={rowNodes.set(at + 1)} flexDirection="column">
              <Text wrap="truncate-end">
                {pointer(at + 1)}
                <Text dimColor>{`${String(at + 1).padStart(2)}  `}</Text>
                <Text bold={on(at + 1)} color={at === removing ? "red" : on(at + 1) ? TONE.accent : undefined}>{maskWebhook(hook.url)}</Text>
                <Text dimColor>{`  ${scope(hook.workspaces)}`}</Text>
              </Text>
              <Text wrap="truncate-end" color={state.failed ? TONE.failed : undefined} dimColor={!state.failed}>{`      ${state.text}`}</Text>
            </Box>
            {at === removing ? (
              <AskHere
                question="Remove this webhook?"
                yes="Remove"
                onAnswer={(yes) => {
                  setRemoving(undefined);
                  if (!yes) return;
                  void save(
                    hooks.filter((_other, other) => other !== at),
                    `Removed ${maskWebhook(hook.url)}`,
                  )
                    .then((next) => setIndex(Math.min(at + 1, next.webhooks.length)))
                    .catch((error: unknown) => onSaved(error instanceof Error ? error.message : String(error)));
                }}
              />
            ) : null}
          </Box>
        );
      })}
      <Box ref={rowNodes.set(hooks.length + 1)}>
        <Text wrap="truncate-end">
          {pointer(hooks.length + 1)}
          <Text color={TONE.accent} bold={on(hooks.length + 1)}>{`${hooks.length > 0 ? "    " : ""}+  ${hooks.length === 0 ? "add a webhook" : "add webhooks"}`}</Text>
        </Text>
      </Box>
      <Box flexGrow={1} />
      {active ? <Text dimColor wrap="truncate-end">{hint}</Text> : null}
    </Box>
  );
}
