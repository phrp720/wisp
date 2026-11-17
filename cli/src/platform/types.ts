import type { Invocation, OS } from "../core/types.js";

/** One open browser tab, located well enough to be brought to the front later. */
export interface Tab {
  browser: string;
  window: number;
  index: number;
  url: string;
}

export interface OpenOptions {
  /** Open without stealing focus, where the platform can. */
  background?: boolean;
}

export interface TerminalRequest {
  /** The terminal to use, by the name {@link Platform.findTerminal} settled on. */
  terminal: string;
  /** What the window is called, where the terminal lets us say. */
  title: string;
}

/**
 * Everything Wisp needs from an operating system's desktop.
 *
 * Core decides what to open and in which order; a platform only knows how. Commands reach
 * a platform already folded into a single invocation — shell, directory and environment
 * included — so a platform never has to know what shell a command was written for.
 *
 * Optional members are things only some platforms can do: finding an open browser tab
 * needs AppleScript, so it exists on macOS alone, and core falls back to opening anew.
 */
export interface Platform {
  os: OS;

  openUrl(url: string, options?: OpenOptions): Promise<void>;
  /** A folder or file, in the default app or the one named. */
  openPath(path: string, options?: OpenOptions & { app?: string }): Promise<void>;
  /** Launch an app, or bring it forward if it is already running. */
  launchApp(app: string, options?: OpenOptions): Promise<void>;

  /** Start a command in a new terminal window and step back. */
  runInTerminal(invocation: Invocation, request: TerminalRequest): Promise<void>;

  /** Terminals this platform can hand a command to, one name per app. */
  knownTerminals(): string[];
  /** The canonical name of the terminal a reference means, if it is one we know. */
  findTerminal(ref: string): string | undefined;
  /** The terminal to use when you have not chosen one: the one you are in, or the usual one. */
  defaultTerminal(): string | undefined;

  tabs?: {
    snapshot(): Promise<Tab[]>;
    focus(tab: Tab): Promise<void>;
  };
}
