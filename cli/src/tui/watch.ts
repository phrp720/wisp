import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef, useState } from "react";

import { type Container, containerMood, type ContainerStats } from "../core/system/docker.js";
import type { HistoryEntry } from "../core/history.js";
import type { RunStatus } from "../core/system/processes.js";
import type { Services } from "./model.js";
import type { Notice, PaneItem } from "./state.js";

type Notify = (text: string, tone: Notice["tone"]) => void;

export function useRuns(services: Services, viewKind: string, notify: Notify, expected: MutableRefObject<Set<string>>): [RunStatus[], Dispatch<SetStateAction<RunStatus[]>>] {
  const [runs, setRuns] = useState<RunStatus[]>([]);
  const seen = useRef<Map<string, boolean> | undefined>(undefined);
  const askedAbout = useRef(new Set<string>());
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const next = await services.runs();
      if (!alive) return;
      setRuns(next);
      // Anything that stopped or started since the last look — unless it was asked for here.
      const before = seen.current;
      if (before) {
        for (const run of next) {
          const was = before.get(run.id);
          if (was === true && !run.alive) {
            if (expected.current.delete(run.id)) continue;
            // Finished by itself is news, not trouble; only a failure or a crash is red.
            if (run.exitCode === 0) notify(`${run.label} finished (${run.workspaceName})`, "info");
            else if (run.exitCode !== undefined) notify(`${run.label} failed, exit code ${run.exitCode} (${run.workspaceName}) — press p to see why`, "bad");
            else notify(`${run.label} stopped (${run.workspaceName}) — press p to see its last output`, "bad");
          } else if (was === undefined && run.alive && !expected.current.has(run.id)) {
            notify(`${run.label} started (${run.workspaceName})`, "good");
          }
          // Once per question: a command that went quiet asking something can't be answered
          // in the background, so say so, and how to fix the pipeline.
          if (run.alive && run.waiting && !askedAbout.current.has(run.id)) {
            askedAbout.current.add(run.id);
            notify(`${run.label} is waiting for an answer: "${run.waiting}". Give it a flag like --yes, or run commands in a terminal window (s)`, "bad");
          }
        }
      }
      seen.current = new Map(next.map((run) => [run.id, run.alive]));
    };
    void refresh();
    const timer = setInterval(refresh, viewKind === "processes" ? 1000 : 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [services, viewKind]);
  return [runs, setRuns];
}

export function useContainers(services: Services, files: string[], panesOpen: boolean, notify: Notify, expected: MutableRefObject<Set<string>>): { containers: Container[]; dockerError: string | undefined } {
  const [containers, setContainers] = useState<Container[]>([]);
  const [dockerError, setDockerError] = useState<string>();
  const seen = useRef<Map<string, string> | undefined>(undefined);
  useEffect(() => {
    if (files.length === 0) {
      setContainers([]);
      return;
    }
    let alive = true;
    const refresh = async () => {
      const { containers: next, error } = await services.containers(files);
      if (!alive) return;
      setContainers(next);
      setDockerError(error);
      const before = seen.current;
      if (before) {
        for (const container of next) {
          const was = before.get(container.name);
          const now = containerMood(container).word;
          if (!was || was === now) continue;
          if (expected.current.delete(container.name)) continue;
          if (now === "unhealthy") notify(`${container.service} is unhealthy — press p to see its logs`, "bad");
          else if (now === "exited" || now === "dead") notify(`${container.service} stopped (${container.status}) — press p to see why`, "bad");
          else if ((now === "healthy" || now === "running") && (was === "unhealthy" || was === "exited" || was === "starting" || was === "restarting")) {
            notify(`${container.service} is ${now === "healthy" ? "healthy" : "running"} again`, "good");
          }
        }
      }
      seen.current = new Map(next.map((container) => [container.name, containerMood(container).word]));
    };
    void refresh();
    const timer = setInterval(refresh, panesOpen ? 1500 : 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [files.join("|"), panesOpen, services, notify]);
  return { containers, dockerError };
}

export function useContainerStats(services: Services, panesOpen: boolean, containers: Container[]): Map<string, ContainerStats> {
  const [stats, setStats] = useState<Map<string, ContainerStats>>(new Map());
  useEffect(() => {
    if (!panesOpen) return;
    const names = containers.filter((container) => container.state === "running").map((container) => container.name);
    if (names.length === 0) return;
    let alive = true;
    const refresh = async () => {
      const next = await services.containerStats(names);
      if (alive) setStats(next);
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panesOpen, containers.map((container) => `${container.name}:${container.state}`).join("|"), services]);
  return stats;
}

export function useRecent(services: Services, runDone: boolean | undefined, inSettings: boolean): { recent: HistoryEntry[]; webhooksFailing: number } {
  const [recent, setRecent] = useState<HistoryEntry[]>([]);
  const [webhooksFailing, setWebhooksFailing] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [next, failingHooks] = await Promise.all([services.history().catch(() => []), services.settings.failingWebhooks?.().catch(() => 0) ?? Promise.resolve(0)]);
      if (alive) {
        setRecent(next);
        setWebhooksFailing(failingHooks);
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [services, runDone, inSettings]);
  return { recent, webhooksFailing };
}

export interface LogSource {
  selectedItem: PaneItem | undefined;
  selectedRun: RunStatus | undefined;
  selectedContainer: Container | undefined;
  selectedStepLog: string | undefined;
  selectedStepLive: boolean;
  filteringLog: boolean;
}

export function useSelectedLog(services: Services, { selectedItem, selectedRun, selectedContainer, selectedStepLog, selectedStepLive, filteringLog }: LogSource): string {
  const [log, setLog] = useState("");
  useEffect(() => {
    if (selectedItem?.type !== "step") return;
    let alive = true;
    const read = () => {
      if (!selectedStepLog) return setLog("");
      void services
        .readLog(selectedStepLog)
        .then((text) => alive && setLog(text))
        .catch(() => alive && setLog(""));
    };
    read();
    const timer = selectedStepLive ? setInterval(read, 1000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [selectedItem?.type, selectedStepLog, selectedStepLive, services]);
  useEffect(() => {
    if (!selectedContainer) return;
    let alive = true;
    const refresh = async () => {
      const text = await services.containerLogs(selectedContainer.name, filteringLog ? 5000 : 1000);
      if (alive) setLog(text);
    };
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedContainer?.name, services, filteringLog]);
  useEffect(() => {
    if (!selectedRun) {
      if (!selectedContainer && selectedItem?.type !== "step") setLog("");
      return;
    }
    let alive = true;
    const refresh = async () => {
      // Raw lines, not lines shown: a screen-clearing server (Vite) pads each message with a
      // screenful of blank ones, which cleaning drops. The bytes keep it cheap.
      const text = await (filteringLog ? services.tail(selectedRun.log, 20_000, 4 * 1024 * 1024) : services.tail(selectedRun.log, 5000));
      if (alive) setLog(text);
    };
    void refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selectedRun?.id, selectedRun?.log, services, filteringLog]);
  return log;
}
