import { type Key, useInput } from "ink";
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from "react";

export type KeyHandler = (input: string, key: Key) => void;

interface Listener {
  handler: { current: KeyHandler };
  active: { current: boolean };
}

export type KeyListeners = Set<Listener>;

export const KeysContext = createContext<KeyListeners | undefined>(undefined);

export function useKeyRoot(): KeyListeners {
  const [listeners] = useState<KeyListeners>(() => new Set());
  const dispatch = useCallback<KeyHandler>((input, key) => {
    for (const listener of [...listeners]) if (listener.active.current) listener.handler.current(input, key);
  }, [listeners]);
  useInput(dispatch);
  return listeners;
}

export function useKeys(handler: KeyHandler, options: { isActive?: boolean } = {}, root?: KeyListeners): void {
  const shared = useContext(KeysContext);
  const listeners = root ?? shared;
  const isActive = options.isActive ?? true;
  const latest = useRef(handler);
  const active = useRef(isActive);
  useLayoutEffect(() => {
    latest.current = handler;
    active.current = isActive;
  });
  useLayoutEffect(() => {
    if (!listeners) return;
    const listener: Listener = { handler: latest, active };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [listeners]);
  useInput(handler, { isActive: isActive && !listeners });
}
