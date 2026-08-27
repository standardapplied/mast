/**
 * TerminalGrid — the renderer's persistent cell model, pure and testable.
 *
 * It holds one {@link GridCell} per screen position and folds in snapshots from {@link VtCore}. The
 * renderer draws from it; nothing here touches the GPU or the glyph atlas, so damage-based updates
 * (apply only the rows VtCore reports dirty) can be proven correct against the terminal's true
 * viewport without a browser. That correctness is what lets the renderer skip a full re-read every
 * frame — the performance path — without drifting from the terminal.
 */

import type { GridSnapshot, Rgb } from "./vtCore";

/** One cell's rendered content: its grapheme and resolved colors. */
export interface GridCell {
  text: string;
  fg: Rgb;
  bg: Rgb;
}

const BLANK_FG: Rgb = [200, 208, 220];
const BLANK_BG: Rgb = [11, 14, 20];

export class TerminalGrid {
  private colsN = 0;
  private rowsN = 0;
  private cells: GridCell[] = [];

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
    this.cells = Array.from({ length: cols * rows }, () => ({
      text: " ",
      fg: BLANK_FG,
      bg: BLANK_BG,
    }));
  }

  /** Folds a snapshot's rows into the grid in place; rows outside the grid are ignored. */
  apply(snapshot: GridSnapshot): void {
    for (const row of snapshot.rows) {
      if (row.y < 0 || row.y >= this.rowsN) continue;
      const base = row.y * this.colsN;
      for (let x = 0; x < this.colsN; x++) {
        const cell = this.cells[base + x];
        const source = row.cells[x];
        if (source) {
          cell.text = source.text;
          cell.fg = source.fg;
          cell.bg = source.bg;
        } else {
          cell.text = " ";
          cell.fg = BLANK_FG;
          cell.bg = BLANK_BG;
        }
      }
    }
  }

  /** The cell at {@code (x, y)}; out-of-range positions read blank. */
  cell(x: number, y: number): GridCell {
    if (x < 0 || x >= this.colsN || y < 0 || y >= this.rowsN) {
      return { text: " ", fg: BLANK_FG, bg: BLANK_BG };
    }
    return this.cells[y * this.colsN + x];
  }
}
