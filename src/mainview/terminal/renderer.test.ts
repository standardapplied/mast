import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RasterStub } from "../../../test/rasterStub";
import { TerminalRenderer } from "./renderer";

const FACE = { advance: 18, ascent: 30.6, descent: 9, capHeight: 21.9, exHeight: 16.5 };

const OPTS = {
  fontFamily: '"JetBrains Mono", monospace',
  fontPx: 15,
  dpr: 2,
  fg: [1, 2, 3] as const,
  bg: [4, 5, 6] as const,
  cursor: [7, 8, 9] as const,
  selectionBg: [10, 11, 12] as const,
  selectionFg: [13, 14, 15] as const,
};

/** An OffscreenCanvas whose 2D context is the recording raster stub, so the atlas pool works headless. */
class FakeOffscreenCanvas {
  private readonly ctx: RasterStub;
  constructor(width: number, height: number) {
    this.ctx = new RasterStub(width, height, FACE);
  }
  getContext(): RasterStub {
    return this.ctx;
  }
}

interface GlCall {
  readonly name: string;
  readonly args: unknown[];
}

/**
 * A WebGL2 context that records every call: object factories hand out tagged handles, status
 * queries succeed, and attached shaders are remembered so destroy() can find them.
 */
function fakeGl() {
  const calls: GlCall[] = [];
  const attached = new Map<object, object[]>();
  const lose = { loseContext: () => calls.push({ name: "loseContext", args: [] }) };
  const handle = (kind: string) => ({ kind });
  const gl = new Proxy(
    {},
    {
      get(_, name: string) {
        if (name === "isContextLost") return () => false;
        if (name === "getShaderParameter" || name === "getProgramParameter") return () => true;
        if (name === "getExtension") return () => lose;
        if (name === "getAttachedShaders") return (p: object) => attached.get(p) ?? [];
        return (...args: unknown[]) => {
          calls.push({ name, args });
          if (name === "attachShader") {
            const [p, s] = args as [object, object];
            attached.set(p, [...(attached.get(p) ?? []), s]);
          }
          if (name.startsWith("create")) return handle(name.slice("create".length));
          return undefined;
        };
      },
    },
  ) as WebGL2RenderingContext;
  return { gl, calls };
}

function fakeCanvas() {
  const { gl, calls } = fakeGl();
  const listeners = new Map<string, Set<EventListener>>();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => gl,
    addEventListener: (type: string, fn: EventListener) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
    },
    removeEventListener: (type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn);
    },
  } as unknown as HTMLCanvasElement;
  const names = (name: string) => calls.filter((c) => c.name === name);
  const loseContext = () => {
    const event = new Event("webglcontextlost", { cancelable: true });
    for (const fn of listeners.get("webglcontextlost") ?? []) fn(event);
    return event.defaultPrevented;
  };
  return { canvas, calls, names, loseContext };
}

describe("TerminalRenderer on WebGL2", () => {
  const saved = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  beforeEach(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeOffscreenCanvas;
  });
  afterEach(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = saved;
  });

  test("destroy frees its GPU objects and leaves the context alive for the next renderer on the canvas", async () => {
    const { canvas, names, loseContext } = fakeCanvas();
    const reported: string[] = [];
    const first = await TerminalRenderer.create(canvas, { ...OPTS, onLost: (reason) => reported.push(reason) });
    expect(first.backendName).toBe("webgl2");
    expect(loseContext(), "a loss is claimed for restoration").toBe(true);
    expect(reported).toEqual(["WebGL context lost"]);

    first.destroy();

    expect(names("loseContext"), "a lost context stays lost for every later renderer on this canvas").toEqual([]);
    expect(loseContext(), "a loss with no renderer alive is still claimed, or the canvas stays lost for good").toBe(true);
    expect(reported, "a dead renderer reports nothing").toEqual(["WebGL context lost"]);
    expect(names("deleteProgram").length).toBe(2);
    expect(names("deleteShader").length).toBe(4);
    expect(names("deleteBuffer").length).toBe(2);
    expect(names("deleteVertexArray").length).toBe(2);
    expect(names("deleteTexture").length).toBe(1);

    const second = await TerminalRenderer.create(canvas, { ...OPTS, onLost: (reason) => reported.push(reason) });
    expect(second.backendName).toBe("webgl2");
    expect(loseContext()).toBe(true);
    expect(reported, "one report per loss, not one per renderer ever built here").toEqual([
      "WebGL context lost",
      "WebGL context lost",
    ]);
    second.destroy();
  });
});
