/**
 * Terminal hot-path timings, so a performance claim in a PR is a number, not an adjective:
 *
 *   bun run terminal:bench [cols] [rows]
 *
 * Measures, on a cols×rows terminal: a full-screen TUI redraw (every row rewritten) fed to the
 * real VtCore and read back through the dirty-row snapshot; one echoed keystroke read the same
 * way; packing the resulting grid into GPU instance buffers with a stub atlas; and a firehose of
 * line output fed the two ways the data lane can deliver it — one message per read, and one
 * coalesced message per window (what the Rust pump sends). Then two scenes that are about what a
 * pane costs rather than how fast it is: ten idle panes ticking their frame loops, and a CJK
 * document — thousands of distinct wide glyphs — rasterized into the shared atlas, with the bytes
 * a backend uploads per frame and what a second pane on the same atlas pays. Each figure is the
 * median of many iterations, in milliseconds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rasterStubFactory } from "../test/rasterStub";
import { BG_STRIDE, FG_PER_CELL, FG_STRIDE, packFrame } from "../src/mainview/terminal/framePacker";
import { GlyphAtlas } from "../src/mainview/terminal/glyphAtlas";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_PX } from "../src/mainview/terminal/metrics";
import {
  type PtySink,
  type Renderer,
  TerminalController,
} from "../src/mainview/terminal/terminalController";
import { TerminalGrid } from "../src/mainview/terminal/terminalGrid";
import type { Cursor, GridSnapshot } from "../src/mainview/terminal/vtCore";
import { VtCore } from "../src/mainview/terminal/vtCore";

const cols = Number(process.argv[2] ?? 200);
const rows = Number(process.argv[3] ?? 60);
const wasm = readFileSync(join(import.meta.dir, "../src/mainview/terminal/ghostty-vt.wasm"));
const enc = new TextEncoder();

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function time(iterations: number, body: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    body();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

/** A frame the way a TUI paints one: home, then every row rewritten with mixed styles. */
function tuiFrame(seed: number): Uint8Array {
  let s = "\x1b[H";
  for (let y = 0; y < rows; y++) {
    const line = `\x1b[38;5;${(y + seed) % 256}m│ row ${y} ${"x".repeat(Math.max(0, cols - 12))}`;
    s += `${line.slice(0, cols)}\x1b[0m\x1b[K${y < rows - 1 ? "\r\n" : ""}`;
  }
  return enc.encode(s);
}

const core = await VtCore.create(wasm, cols, rows);
const grid = new TerminalGrid();
grid.resize(cols, rows);
grid.apply(core.snapshot());
core.clean();

let seed = 0;
const redraw = time(40, () => {
  core.write(tuiFrame(seed++));
  grid.apply(core.snapshot());
  core.clean();
});

core.write(enc.encode("\x1b[H$ "));
grid.apply(core.snapshot());
core.clean();
const echo = time(200, () => {
  core.write(enc.encode("x"));
  grid.apply(core.snapshot());
  core.clean();
});

const atlas = new GlyphAtlas(
  rasterStubFactory({ advance: 18, ascent: 30.6, descent: 9, capHeight: 21.9, exHeight: 16.5 }),
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_PX,
  2,
);
const out = {
  bg: new Float32Array(cols * rows * BG_STRIDE),
  fg: new Float32Array((cols * rows * FG_PER_CELL + 1) * FG_STRIDE),
};
const cursor: Cursor = { present: true, x: 3, y: 0, visible: true, style: "block", blinking: true };
const colors = {
  bg: [11, 14, 20] as const,
  cursor: [252, 73, 38] as const,
  selectionBg: [60, 80, 120] as const,
  selectionFg: [255, 255, 255] as const,
};
const pack = time(100, () => packFrame(grid, cursor, atlas, colors, out));

/** Line output the way `yes`, a build, or a log tail produces it, cut to exactly {@code bytes}. */
function firehose(bytes: number): Uint8Array {
  let s = "";
  for (let i = 0; s.length < bytes; i++) {
    s += `${String(i).padStart(8, "0")} ${"line of build output ".repeat(3)}\r\n`;
  }
  return enc.encode(s.slice(0, bytes));
}
const FIREHOSE_MIB = 4;
const flood = firehose(FIREHOSE_MIB << 20);
const fed = (message: number) => {
  for (let off = 0; off < flood.length; off += message) {
    core.write(flood.subarray(off, off + message));
  }
  grid.apply(core.snapshot());
  core.clean();
};
const perRead = time(5, () => fed(1024)) / FIREHOSE_MIB;
const coalesced = time(5, () => fed(256 * 1024)) / FIREHOSE_MIB;

/** A pane's renderer with the pixels left out: the grid model the real one keeps, and nothing drawn. */
class GridRenderer implements Renderer {
  readonly grid = new TerminalGrid();
  draws = 0;
  resize(cols: number, rows: number): void {
    this.grid.resize(cols, rows);
  }
  apply(snapshot: GridSnapshot): void {
    this.grid.apply(snapshot);
  }
  setCursor(): void {}
  setHover(): void {}
  setColors(): void {}
  draw(): void {
    this.draws++;
  }
}
const nullSink: PtySink = { write: () => {}, resize: () => {} };

const panes = await Promise.all(
  Array.from({ length: 10 }, async () => {
    const paneCore = await VtCore.create(wasm, cols, rows);
    const controller = new TerminalController(paneCore, new GridRenderer(), nullSink);
    controller.feed(tuiFrame(0));
    controller.frame(true, true);
    return { core: paneCore, controller };
  }),
);
const idle = time(200, () => {
  for (const pane of panes) pane.controller.frame(true, true);
});
for (const pane of panes) pane.core.free();

/** A line of distinct wide ideographs from {@code from}, as `cat` of a novel paints one. */
function cjkLine(from: number): string {
  let line = "";
  for (let x = 0; x + 1 < cols; x += 2) line += String.fromCodePoint(from++);
  return line;
}
function cjkPage(from: number): Uint8Array {
  let s = "\x1b[H";
  for (let y = 0; y < rows; y++) {
    s += `${cjkLine(from + y * cols)}\x1b[K${y < rows - 1 ? "\r\n" : ""}`;
  }
  return enc.encode(s);
}
const raster = rasterStubFactory({ advance: 18, ascent: 30.6, descent: 9, capHeight: 21.9, exHeight: 16.5 });
const shared = new GlyphAtlas(raster, TERMINAL_FONT_FAMILY, TERMINAL_FONT_PX, 2);
const slotBytes = shared.metrics.cellW * shared.metrics.cellH * 4;
const patchBytes = (since: number) => shared.patchesSince(since).reduce((n, p) => n + p.pixels.length, 0);
const cjk = await VtCore.create(wasm, cols, rows);
const cjkGrid = new TerminalGrid();
cjkGrid.resize(cols, rows);
cjk.write(cjkPage(0x4e00));
cjkGrid.apply(cjk.readAll());
cjk.clean();
shared.nextFrame();
const cjkFirst = time(1, () => packFrame(cjkGrid, cursor, shared, colors, out));
const cjkGlyphs = shared.size;
const cjkFirstUpload = patchBytes(0);
let mark = shared.writes;
shared.nextFrame();
const cjkSteady = time(20, () => packFrame(cjkGrid, cursor, shared, colors, out));
const cjkSteadyUpload = patchBytes(mark);
mark = shared.writes;
cjk.write(enc.encode(`\x1b[${rows};1H\r\n${cjkLine(0x9000)}`));
cjkGrid.apply(cjk.readAll());
cjk.clean();
shared.nextFrame();
const cjkNewLine = time(1, () => packFrame(cjkGrid, cursor, shared, colors, out));
const cjkLineUpload = patchBytes(mark);
const secondGrid = new TerminalGrid();
secondGrid.resize(cols, rows);
secondGrid.apply(cjk.readAll());
mark = shared.writes;
shared.nextFrame();
const cjkSecondPane = time(20, () => packFrame(secondGrid, cursor, shared, colors, out));
const cjkSecondUpload = patchBytes(mark);
cjk.free();

const fmt = (ms: number) => `${ms.toFixed(3)} ms`;
const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
console.log(`${cols}×${rows} terminal, medians:`);
console.log(`  full TUI redraw: write + dirty-row snapshot + grid apply  ${fmt(redraw)}`);
console.log(`  one echoed keystroke: write + dirty-row snapshot + apply  ${fmt(echo)}`);
console.log(`  packFrame (whole grid → instance buffers)                 ${fmt(pack)}`);
console.log(`  firehose, per MiB fed as 1 KiB messages (one per read)    ${fmt(perRead)}`);
console.log(`  firehose, per MiB fed as 256 KiB messages (coalesced)     ${fmt(coalesced)}`);
console.log(`10 panes idle: one frame-loop tick across all ten           ${fmt(idle)}`);
console.log(`CJK document (${cjkGlyphs} distinct wide glyphs on screen), shared atlas ${shared.atlasCols}×${shared.atlasRows}:`);
console.log(`  first frame: rasterize + pack                              ${fmt(cjkFirst)}`);
console.log(`  first frame: texture upload                                ${mib(cjkFirstUpload)} (whole bitmap: ${mib(shared.width * shared.height * 4)})`);
console.log(`  steady frame: pack / upload                                ${fmt(cjkSteady)} / ${cjkSteadyUpload} B`);
console.log(`  one new line of glyphs: pack / upload                      ${fmt(cjkNewLine)} / ${mib(cjkLineUpload)} (${cjkLineUpload / slotBytes} slots)`);
console.log(`  second pane, same document, same atlas: pack / upload      ${fmt(cjkSecondPane)} / ${cjkSecondUpload} B`);
core.free();
