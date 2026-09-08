import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostListing } from "../src/mainview/terminal/connection";
import type { Gateway } from "../src/mainview/gateway";
import type { RendererOptions, SurfaceRenderer } from "../src/mainview/terminal/renderer";
import type {
  SessionLanes,
  SessionLink,
  SessionOpen,
  TerminalServices,
} from "../src/mainview/terminal/terminalServices";
import type { Cursor, GridSnapshot } from "../src/mainview/terminal/vtCore";

/**
 * The pane's platform seam, scripted: a link whose lanes the test drives by hand, a renderer that
 * records instead of drawing, and the vendored VT wasm (the real core runs). Component tests at
 * the transport edge are built on these — the 0.1.79 crash was one detached call that 865
 * pure-logic tests could not see.
 */

const WASM = readFileSync(join(import.meta.dir, "../src/mainview/terminal/ghostty-vt.wasm"));
let compiled: Promise<WebAssembly.Module> | null = null;

/** One attachment the fake link accepted: what was asked, and the lanes to answer on. */
export interface FakeAttachment {
  readonly spec: SessionOpen;
  readonly lanes: SessionLanes;
  detached: boolean;
}

export class FakeLink implements SessionLink {
  listing: HostListing = { hostBootId: "boot-1", sessions: [] };
  readonly opens: FakeAttachment[] = [];
  readonly writes: { id: string; bytes: Uint8Array }[] = [];
  readonly resizes: { id: string; cols: number; rows: number }[] = [];
  readonly closed: string[] = [];
  readonly takes: string[] = [];
  clipboard = "";
  private waiters: Array<(attachment: FakeAttachment) => void> = [];

  async list(): Promise<HostListing> {
    return this.listing;
  }

  async open(spec: SessionOpen, lanes: SessionLanes): Promise<() => void> {
    const attachment: FakeAttachment = { spec, lanes, detached: false };
    this.opens.push(attachment);
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve(attachment));
    return () => {
      attachment.detached = true;
    };
  }

  /** Resolves with the first attachment the pane opens (at once, if it already did). */
  opened(): Promise<FakeAttachment> {
    const first = this.opens[0];
    if (first) return Promise.resolve(first);
    return this.nextOpen();
  }

  /** Resolves with the next attachment opened after this call. */
  nextOpen(): Promise<FakeAttachment> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async write(id: string, bytes: Uint8Array): Promise<void> {
    this.writes.push({ id, bytes });
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    this.resizes.push({ id, cols, rows });
  }

  async takeWrite(id: string): Promise<void> {
    this.takes.push(id);
  }

  async close(id: string): Promise<void> {
    this.closed.push(id);
  }

  async readClipboard(): Promise<string> {
    return this.clipboard;
  }
}

export class FakeRenderer implements SurfaceRenderer {
  readonly cellSize = { w: 10, h: 20 };
  readonly resizes: [number, number][] = [];
  readonly applied: GridSnapshot[] = [];
  cursors: Cursor[] = [];
  draws = 0;
  destroyed = false;
  constructor(readonly opts: RendererOptions) {}
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  apply(snapshot: GridSnapshot): void {
    this.applied.push(snapshot);
  }
  setCursor(cursor: Cursor): void {
    this.cursors.push(cursor);
  }
  draw(): void {
    this.draws++;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export interface FakeTerminalServices extends TerminalServices {
  readonly link: FakeLink;
  readonly renderers: FakeRenderer[];
  /** Set to make the next renderer creation fail with this message. */
  rendererFailure: string | null;
}

export function fakeTerminalServices(): FakeTerminalServices {
  const renderers: FakeRenderer[] = [];
  const services: FakeTerminalServices = {
    link: new FakeLink(),
    renderers,
    rendererFailure: null,
    wasm: () => {
      compiled ??= WebAssembly.compile(WASM);
      return compiled;
    },
    createRenderer: async (_canvas, opts) => {
      if (services.rendererFailure) {
        const message = services.rendererFailure;
        services.rendererFailure = null;
        throw new Error(message);
      }
      const renderer = new FakeRenderer(opts);
      renderers.push(renderer);
      return renderer;
    },
    identity: async () => "mast test",
  };
  return services;
}

/** A gateway that lists an empty box, enough for the session store to own lane facts. */
export function emptyBoxGateway(): Gateway {
  return {
    listSessions: async () => ({
      ok: true as const,
      value: { hostBootId: "boot-1", sessions: [] },
    }),
  } as unknown as Gateway;
}

/**
 * happy-dom lays nothing out, so every element measures 0×0 and a pane would attach hidden at
 * 80×24 after its stable-size wait ran out. Give elements a size instead: 820×496 CSS px, which at
 * the fake renderer's 10×20 cell and the pane's padding is exactly 80×24.
 */
export function layOutElements(): () => void {
  const proto = HTMLElement.prototype;
  const width = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  const height = Object.getOwnPropertyDescriptor(proto, "clientHeight");
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 820 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 496 });
  return () => {
    if (width) Object.defineProperty(proto, "clientWidth", width);
    else delete (proto as unknown as Record<string, unknown>).clientWidth;
    if (height) Object.defineProperty(proto, "clientHeight", height);
    else delete (proto as unknown as Record<string, unknown>).clientHeight;
  };
}
