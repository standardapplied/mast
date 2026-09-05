/**
 * TerminalGrid — the renderer's persistent cell model, pure and testable.
 *
 * It holds one {@link Cell} per screen position and folds in snapshots from {@link VtCore}. The
 * renderer draws from it; nothing here touches the GPU or the glyph atlas, so damage-based updates
 * (apply only the rows VtCore reports dirty) can be proven correct against the terminal's true
 * viewport without a browser.
 */

import type { Cell, GridSnapshot, Rgb } from "./vtCore";

const BLANK_FG: Rgb = [200, 208, 220];
const BLANK_BG: Rgb = [11, 14, 20];

export class TerminalGrid {
  private colsN = 0;
  private rowsN = 0;
  private cells: Cell[] = [];
  private readonly blank: Cell;

  /** Blank cells (and out-of-range reads) paint in these theme colors; defaults to the dark theme. */
  constructor(blank: { fg: Rgb; bg: Rgb } = { fg: BLANK_FG, bg: BLANK_BG }) {
    this.blank = {
      text: " ",
      fg: blank.fg,
      bg: blank.bg,
      bold: false,
      italic: false,
      underline: "none",
      underlineColor: null,
      strikethrough: false,
      overline: false,
      faint: false,
      invisible: false,
      selected: false,
      width: 1,
    };
  }

  get cols(): number {
    return this.colsN;
  }
  get rows(): number {
    return this.rowsN;
  }

  /** Resizes to {@code cols}×{@code rows}, resetting every cell to blank. */
  resize(cols: number, rows: number): void {
    this.colsN = cols;
    this.rowsN = rows;
    this.cells = new Array<Cell>(cols * rows).fill(this.blank);
  }

  /** Folds a snapshot's rows into the grid; rows outside the grid are ignored. */
  apply(snapshot: GridSnapshot): void {
    for (const row of snapshot.rows) {
      if (row.y < 0 || row.y >= this.rowsN) continue;
      const base = row.y * this.colsN;
      for (let x = 0; x < this.colsN; x++) {
        this.cells[base + x] = row.cells[x] ?? this.blank;
      }
    }
  }

  /** The cell at {@code (x, y)}; out-of-range positions read blank. */
  cell(x: number, y: number): Cell {
    if (x < 0 || x >= this.colsN || y < 0 || y >= this.rowsN) {
      return this.blank;
    }
    return this.cells[y * this.colsN + x]!;
  }
}
