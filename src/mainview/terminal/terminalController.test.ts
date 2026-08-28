import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gridFor,
  type PtySink,
  type Renderer,
  TerminalController,
} from "./terminalController";
import { Selection } from "./selection";
import { TerminalGrid } from "./terminalGrid";
import type { Cursor, GridSnapshot } from "./vtCore";
import { VtCore } from "./vtCore";

const WASM = readFileSync(join(import.meta.dir, "ghostty-vt.wasm"));

// Mirrors the real renderer: accumulates applied snapshots into a persistent grid, so tests can
// assert the built-up screen the way the renderer draws it — not just the per-frame dirty rows.
class RecRenderer implements Renderer {
  resizes: [number, number][] = [];
  applied: GridSnapshot[] = [];
  cursors: Cursor[] = [];
  draws = 0;
  readonly grid = new TerminalGrid();
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
    this.grid.resize(cols, rows);
  }
  apply(snapshot: GridSnapshot): void {
    this.applied.push(snapshot);
    this.grid.apply(snapshot);
  }
  setCursor(cursor: Cursor): void {
    this.cursors.push(cursor);
  }
  setSelection(): void {}
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

function gridRow(grid: TerminalGrid, y: number): string {
  let s = "";
  for (let x = 0; x < grid.cols; x++) s += grid.cell(x, y).text;
  return s.trimEnd();
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

  test("fed pty output reaches the renderer's grid as cells", async () => {
    const { controller, renderer } = await harness();
    controller.feed(enc("hello"));
    controller.frame();
    expect(gridRow(renderer.grid, 0)).toBe("hello");
    expect(renderer.draws).toBe(1);
  });

  test("a prompt and its typed echo build up on the right row across frames", async () => {
    const { controller, renderer } = await harness(20, 4);
    controller.feed(enc("$ "));
    controller.frame();
    controller.feed(enc("ls -la")); // a later frame only re-applies the dirty row
    controller.frame();
    expect(gridRow(renderer.grid, 0)).toBe("$ ls -la");
  });

  test("scrolled output stays aligned to the viewport in the grid", async () => {
    const { controller, renderer } = await harness(20, 3);
    controller.feed(enc("a\r\nb\r\nc\r\nd")); // 4 lines into 3 rows → viewport is b,c,d
    controller.frame();
    expect([0, 1, 2].map((y) => gridRow(renderer.grid, y))).toEqual(["b", "c", "d"]);
  });

  test("an echoed keystroke on the active line reaches the rendered grid", async () => {
    const { controller, renderer } = await harness(80, 40);
    controller.feed(enc("$ "));
    controller.frame();
    controller.feed(enc("x")); // one echoed keystroke edits the cursor row in place
    controller.frame();
    // The whole viewport is re-read on any change (libghostty-vt's dirty-row iterator drops
    // in-place edits on the active line), so an echo on the current row is never missed.
    expect(gridRow(renderer.grid, 0)).toBe("$ x");
  });

  test("selectedText reads the highlighted cells straight from the live grid", async () => {
    const { controller } = await harness(20, 3);
    controller.feed(enc("hello world"));
    controller.frame();
    controller.setSelection(new Selection({ x: 0, y: 0 }, { x: 4, y: 0 }, 20));
    expect(controller.selectedText()).toBe("hello");
    controller.setSelection(null);
    expect(controller.selectedText()).toBe("");
  });

  test("a scroll repaints at the new viewport, with no new pty output", async () => {
    const { controller, renderer } = await harness(20, 3);
    for (let i = 0; i < 8; i++) controller.feed(enc(`row${i}\r\n`));
    controller.frame();
    const before = renderer.applied.length;
    controller.scroll({ delta: -3 }); // up into scrollback
    controller.frame();
    expect(renderer.applied.length).toBeGreaterThan(before);
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

  test("Cmd chords never reach the pty — they belong to the app and the OS", async () => {
    const { controller, sink } = await harness();
    expect(controller.key({ key: "v", code: "KeyV", meta: true })).toBe(false);
    expect(controller.key({ key: "ArrowLeft", code: "ArrowLeft", meta: true })).toBe(false);
    expect(sink.writes).toEqual([]);
  });

  test("key encoding follows the terminal's own modes (DECCKM through the live core)", async () => {
    const { controller, core, sink } = await harness();
    controller.key({ key: "ArrowUp", code: "ArrowUp" });
    core.write(enc("\x1b[?1h")); // the app enters application cursor mode
    controller.key({ key: "ArrowUp", code: "ArrowUp" });
    expect(sink.writes).toEqual([Array.from(enc("\x1b[A")), Array.from(enc("\x1bOA"))]);
  });

  test("paste sends single-line text; an empty paste sends nothing", async () => {
    const { controller, sink } = await harness();
    expect(controller.paste("ls")).toBe(true);
    expect(controller.paste("")).toBe(true);
    expect(sink.writes).toEqual([Array.from(enc("ls"))]);
  });

  test("an unbracketed multi-line paste demands confirmation and writes nothing", async () => {
    const { controller, sink } = await harness();
    expect(controller.paste("rm -rf /\necho gotcha")).toBe(false);
    expect(sink.writes).toEqual([]);
  });

  test("a single command with a trailing newline is routine, not a confirmation", async () => {
    // Nearly every command copied from a web page or another terminal carries the trailing \n.
    const { controller, sink } = await harness();
    expect(controller.paste("ls -la\n")).toBe(true);
    expect(sink.writes).toEqual([Array.from(enc("ls -la\r"))]);
  });

  test("a confirmed multi-line paste writes with newlines as carriage returns", async () => {
    const { controller, sink } = await harness();
    expect(controller.paste("echo a\necho b", { force: true })).toBe(true);
    expect(sink.writes).toEqual([Array.from(enc("echo a\recho b"))]);
  });

  test("with bracketed paste on, multi-line pastes flow wrapped and unconfirmed", async () => {
    const { controller, core, sink } = await harness();
    core.write(enc("\x1b[?2004h")); // the app (vim, claude-code) opts in
    expect(controller.paste("echo a\necho b")).toBe(true);
    expect(sink.writes).toEqual([Array.from(enc("\x1b[200~echo a\necho b\x1b[201~"))]);
  });

  test("resize reflows the core, resizes the renderer, and notifies the pty", async () => {
    const { controller, core, renderer, sink } = await harness(80, 24);
    controller.resize(120, 40);
    expect(core.size).toEqual({ cols: 120, rows: 40 });
    expect(renderer.resizes).toEqual([[80, 24], [120, 40]]);
    expect(sink.resizes).toEqual([[120, 40]]);
    expect(controller.size).toEqual({ cols: 120, rows: 40 });
  });

  test("after a resize the grid re-aligns to the reflowed terminal", async () => {
    const { controller, core, renderer } = await harness(10, 4);
    controller.feed(enc("hello world it wraps here"));
    controller.frame();
    controller.resize(30, 4); // widen → VtCore reflows
    controller.frame();
    const truth = core.fullSnapshot();
    for (const row of truth.rows) {
      for (let x = 0; x < 30; x++) {
        expect(renderer.grid.cell(x, row.y).text).toBe(row.cells[x]?.text ?? " ");
      }
    }
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
