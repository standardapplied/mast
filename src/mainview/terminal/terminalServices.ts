import { createContext, useContext } from "react";
import type { HostListing } from "./connection";
import type { RendererOptions, SurfaceRenderer } from "./renderer";
import type { Timers } from "./terminalController";

/**
 * What a session pane needs from the platform, behind one injectable seam: the session link (the
 * Rust core's `session_*` commands and the channel they answer on), the VT wasm, the renderer, and
 * the identity the terminal reports. The Tauri implementation lives in `tauri/terminalServices.ts`
 * and is provided once at the entry; tests provide fakes, so the pane itself — the transport edge
 * that used to be the untested surface — runs under happy-dom with a scripted channel.
 */

/** A session to create before attaching; the pane overrides cols/rows with its fit. */
export interface SessionCreate {
  readonly command: string[];
  readonly cwd: string;
  readonly project: string;
  /** Bind the session to a room; the host gates admission and refuses verbatim. */
  readonly room?: string;
  readonly cols: number;
  readonly rows: number;
}

export interface SessionOpen {
  /** This attachment's id — the key every later command and event names. */
  readonly id: string;
  readonly socketPath: string;
  readonly token: string;
  readonly session: string;
  readonly write: boolean;
  readonly create: SessionCreate | null;
}

/**
 * What an attachment hears back: the one ordered raw channel carrying output bytes, replay
 * markers, state changes, and the ending (see dataFrames.ts). Total on the pane's side: a throw
 * must never park the channel.
 */
export type SessionFrames = (message: ArrayBuffer | Uint8Array) => void;

export interface SessionLink {
  list(socketPath: string, token: string): Promise<HostListing>;
  /**
   * Attaches (creating first when asked). Frames stream as soon as the host attaches, ahead of the
   * acknowledgement. Resolves once the host acknowledged the attach, with the detach that silences
   * the channel; rejects with the `{class, reason}` an ending carries.
   */
  open(spec: SessionOpen, onFrame: SessionFrames): Promise<() => void>;
  write(id: string, bytes: Uint8Array): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  takeWrite(id: string): Promise<void>;
  /** Ends the attachment (mid-prologue it abandons the open); the host session survives. */
  close(id: string): Promise<void>;
  /** The system clipboard as text; empty when unavailable. */
  readClipboard(): Promise<string>;
}

export interface TerminalServices {
  readonly link: SessionLink;
  /** The pinned VT wasm, compiled once; every pane instantiates its own copy. */
  readonly wasm: () => Promise<WebAssembly.Module>;
  readonly createRenderer: (
    canvas: HTMLCanvasElement,
    opts: RendererOptions,
  ) => Promise<SurfaceRenderer>;
  /** What the terminal answers to XTVERSION (CSI > q). */
  readonly identity: () => Promise<string>;
  /** The timers a pane's resize settles on; absent means the window's own. */
  readonly timers?: Timers;
}

const TerminalServicesContext = createContext<TerminalServices | null>(null);

export const TerminalServicesProvider = TerminalServicesContext.Provider;

export function useTerminalServices(): TerminalServices {
  const services = useContext(TerminalServicesContext);
  if (!services) {
    throw new Error("SessionTerminalPane needs a TerminalServicesProvider above it");
  }
  return services;
}
