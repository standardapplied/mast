import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gridFor,
  type PtySink,
  type Renderer,
  TerminalController,
} from "./terminalController";
import type { Cursor, GridSnapshot } from "./vtCore";
import { VtCore } from "./vtCore";

const WASM = readFileSync(join(import.meta.dir, "ghostty-vt.wasm"));

class RecRenderer implements Renderer {
  resizes: [number, number][] = [];
  applied: GridSnapshot[] = [];
  cursors: Cursor[] = [];
  draws = 0;
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
}

class RecSink implements PtySink {
  writes: number[][] = [];
  resizes: [number, number][] = [];
  write(bytes: Uint8Array): void {
    this.writes.push(Array.from(bytes));
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
}

const enc = (s: string) => new TextEncoder().encode(s);

function rowText(snapshot: GridSnapshot, y: number): string {
  const row = snapshot.rows.find((r) => r.y === y);
  return row ? row.cells.map((c) => c.text).join("").trimEnd() : "";
}

let cores: VtCore[] = [];
async function harness(cols = 80, rows = 24) {
  const core = await VtCore.create(WASM, cols, rows);
  cores.push(core);
  const renderer = new RecRenderer();
  const sink = new RecSink();
  const controller = new TerminalController(core, renderer, sink);
  return { core, renderer, sink, controller };
}
afterEach(() => {
  cores.forEach((c) => c.free());
  cores = [];
});

describe("TerminalController", () => {
  test("sizes the renderer to the terminal on construction", async () => {
    const { renderer } = await harness(100, 30);
    expect(renderer.resizes).toEqual([[100, 30]]);
  });

  test("fed pty output reaches the renderer as cells", async () => {
    const { controller, renderer } = await harness();
    controller.feed(enc("hello"));
    controller.frame();
    const last = renderer.applied.at(-1)!;
    expect(rowText(last, 0)).toBe("hello");
    expect(renderer.draws).toBe(1);
  });

  test("empty output is a no-op", async () => {
    const { controller, core } = await harness();
    controller.feed(new Uint8Array(0));
    // A fresh terminal is fully dirty once; assert nothing beyond that was written.
    expect(core.snapshot().rows.every((r) => rowText(core.snapshot(), r.y) === "")).toBe(true);
  });

  test("frames are damage-aware: an unchanged frame re-draws but re-applies nothing", async () => {
    const { controller, renderer } = await harness();
    controller.feed(enc("x"));
    controller.frame();
    const appliedAfterFirst = renderer.applied.length;
    controller.frame();
    expect(renderer.applied.length).toBe(appliedAfterFirst);
    expect(renderer.draws).toBe(2);
    expect(renderer.cursors.length).toBe(2);
  });

  test("the blink phase folds into the cursor's own visibility", async () => {
    const { controller, renderer } = await harness();
    controller.frame(true);
    controller.frame(false);
    expect(renderer.cursors.at(-1)!.visible).toBe(false);
  });

  test("a key press is encoded and sent to the pty; nothing is echoed locally", async () => {
    const { controller, sink, renderer } = await harness();
    const before = renderer.applied.length;
    expect(controller.key({ key: "a" })).toBe(true);
    expect(sink.writes).toEqual([[0x61]]);
    expect(renderer.applied.length).toBe(before); // no local echo
  });

  test("a key that produces nothing returns false and sends nothing", async () => {
    const { controller, sink } = await harness();
    expect(controller.key({ key: "Shift" })).toBe(false);
    expect(sink.writes).toEqual([]);
  });

  test("paste sends the text; an empty paste sends nothing", async () => {
    const { controller, sink } = await harness();
    controller.paste("ls\n");
    controller.paste("");
    expect(sink.writes).toEqual([Array.from(enc("ls\n"))]);
  });

  test("resize reflows the core, resizes the renderer, and notifies the pty", async () => {
    const { controller, core, renderer, sink } = await harness(80, 24);
    controller.resize(120, 40);
    expect(core.size).toEqual({ cols: 120, rows: 40 });
    expect(renderer.resizes).toEqual([[80, 24], [120, 40]]);
    expect(sink.resizes).toEqual([[120, 40]]);
    expect(controller.size).toEqual({ cols: 120, rows: 40 });
  });

  test("a same-size resize is a no-op", async () => {
    const { controller, renderer, sink } = await harness(80, 24);
    controller.resize(80, 24);
    expect(renderer.resizes).toEqual([[80, 24]]); // only the constructor's
    expect(sink.resizes).toEqual([]);
  });
});

describe("gridFor", () => {
  test("the largest grid that fits, floored", () => {
    expect(gridFor(800, 480, 9, 19)).toEqual({ cols: 88, rows: 25 });
    expect(gridFor(801, 481, 9, 19)).toEqual({ cols: 89, rows: 25 });
  });

  test("never smaller than 1×1", () => {
    expect(gridFor(0, 0, 9, 19)).toEqual({ cols: 1, rows: 1 });
    expect(gridFor(4, 4, 9, 19)).toEqual({ cols: 1, rows: 1 });
  });
});
