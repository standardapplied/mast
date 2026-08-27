import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TerminalGrid } from "./terminalGrid";
import { VtCore } from "./vtCore";

const WASM = readFileSync(join(import.meta.dir, "ghostty-vt.wasm"));
const enc = (s: string) => new TextEncoder().encode(s);

let cores: VtCore[] = [];
afterEach(() => {
  cores.forEach((c) => c.free());
  cores = [];
});
async function core(cols: number, rows: number) {
  const c = await VtCore.create(WASM, cols, rows);
  cores.push(c);
  return c;
}

/** Applies only the dirty rows (the performance path), then asserts the grid equals the true viewport. */
function feedAndCheck(c: VtCore, grid: TerminalGrid, bytes: string) {
  c.write(enc(bytes));
  grid.apply(c.snapshot()); // damage-based: dirty rows only
  const truth = c.fullSnapshot(); // whole viewport, while still dirty
  c.clean();
  for (const row of truth.rows) {
    for (let x = 0; x < grid.cols; x++) {
      const g = grid.cell(x, row.y);
      const t = row.cells[x];
      expect({ text: g.text, fg: g.fg, bg: g.bg }).toEqual({ text: t.text, fg: t.fg, bg: t.bg });
    }
  }
}

describe("TerminalGrid damage-based apply stays aligned with the terminal", () => {
  test("a full interactive session: prompt, typing, output, scroll, clear", async () => {
    const c = await core(16, 4);
    const grid = new TerminalGrid();
    grid.resize(16, 4);
    for (const step of [
      "$ ", // prompt
      "ls", // typed echo
      "\r\n", // enter
      "a.txt b.txt\r\n", // output
      "$ ", // next prompt
      "\x1b[31mred\x1b[0m\r\n", // colored output
      "$ echo hi\r\nhi\r\n$ ", // scrolls the 4-row viewport
      "\x1b[2J\x1b[H", // clear
      "$ done", // fresh content after clear
    ]) {
      feedAndCheck(c, grid, step);
    }
  });

  test("in-place line edits and carriage returns stay aligned", async () => {
    const c = await core(16, 3);
    const grid = new TerminalGrid();
    grid.resize(16, 3);
    // Overwrite a line via \r (readline redraw) and truncate via ESC[K.
    feedAndCheck(c, grid, "hello world");
    feedAndCheck(c, grid, "\rbye"); // carriage return, overwrite start
    feedAndCheck(c, grid, "\x1b[K"); // clear to end of line
  });

  test("wide characters (CJK, emoji) stay aligned in the grid", async () => {
    const c = await core(12, 2);
    const grid = new TerminalGrid();
    grid.resize(12, 2);
    feedAndCheck(c, grid, "a世b😀c"); // mixes narrow, wide CJK, and an emoji
  });

  test("colors resolve into the grid cells", async () => {
    const c = await core(10, 2);
    const grid = new TerminalGrid();
    grid.resize(10, 2);
    feedAndCheck(c, grid, "\x1b[38;2;10;200;30mX\x1b[0m");
    expect(grid.cell(0, 0).fg).toEqual([10, 200, 30]);
  });
});
