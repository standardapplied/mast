/**
 * Replays raw pty bytes (a sail ring-journal dump, a `script` capture, anything) through the real
 * VtCore and the glyph atlas, then prints the styled viewport and what the atlas rasterized. The
 * path from a field report to a failing test is one command:
 *
 *   bun run terminal:replay <bytes-file> [cols] [rows]
 *
 * Output: one line per viewport row (`|` framed), then a style legend of every non-plain cell, then
 * the atlas log — each entry as sprite or font glyph — and a loud line if any draw escaped its slot,
 * which the atlas clip makes impossible by construction; the check is here so a regression in that
 * guarantee would show up in a replay before it shows up on a screen.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { opInside, type Rect, rasterStubFactory } from "../test/rasterStub";
import { GlyphAtlas } from "../src/mainview/terminal/glyphAtlas";
import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_PX } from "../src/mainview/terminal/metrics";
import { spriteCodepoint } from "../src/mainview/terminal/sprites";
import { type Cell, VtCore } from "../src/mainview/terminal/vtCore";

const [file, colsArg, rowsArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: bun run terminal:replay <bytes-file> [cols] [rows]");
  process.exit(2);
}
const cols = Number(colsArg ?? 120);
const rows = Number(rowsArg ?? 40);

const wasm = readFileSync(join(import.meta.dir, "../src/mainview/terminal/ghostty-vt.wasm"));
const core = await VtCore.create(wasm, cols, rows);
core.write(new Uint8Array(readFileSync(file)));
const snapshot = core.readAll();
const cursor = core.cursor();

const raster = rasterStubFactory({
  advance: 18,
  ascent: 30.6,
  descent: 9,
  capHeight: 21.9,
  exHeight: 16.5,
});
const atlas = new GlyphAtlas(raster, TERMINAL_FONT_FAMILY, TERMINAL_FONT_PX, 2);
const slots = new Map<number, Rect>();
const texts = new Map<number, string>();
const styled: string[] = [];

const styleOf = (c: Cell) =>
  [
    c.bold && "bold",
    c.italic && "italic",
    c.underline && "underline",
    c.strikethrough && "strike",
    c.faint && "faint",
  ]
    .filter(Boolean)
    .join("+");

for (const row of snapshot.rows) {
  let line = "";
  for (const [x, cell] of row.cells.entries()) {
    line += cell.text || " ";
    const wide = cell.width === 2;
    const id = atlas.glyph(cell.text, cell, wide);
    if (id !== 0 && !slots.has(id)) {
      texts.set(id, cell.text);
      const { u, v } = atlas.cell(id);
      slots.set(id, {
        x: u * atlas.metrics.cellW,
        y: v * atlas.metrics.cellH,
        w: (wide ? 2 : 1) * atlas.metrics.cellW,
        h: atlas.metrics.cellH,
      });
    }
    const style = styleOf(cell);
    if (style) {
      styled.push(`  (${x},${row.y}) ${JSON.stringify(cell.text)} ${style} fg=${cell.fg} bg=${cell.bg}`);
    }
  }
  console.log(`|${line.trimEnd()}`);
}
const where = cursor.present ? `(${cursor.x},${cursor.y})${cursor.visible ? "" : " hidden"}` : "off-screen";
console.log(`cursor: ${where}`);
if (styled.length) console.log(`\nstyled cells:\n${styled.join("\n")}`);

const bitmap = raster.surfaces[1]!;
const entries = slots.size;
const sprites = [...texts.values()].filter((text) => spriteCodepoint(text) !== null).length;
console.log(
  `\natlas: ${entries} entries (${sprites} sprites, ${entries - sprites} font glyphs), ${bitmap.ops.length} draw ops`,
);
const escaped = bitmap.ops.filter((op) => ![...slots.values()].some((slot) => opInside(op, slot)));
console.log(
  escaped.length === 0 ? "every draw stayed inside its slot" : `!! ${escaped.length} DRAWS ESCAPED THEIR SLOT`,
);
core.free();
process.exit(escaped.length === 0 ? 0 : 1);
