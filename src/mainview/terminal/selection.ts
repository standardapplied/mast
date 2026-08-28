/**
 * A linear terminal text selection: every cell from the anchor to the focus in reading (row-major)
 * order, exactly like a normal terminal drag-select — the first and last rows are partial, every row
 * between is full. Pure and grid-agnostic so the range logic and copied-text extraction are testable
 * without a renderer or the pty; the pane owns the mouse plumbing and the renderer owns the highlight.
 */

export interface CellPos {
  readonly x: number;
  readonly y: number;
}

export class Selection {
  private readonly startIdx: number;
  private readonly endIdx: number;

  constructor(
    anchor: CellPos,
    focus: CellPos,
    readonly cols: number,
  ) {
    const a = anchor.y * cols + Math.min(anchor.x, cols - 1);
    const f = focus.y * cols + Math.min(focus.x, cols - 1);
    this.startIdx = Math.min(a, f);
    this.endIdx = Math.max(a, f);
  }

  /** Whether the cell at {@code (x, y)} falls within the selection. */
  contains(x: number, y: number): boolean {
    const i = y * this.cols + x;
    return i >= this.startIdx && i <= this.endIdx;
  }

  /** A single-cell selection (a click with no drag) selects nothing worth copying. */
  get isEmpty(): boolean {
    return this.startIdx === this.endIdx;
  }
}

/**
 * The selected text from {@code rows} (each row an array of per-cell strings). Trailing whitespace is
 * trimmed per line and rows are joined with newlines — the shape a terminal puts on the clipboard.
 */
export function selectedText(selection: Selection, rows: readonly (readonly string[])[]): string {
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    let line = "";
    let any = false;
    for (let x = 0; x < selection.cols; x++) {
      if (selection.contains(x, y)) {
        line += row[x] === "" || row[x] === undefined ? " " : row[x];
        any = true;
      }
    }
    if (any) lines.push(line.replace(/\s+$/, ""));
  }
  return lines.join("\n");
}
