/**
 * Terminal hot-path timings, so a performance claim in a PR is a number, not an adjective:
 *
 *   bun run terminal:bench [cols] [rows]
 *
 * Measures, on a cols×rows terminal: a full-screen TUI redraw (every row rewritten) fed to the
 * real VtCore and read back through the dirty-row snapshot; one echoed keystroke read the same
 * way; and packing the resulting grid into GPU instance buffers with a stub atlas. Each figure is
 * the median of many iterations, in milliseconds.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rasterStubFactory } from "../test/rasterStub";
import { BG_STRIDE, FG_PER_CELL, FG_STRIDE, packFrame } from "../src/mainview/terminal/framePacker";
import { GlyphAtlas } from "../src/mainview/terminal/glyphAtlas";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_PX } from "../src/mainview/terminal/metrics";
import { TerminalGrid } from "../src/mainview/terminal/terminalGrid";
import type { Cursor } from "../src/mainview/terminal/vtCore";
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
const pack = time(100, () => packFrame(grid, cursor, null, atlas, colors, out));

const fmt = (ms: number) => `${ms.toFixed(3)} ms`;
console.log(`${cols}×${rows} terminal, medians:`);
console.log(`  full TUI redraw: write + dirty-row snapshot + grid apply  ${fmt(redraw)}`);
console.log(`  one echoed keystroke: write + dirty-row snapshot + apply  ${fmt(echo)}`);
console.log(`  packFrame (whole grid → instance buffers)                 ${fmt(pack)}`);
core.free();
