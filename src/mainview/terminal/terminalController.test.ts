import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gridFor,
  KEY_ECHO_TIMEOUT_MS,
  type PtySink,
  type Renderer,
  type RendererColors,
  RESIZE_SETTLE_MS,
  SYNCHRONIZED_OUTPUT_CAP_MS,
  TerminalController,
} from "./terminalController";
import { FakeTimers } from "../../../test/terminalFakes";
import { MODS } from "./input";
import type { LatencyStats } from "./latency";
import { TerminalGrid } from "./terminalGrid";
import type { Cursor, GridSnapshot, LinkRun, MatchSpan, Scrollbar, SearchState } from "./vtCore";
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
  hovers: (LinkRun | null)[] = [];
  setHover(run: LinkRun | null): void {
    this.hovers.push(run);
  }
  matches: readonly MatchSpan[] = [];
  setSearchMatches(spans: readonly MatchSpan[]): void {
    this.matches = spans;
  }
  colors: RendererColors[] = [];
  setColors(colors: RendererColors): void {
    this.colors.push(colors);
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

function gridRow(grid: TerminalGrid, y: number): string {
  let s = "";
  for (let x = 0; x < grid.cols; x++) s += grid.cell(x, y).text;
  return s.trimEnd();
}

let cores: VtCore[] = [];
async function harness(cols = 80, rows = 24, now?: () => number) {
  const core = await VtCore.create(WASM, cols, rows);
  cores.push(core);
  const renderer = new RecRenderer();
  const sink = new RecSink();
  const timers = new FakeTimers();
  const controller = new TerminalController(core, renderer, sink, { now, timers });
  return { core, renderer, sink, controller, timers };
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

  test("an echoed keystroke on the active line reaches the rendered grid via its dirty row", async () => {
    const { controller, renderer } = await harness(80, 40);
    controller.feed(enc("$ "));
    controller.frame();
    controller.feed(enc("x")); // one echoed keystroke edits the cursor row in place
    controller.frame();
    expect(gridRow(renderer.grid, 0)).toBe("$ x");
    // libghostty-vt flags the in-place edit as partial damage on exactly that row.
    const last = renderer.applied.at(-1)!;
    expect(last.dirty).toBe("partial");
    expect(last.rows.map((r) => r.y)).toEqual([0]);
  });

  test("a press-drag-release selects cells the core owns; copy reads them; typing clears", async () => {
    const { controller, core, renderer } = await harness(20, 3);
    controller.feed(enc("hello world"));
    controller.frame();
    // 10×20 px cells; a press in a cell's left half anchors before it, a drag past a cell's
    // midpoint includes it, as in Ghostty.
    core.setCellPixels(10, 20);
    const px = (x: number, y: number) => ({ x: (x + 0.8) * 10, y: (y + 0.5) * 20 });
    controller.selectPress({ x: 0, y: 0 }, { x: 2, y: 10 }, 1000);
    controller.selectDrag({ x: 4, y: 0 }, px(4, 0));
    controller.selectRelease({ x: 4, y: 0 });
    controller.frame();
    expect(controller.selectedText()).toBe("hello");
    expect([0, 1, 2, 3, 4, 5].map((x) => renderer.grid.cell(x, 0).selected)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    controller.clearSelection();
    controller.frame();
    expect(core.hasSelection()).toBe(false);
    expect(controller.selectedText()).toBe("");
    expect(renderer.grid.cell(0, 0).selected).toBe(false);
  });

  test("hovering a link underlines its run, follows the screen, and survives a renderer rebuild", async () => {
    const { controller, renderer } = await harness(40, 4);
    const seen: (LinkRun | null)[] = [];
    controller.hooks.onHover = (run) => seen.push(run);
    controller.feed(enc("go \x1b]8;;https://a.b/c\x1b\\here\x1b]8;;\x1b\\ now"));
    controller.frame();
    const draws = renderer.draws;
    const run = { uri: "https://a.b/c", spans: [{ y: 0, start: 3, end: 7 }] };
    expect(controller.hover({ x: 4, y: 0 })).toEqual(run);
    controller.frame();
    expect(renderer.hovers.at(-1)).toEqual(run);
    expect(renderer.draws, "a hover alone repaints").toBe(draws + 1);
    expect(controller.hover({ x: 5, y: 0 }), "the same run is not re-set").toEqual(run);
    expect(renderer.hovers).toHaveLength(1);
    expect(controller.hover({ x: 0, y: 0 })).toBeNull();
    expect(renderer.hovers.at(-1)).toBeNull();
    expect(seen, "the pane's own hover calls are not echoed back").toEqual([]);

    controller.hover({ x: 4, y: 0 });
    controller.feed(enc("\r\n".repeat(4)));
    controller.frame();
    expect(seen, "output that scrolled the link away re-resolved the resting pointer").toEqual([null]);
    expect(renderer.hovers.at(-1)).toBeNull();

    controller.hover({ x: 4, y: 0 });
    controller.feed(enc("\x1b[1;1H\x1b]8;;https://x.y\x1b\\zzzzzzzz\x1b]8;;\x1b\\"));
    controller.frame();
    expect(seen.at(-1)).toEqual({ uri: "https://x.y", spans: [{ y: 0, start: 0, end: 8 }] });

    const fresh = new RecRenderer();
    controller.replaceRenderer(fresh);
    expect(fresh.hovers).toEqual([{ uri: "https://x.y", spans: [{ y: 0, start: 0, end: 8 }] }]);
    expect(controller.linkAt({ x: 7, y: 0 })?.uri).toBe("https://x.y");
    controller.hover(null);
    expect(fresh.hovers.at(-1)).toBeNull();
  });

  test("a selection change alone is enough to repaint", async () => {
    const { controller, core, renderer } = await harness(20, 3);
    controller.feed(enc("abc"));
    controller.frame();
    const draws = renderer.draws;
    core.setCellPixels(10, 20);
    controller.selectPress({ x: 0, y: 0 }, { x: 2, y: 10 }, 1000);
    controller.selectDrag({ x: 2, y: 0 }, { x: 28, y: 10 });
    controller.frame();
    expect(renderer.draws).toBe(draws + 1);
  });

  test("an idle frame never touches the core; a blink phase redraws from the cursor it cached", async () => {
    const { controller, core, renderer } = await harness();
    controller.feed(enc("$ "));
    controller.frame(true, true);
    const snapshot = spyOn(core, "snapshot");
    const cursor = spyOn(core, "cursor");
    const draws = renderer.draws;
    controller.frame(true, true);
    controller.frame(true, true);
    expect(renderer.draws).toBe(draws);
    controller.frame(false, true);
    expect(renderer.draws, "the blink's off phase is a redraw").toBe(draws + 1);
    expect(renderer.cursors.at(-1)?.visible).toBe(false);
    controller.frame(false, false);
    expect(renderer.cursors.at(-1)?.style, "an unfocused pane shows the hollow cursor").toBe("hollow");
    expect(snapshot).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalled();
    controller.feed(enc("x"));
    controller.frame(true, true);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(cursor).toHaveBeenCalledTimes(1);
    expect(renderer.cursors.at(-1)?.x).toBe(3);
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

  test("output that lands below a scrolled-up viewport is flagged until the user comes back", async () => {
    const { controller } = await harness(20, 3);
    for (let i = 0; i < 6; i++) controller.feed(enc(`row${i}\r\n`));
    expect(controller.hasUnseenOutput()).toBe(false); // at the bottom: nothing is unseen
    controller.scroll({ delta: -2 });
    expect(controller.hasUnseenOutput()).toBe(false); // scrolling up alone is not new output
    controller.feed(enc("late\r\n"));
    expect(controller.hasUnseenOutput()).toBe(true);
    controller.scroll({ delta: 1 }); // still in history
    expect(controller.hasUnseenOutput()).toBe(true);
    controller.scroll("bottom");
    expect(controller.hasUnseenOutput()).toBe(false);
    controller.feed(enc("live\r\n")); // output while live never flags
    expect(controller.hasUnseenOutput()).toBe(false);
  });

  test("the scrollbar reports where the viewport sits in history, once per change", async () => {
    const { controller } = await harness();
    const bars: Scrollbar[] = [];
    controller.hooks.onScrollbar = (bar) => bars.push(bar);
    controller.frame();
    expect(bars, "a fresh terminal has nothing to scroll: total == len").toEqual([{ total: 24, offset: 0, len: 24 }]);
    controller.frame();
    expect(bars, "an idle frame reports nothing").toHaveLength(1);
    let out = "";
    for (let i = 0; i < 1000; i++) out += `line ${i}\r\n`;
    controller.feed(enc(out));
    controller.frame();
    expect(bars.at(-1), "at the bottom: offset + len == total").toEqual({ total: 1001, offset: 977, len: 24 });
    controller.scroll("top");
    controller.frame();
    expect(bars.at(-1)).toEqual({ total: 1001, offset: 0, len: 24 });
    controller.scroll({ row: 300 });
    controller.frame();
    expect(bars.at(-1), "a drag to row N lands offset == N").toEqual({ total: 1001, offset: 300, len: 24 });
    controller.scroll({ row: 5000 });
    controller.frame();
    expect(bars.at(-1), "past the end clamps to the bottom").toEqual({ total: 1001, offset: 977, len: 24 });
    expect(() => controller.scroll({ row: -1 })).toThrow(/whole number of rows/);
    controller.feed(enc("\x1b[?1049h"));
    controller.frame();
    expect(bars.at(-1), "the alternate screen has no history: total == len hides the bar").toEqual({
      total: 24,
      offset: 0,
      len: 24,
    });
    controller.feed(enc("\x1b[?1049l"));
    controller.frame();
    expect(bars.at(-1)).toEqual({ total: 1001, offset: 977, len: 24 });
  });

  test("a keystroke snaps back to the live view, which clears the flag", async () => {
    const { controller } = await harness(20, 3);
    for (let i = 0; i < 6; i++) controller.feed(enc(`row${i}\r\n`));
    controller.scroll({ delta: -3 });
    controller.feed(enc("late\r\n"));
    expect(controller.hasUnseenOutput()).toBe(true);
    controller.scroll("bottom"); // the pane does this on every keystroke
    expect(controller.hasUnseenOutput()).toBe(false);
  });

  test("empty output is a no-op", async () => {
    const { controller, core } = await harness();
    controller.feed(new Uint8Array(0));
    // A fresh terminal is fully dirty once; assert nothing beyond that was written.
    expect(core.snapshot().rows.every((r) => rowText(core.snapshot(), r.y) === "")).toBe(true);
  });

  test("an idle frame applies nothing and draws nothing", async () => {
    const { controller, renderer } = await harness();
    controller.feed(enc("x"));
    controller.frame();
    const applied = renderer.applied.length;
    controller.frame();
    controller.frame();
    expect(renderer.applied.length).toBe(applied);
    expect(renderer.draws).toBe(1);
  });

  test("a write that changes no cell (a mode switch) draws nothing", async () => {
    const { controller, renderer } = await harness();
    controller.frame();
    controller.feed(enc("\x1b[?2004h"));
    controller.frame();
    expect(renderer.draws).toBe(1);
  });

  test("a cursor move without output still draws", async () => {
    const { controller, renderer } = await harness();
    controller.frame();
    controller.feed(enc("\x1b[5;5H"));
    controller.frame();
    expect(renderer.draws).toBe(2);
    expect(renderer.cursors.at(-1)).toMatchObject({ x: 4, y: 4 });
  });

  test("a blink phase flip draws once per flip, not per frame", async () => {
    const { controller, renderer } = await harness();
    controller.frame(true);
    controller.frame(true);
    controller.frame(false);
    controller.frame(false);
    controller.frame(true);
    expect(renderer.draws).toBe(3);
  });

  test("synchronized output holds frames until the app ends the update", async () => {
    let now = 0;
    const { controller, renderer } = await harness(20, 3, () => now);
    controller.feed(enc("\x1b[?2026hfirst"));
    controller.frame();
    expect(renderer.draws).toBe(0);
    expect(gridRow(renderer.grid, 0)).toBe("");
    controller.feed(enc("\r\nsecond\x1b[?2026l"));
    controller.frame();
    expect(renderer.draws).toBe(1);
    expect([gridRow(renderer.grid, 0), gridRow(renderer.grid, 1)]).toEqual(["first", "second"]);
  });

  test("a synchronized update that never ends is released after the cap", async () => {
    let now = 0;
    const { controller, renderer } = await harness(20, 3, () => now);
    controller.feed(enc("\x1b[?2026hstuck"));
    controller.frame();
    now = SYNCHRONIZED_OUTPUT_CAP_MS - 1;
    controller.frame();
    expect(renderer.draws).toBe(0);
    now = SYNCHRONIZED_OUTPUT_CAP_MS;
    controller.frame();
    expect(renderer.draws).toBe(1);
    expect(gridRow(renderer.grid, 0)).toBe("stuck");
  });

  test("the blink phase applies to a blinking cursor", async () => {
    const { controller, renderer } = await harness();
    controller.frame(true);
    expect(renderer.cursors.at(-1)).toMatchObject({ visible: true, style: "block", blinking: true });
    controller.frame(false);
    expect(renderer.cursors.at(-1)!.visible).toBe(false);
  });

  test("a steady cursor (DECSCUSR 2) ignores the blink phase", async () => {
    const { controller, renderer } = await harness();
    controller.feed(enc("\x1b[2 q"));
    controller.frame(false);
    expect(renderer.cursors.at(-1)).toMatchObject({ visible: true, blinking: false });
  });

  test("an unfocused terminal shows a steady hollow cursor whatever the app chose", async () => {
    const { controller, renderer } = await harness();
    controller.feed(enc("\x1b[5 q")); // blinking bar
    controller.frame(false, false);
    expect(renderer.cursors.at(-1)).toMatchObject({ visible: true, style: "hollow" });
    controller.frame(false, true);
    expect(renderer.cursors.at(-1)).toMatchObject({ visible: false, style: "bar" });
  });

  test("a cursor the app hid (DECTCEM) stays hidden focused or not", async () => {
    const { controller, renderer } = await harness();
    controller.feed(enc("\x1b[?25l"));
    controller.frame(true, false);
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

  test("Cmd chords stay with the app and the OS — until the program asks for every key", async () => {
    const { controller, core, sink } = await harness();
    expect(controller.key({ key: "v", code: "KeyV", meta: true })).toBe(false);
    expect(controller.key({ key: "ArrowLeft", code: "ArrowLeft", meta: true })).toBe(false);
    expect(sink.writes).toEqual([]);
    core.write(enc("\x1b[>11u")); // kitty: disambiguate + events + report all keys
    expect(controller.key({ key: "v", code: "KeyV", meta: true })).toBe(true);
    expect(sink.writes).toEqual([Array.from(enc("\x1b[118;9u"))]);
  });

  test("releases reach the pty only when the program asked for key events", async () => {
    const { controller, core, sink } = await harness();
    expect(controller.key({ key: "a", code: "KeyA", release: true })).toBe(false);
    expect(sink.writes).toEqual([]);
    core.write(enc("\x1b[>3u"));
    expect(controller.key({ key: "a", code: "KeyA", release: true })).toBe(true);
    expect(sink.writes).toEqual([Array.from(enc("\x1b[97;1:3u"))]);
    // ⌘ down during the hold is a modifier on the release, not a chord: the ⌘ gate is for presses.
    expect(controller.key({ key: "a", code: "KeyA", meta: true, release: true })).toBe(true);
    expect(sink.writes.at(-1)).toEqual(Array.from(enc("\x1b[97;9:3u")));
  });

  test("Shift+PgUp/PgDn page the viewport; ⌘K clears history and the screen above the prompt", async () => {
    const { controller, core, renderer, sink } = await harness(20, 3);
    const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
    controller.feed(enc(lines.join("\r\n")));
    controller.frame();
    expect(gridRow(renderer.grid, 0)).toBe("L8");
    controller.scrollPage(-1);
    controller.frame();
    expect(gridRow(renderer.grid, 0)).toBe("L5");
    controller.scrollPage(1);
    controller.frame();
    expect(gridRow(renderer.grid, 0)).toBe("L8");

    controller.scrollPage(-1);
    controller.clearScreen();
    controller.frame();
    expect(core.viewportActive(), "the viewport is live again").toBe(true);
    expect([0, 1, 2].map((y) => gridRow(renderer.grid, y))).toEqual(["", "", "L10"]);
    expect(sink.writes, "no prompt marks: nothing for the shell to repaint").toEqual([]);
    controller.feed(enc("\r\n\x1b]133;A\x1b\\$ "));
    controller.clearScreen();
    expect(sink.writes).toEqual([[0x0c]]);
  });

  test("a theme swap repaints the live terminal in place and tells a program under mode 2031", async () => {
    const { controller, core, renderer, sink } = await harness(20, 3);
    controller.feed(enc("hi"));
    controller.frame();
    const draws = renderer.draws;
    const theme = {
      fg: [1, 2, 3] as const,
      bg: [4, 5, 6] as const,
      cursor: [7, 8, 9] as const,
      palette: Array.from({ length: 16 }, (_, i) => [i, i, i] as const),
      selectionBg: [10, 11, 12] as const,
      selectionFg: [13, 14, 15] as const,
    };
    controller.setTheme(theme, "light");
    expect(renderer.colors).toEqual([theme]);
    expect(renderer.grid.cell(0, 0)).toMatchObject({ text: "h", fg: [1, 2, 3], bg: [4, 5, 6] });
    controller.frame();
    expect(renderer.draws).toBe(draws + 1);
    expect(renderer.cursors.at(-1)?.color, "an idle frame still carries the new cursor color").toEqual([7, 8, 9]);
    expect(sink.writes, "the program did not ask").toEqual([]);
    core.write(enc("\x1b[?2031h"));
    controller.setTheme(theme, "dark");
    expect(sink.writes).toEqual([Array.from(enc("\x1b[?997;1n"))]);
  });

  test("an OSC 52 clipboard write in the stream reaches the clipboard hook, and still renders around it", async () => {
    const { controller, renderer } = await harness(40, 4);
    const copied: string[] = [];
    controller.hooks.onClipboard = (text) => {
      copied.push(text);
    };
    const payload = btoa("https://example.test/auth");
    controller.feed(enc(`before\x1b]52;c;${payload}\x07after`));
    controller.frame();
    expect(copied).toEqual(["https://example.test/auth"]);
    expect(gridRow(renderer.grid, 0)).toBe("beforeafter");
  });

  test("stream titles reach the title hook — including during replay, where they restore state", async () => {
    const { controller } = await harness();
    const titles: string[] = [];
    controller.hooks.onTitle = (t) => titles.push(t);
    controller.feed(enc("\x1b]0;dev@box: ~/workspace\x07"));
    controller.resetForReplay();
    controller.feed(enc("\x1b]2;dev@box: ~/workspace/mast\x07"));
    controller.endReplay();
    expect(titles).toEqual(["dev@box: ~/workspace", "dev@box: ~/workspace/mast"]);
  });

  test("historical OSC 52 in a replay never touches the clipboard; live writes after it do", async () => {
    const { controller } = await harness(40, 4);
    const copied: string[] = [];
    controller.hooks.onClipboard = (text) => {
      copied.push(text);
    };
    controller.feed(enc("\x1b]52;c;INCOMPLE")); // the gap cut mid-sequence before the pause
    controller.resetForReplay();
    controller.feed(enc(`snapshot\x1b]52;c;${btoa("stale")}\x07more`));
    controller.endReplay();
    expect(copied).toEqual([]); // the journal's old copy is history, not a user action
    controller.feed(enc(`\x1b]52;c;${btoa("fresh")}\x07`));
    expect(copied).toEqual(["fresh"]);
  });

  test("a program's query is answered into the pty; a replayed query is not", async () => {
    const { controller, sink } = await harness(20, 3);
    controller.feed(enc("\x1b[c"));
    expect(sink.writes).toEqual([Array.from(enc("\x1b[?62;22c"))]);
    controller.resetForReplay();
    controller.feed(enc("\x1b[c\x1b[6n"));
    expect(sink.writes).toHaveLength(1); // history: nothing answered
    controller.endReplay();
    controller.feed(enc("\x1b[6n"));
    expect(sink.writes).toHaveLength(2);
  });

  test("a bell in the stream reaches the bell hook; a replayed bell is history and stays silent", async () => {
    const { controller } = await harness(20, 3);
    let bells = 0;
    controller.hooks.onBell = () => bells++;
    controller.feed(enc("\x07"));
    expect(bells).toBe(1);
    controller.resetForReplay();
    controller.feed(enc("old\x07"));
    controller.endReplay();
    expect(bells).toBe(1);
    controller.feed(enc("\x07"));
    expect(bells).toBe(2);
  });

  test("resetForReplay wipes state so a journal snapshot lands on a clean terminal", async () => {
    const { controller, core, renderer } = await harness(40, 4);
    controller.feed(enc("stale garbage\x1b[?1049h TUI leftovers"));
    controller.frame();
    controller.resetForReplay();
    controller.feed(enc("replayed$ "));
    controller.frame();
    expect(core.altScreen()).toBe(false);
    expect(gridRow(renderer.grid, 0)).toBe("replayed$");
    expect(gridRow(renderer.grid, 1)).toBe("");
  });

  test("focus changes reach the pty only when the app asked for them (mode 1004)", async () => {
    const { controller, core, sink } = await harness();
    controller.setFocus(false);
    controller.setFocus(true);
    expect(sink.writes).toEqual([]);
    core.write(enc("\x1b[?1004h"));
    controller.setFocus(false);
    controller.setFocus(true);
    expect(sink.writes).toEqual([Array.from(enc("\x1b[O")), Array.from(enc("\x1b[I"))]);
  });

  test("the wheel scrolls scrollback normally, but drives an alternate-screen TUI with arrows", async () => {
    const { controller, core, sink } = await harness();
    controller.wheel(-2); // normal screen: local scrollback, nothing sent
    expect(sink.writes).toEqual([]);
    core.write(enc("\x1b[?1049h")); // vim/claude-code take the alt screen — it has no scrollback
    controller.wheel(-2);
    controller.wheel(3);
    expect(sink.writes).toEqual([
      Array.from(enc("\x1b[A\x1b[A")),
      Array.from(enc("\x1b[B\x1b[B\x1b[B")),
    ]);
    core.write(enc("\x1b[?1h")); // and with DECCKM on, the arrows follow it
    controller.wheel(-1);
    expect(sink.writes.at(-1)).toEqual(Array.from(enc("\x1bOA")));
    core.write(enc("\x1b[?1007l")); // a TUI that turned alternate scroll off hears nothing
    controller.wheel(-1);
    controller.wheel(2);
    expect(sink.writes).toHaveLength(3);
  });

  test("a mouse event is local until the app tracks the mouse; Shift always keeps it local", async () => {
    const { controller, core, sink } = await harness();
    const click = { action: "press", button: "left", mods: 0, x: 2, y: 1 } as const;
    expect(controller.mouse(click)).toBe(false);
    expect(sink.writes).toEqual([]);
    core.write(enc("\x1b[?1000h\x1b[?1006h"));
    expect(controller.mouse(click)).toBe(true);
    expect(sink.writes).toEqual([Array.from(enc("\x1b[<0;3;2M"))]);
    // motion the mode does not carry is still the app's: consumed, nothing sent
    expect(controller.mouse({ action: "motion", mods: 0, x: 3, y: 1 })).toBe(true);
    expect(sink.writes).toHaveLength(1);
    core.write(enc("\x1b[?1002h")); // button-event tracking: one report per cell while dragging
    const drag = { action: "motion", button: "left", mods: 0 } as const;
    controller.mouse({ ...drag, x: 4, y: 1 });
    controller.mouse({ ...drag, x: 4, y: 1 });
    controller.mouse({ ...drag, x: 5, y: 1 });
    expect(sink.writes.slice(1)).toEqual([
      Array.from(enc("\x1b[<32;5;2M")),
      Array.from(enc("\x1b[<32;6;2M")),
    ]);
    expect(controller.mouse({ ...click, mods: MODS.SHIFT })).toBe(false);
    expect(sink.writes).toHaveLength(3);
  });

  test("the wheel reaches a mouse-tracking app as wheel buttons at the pointer's cell", async () => {
    const { controller, core, sink } = await harness();
    core.write(enc("\x1b[?1000h\x1b[?1006h"));
    controller.wheel(-2, { x: 4, y: 3 });
    controller.wheel(1, { x: 4, y: 3 });
    expect(sink.writes).toEqual([
      Array.from(enc("\x1b[<64;5;4M")),
      Array.from(enc("\x1b[<64;5;4M")),
      Array.from(enc("\x1b[<65;5;4M")),
    ]);
    controller.wheel(-1, { x: 4, y: 3 }, MODS.SHIFT); // Shift: local scrollback instead
    expect(sink.writes).toHaveLength(3);
  });

  test("committed composition text (IME, dead keys) flows to the pty verbatim", async () => {
    const { controller, sink } = await harness();
    // The composing keydowns themselves encode nothing...
    expect(controller.key({ key: "Dead", code: "KeyE", alt: true })).toBe(false);
    expect(controller.key({ key: "é", code: "KeyE", composing: true })).toBe(false);
    // ...the committed text arrives whole, via the composition event.
    controller.text("é");
    controller.text("");
    expect(sink.writes).toEqual([Array.from(enc("é"))]);
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

  test("resize reflows the core and the renderer at once; the pty hears it once it settles", async () => {
    const { controller, core, renderer, sink, timers } = await harness(80, 24);
    controller.resize(120, 40);
    expect(core.size).toEqual({ cols: 120, rows: 40 });
    expect(renderer.resizes).toEqual([[80, 24], [120, 40]]);
    expect(controller.size).toEqual({ cols: 120, rows: 40 });
    expect(sink.resizes).toEqual([]);
    timers.advance(RESIZE_SETTLE_MS);
    expect(sink.resizes).toEqual([[120, 40]]);
  });

  test("a splitter drag is many local reflows and one pty resize, where it settled", async () => {
    const { controller, core, sink, timers } = await harness(80, 24);
    for (let cols = 81; cols <= 100; cols++) {
      controller.resize(cols, 24);
      timers.advance(RESIZE_SETTLE_MS / 2);
    }
    expect(core.size).toEqual({ cols: 100, rows: 24 });
    expect(sink.resizes).toEqual([]);
    timers.advance(RESIZE_SETTLE_MS);
    expect(sink.resizes).toEqual([[100, 24]]);
  });

  test("a silent resize adopts the pty's size without announcing it back", async () => {
    const { controller, core, renderer, sink, timers } = await harness(80, 24);
    controller.resize(90, 30);
    controller.resize(100, 30, { silent: true });
    timers.advance(RESIZE_SETTLE_MS * 2);
    expect(core.size).toEqual({ cols: 100, rows: 30 });
    expect(renderer.resizes.at(-1)).toEqual([100, 30]);
    expect(sink.resizes, "the superseded local intent is not announced either").toEqual([]);
  });

  test("dispose drops a pending pty resize", async () => {
    const { controller, sink, timers } = await harness(80, 24);
    controller.resize(120, 40);
    controller.dispose();
    timers.advance(RESIZE_SETTLE_MS * 2);
    expect(sink.resizes).toEqual([]);
  });

  test("a replacement renderer is painted whole from the core, with no pty traffic", async () => {
    const { controller, renderer, sink, timers } = await harness(20, 4);
    controller.feed(enc("first\r\nsecond"));
    controller.frame();
    const fresh = new RecRenderer();
    controller.replaceRenderer(fresh);
    expect(fresh.resizes).toEqual([[20, 4]]);
    expect(gridRow(fresh.grid, 0)).toBe("first");
    expect(gridRow(fresh.grid, 1)).toBe("second");
    controller.frame();
    expect(fresh.draws, "the next frame draws on the new renderer").toBe(1);
    expect(renderer.draws, "the old one hears nothing more").toBe(1);
    timers.advance(RESIZE_SETTLE_MS * 2);
    expect(sink.resizes).toEqual([]);
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
    const { controller, renderer, sink, timers } = await harness(80, 24);
    controller.resize(80, 24);
    timers.advance(RESIZE_SETTLE_MS * 2);
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

describe("search", () => {
  const corpus = (lines: number) =>
    Array.from({ length: lines }, (_, i) => (i % 417 === 0 ? `line ${i} ErRoR` : `line ${i}`)).join("\r\n");
  const selectedCells = (grid: TerminalGrid, y: number) => {
    let s = "";
    for (let x = 0; x < grid.cols; x++) s += grid.cell(x, y).selected ? "#" : ".";
    return s.replace(/\.+$/, "");
  };
  const settle = (controller: TerminalController, states: (SearchState | null)[]) => {
    let frames = 0;
    do {
      controller.frame();
      if (++frames > 500) throw new Error("the search never completed");
    } while (states.at(-1)?.status !== "complete");
    return frames;
  };

  test("a big scrollback is searched across frames, each within the tick budget, and reports as it goes", async () => {
    let clock = 0;
    const { controller, renderer } = await harness(40, 24, () => (clock += 3));
    // Some 17 pages of history: a page is one feed and one tick, so at two ticks a frame this
    // takes many frames.
    controller.feed(enc(`${corpus(20000)}\r\nlast error`));
    controller.frame();
    const states: (SearchState | null)[] = [];
    controller.hooks.onSearch = (s) => states.push(s);
    controller.search("error");
    controller.frame();
    expect(states.at(-1)!.status, "two ticks of 3 ms exhaust a 4 ms budget: the frame let go").not.toBe("complete");
    const frames = settle(controller, states);
    expect(frames).toBeGreaterThan(3);
    expect(states.at(-1)).toEqual({ status: "complete", total: 49, selected: 0 });
    expect(states.map((s) => s!.total), "the count climbed as pages were searched").toEqual(
      [...states.map((s) => s!.total)].sort((a, b) => a - b),
    );
    controller.frame();
    expect(selectedCells(renderer.grid, 23), "the newest match is selected and painted").toBe(".....#####");
    expect(renderer.matches).toContainEqual({ y: 23, start: 5, end: 10 });
    expect(controller.selectedText()).toBe("error");
  });

  test("next and prev walk the matches with the viewport following; clearing drops every highlight", async () => {
    const { controller, renderer, core } = await harness(40, 24);
    controller.feed(enc(`${corpus(5000)}\r\nlast error`));
    const bars: Scrollbar[] = [];
    controller.hooks.onScrollbar = (bar) => bars.push(bar);
    const states: (SearchState | null)[] = [];
    controller.hooks.onSearch = (s) => states.push(s);
    controller.search("error");
    settle(controller, states);
    const atBottom = bars.at(-1)!.offset;
    expect(controller.searchStep("next")).toBe(true);
    controller.frame();
    expect(states.at(-1)).toEqual({ status: "complete", total: 13, selected: 1 });
    expect(bars.at(-1)!.offset, "the older match was off-screen: the viewport scrolled up to it").toBeLessThan(atBottom);
    expect(renderer.grid.rows).toBe(24);
    const y = [...Array(24).keys()].find((row) => selectedCells(renderer.grid, row) !== "")!;
    expect(selectedCells(renderer.grid, y)).toMatch(/^\.+#####$/);
    expect(renderer.matches, "the viewport's matches were re-read after the scroll").toContainEqual({
      y,
      start: y === undefined ? 0 : selectedCells(renderer.grid, y).indexOf("#"),
      end: selectedCells(renderer.grid, y).length,
    });
    expect(controller.searchStep("prev")).toBe(true);
    controller.frame();
    expect(states.at(-1)!.selected).toBe(0);

    controller.search("");
    controller.frame();
    expect(states.at(-1)).toBeNull();
    expect(renderer.matches).toEqual([]);
    expect(core.hasSelection()).toBe(false);
    expect([...Array(24).keys()].every((row) => selectedCells(renderer.grid, row) === "")).toBe(true);
    expect(controller.searchStep("next"), "no search, nothing to step").toBe(false);
  });

  test("no matches is reported as such; a match arriving later is found and selected", async () => {
    const { controller, renderer } = await harness(40, 4);
    controller.feed(enc("nothing here"));
    const states: (SearchState | null)[] = [];
    controller.hooks.onSearch = (s) => states.push(s);
    controller.search("needle");
    settle(controller, states);
    expect(states.at(-1)).toEqual({ status: "complete", total: 0, selected: null });
    expect(controller.searchStep("next")).toBe(false);
    controller.feed(enc("\r\na NEEDLE arrives"));
    controller.frame();
    controller.frame();
    expect(states.at(-1)).toEqual({ status: "complete", total: 1, selected: 0 });
    expect(selectedCells(renderer.grid, 1)).toBe("..######");
  });

  test("resubmitting the needle keeps the selection; a new needle drops it until its results land", async () => {
    const { controller, core } = await harness(40, 4);
    controller.feed(enc("error one\r\nerror two"));
    const states: (SearchState | null)[] = [];
    controller.hooks.onSearch = (s) => states.push(s);
    controller.search("error");
    settle(controller, states);
    controller.searchStep("next");
    controller.frame();
    expect(states.at(-1)!.selected).toBe(1);
    controller.search("error");
    controller.frame();
    expect(states.at(-1)!.selected).toBe(1);
    expect(controller.selectedText()).toBe("error");
    controller.search("two");
    expect(core.hasSelection(), "the old match is no longer what is searched for").toBe(false);
    controller.frame();
    controller.frame();
    expect(states.at(-1)).toEqual({ status: "complete", total: 1, selected: 0 });
    expect(controller.selectedText()).toBe("two");
  });

  test("a rebuilt renderer inherits the match tint", async () => {
    const { controller, renderer } = await harness(40, 4);
    controller.feed(enc("error one\r\nerror two"));
    const states: (SearchState | null)[] = [];
    controller.hooks.onSearch = (s) => states.push(s);
    controller.search("error");
    settle(controller, states);
    controller.frame();
    expect(renderer.matches).toHaveLength(2);
    const fresh = new RecRenderer();
    controller.replaceRenderer(fresh);
    expect(fresh.matches).toEqual(renderer.matches);
  });
});

describe("keystroke latency", () => {
  const FRAME_MS = 16;

  /**
   * A pty that echoes every key back {@code delay} ms after it was written, and a frame loop on a
   * fake clock: {@code type} presses a key at the current time, {@code run} advances the clock a
   * frame at a time, delivering echoes when they are due and painting after each tick.
   */
  async function echoing(delay: number) {
    let clock = 0;
    const h = await harness(40, 4, () => clock);
    const due: { at: number; bytes: Uint8Array }[] = [];
    const stats: LatencyStats[] = [];
    h.controller.hooks.onLatency = (s) => stats.push(s);
    h.sink.write = (bytes) => {
      if (delay >= 0) due.push({ at: clock + delay, bytes });
    };
    const run = (ms: number) => {
      for (const end = clock + ms; clock < end; ) {
        clock = Math.min(end, clock + FRAME_MS);
        for (const echo of due.filter((d) => d.at <= clock)) h.controller.feed(echo.bytes);
        due.splice(0, due.length, ...due.filter((d) => d.at > clock));
        h.controller.frame();
      }
    };
    const type = (key: string) => h.controller.key({ key, code: `Key${key.toUpperCase()}` });
    const tick = (ms: number) => {
      clock += ms;
    };
    return { ...h, stats, run, type, tick, clock: () => clock };
  }

  test("a link that echoes N ms after each write reads as a p50 of N within one frame", async () => {
    const { run, type, stats, controller } = await echoing(160);
    for (const key of "hello world") {
      type(key);
      run(100);
    }
    run(500);
    const latest = controller.keystrokeLatency()!;
    expect(latest.count).toBe(11);
    expect(latest.p50).toBeGreaterThanOrEqual(160);
    expect(latest.p50).toBeLessThan(160 + FRAME_MS);
    expect(latest.p95).toBeLessThan(160 + FRAME_MS);
    expect(stats).toHaveLength(11);
    expect(stats.at(-1)).toEqual(latest);
  });

  test("keys typed faster than the echo returns are each timed from their own keydown", async () => {
    const { run, type, controller } = await echoing(300);
    type("a");
    run(100);
    type("b");
    run(100);
    type("c");
    run(1000);
    const latest = controller.keystrokeLatency()!;
    expect(latest.count).toBe(3);
    expect(latest.p95).toBeLessThan(300 + FRAME_MS);
  });

  test("the keydown's own timestamp is the start, not the moment the handler ran", async () => {
    const { run, controller } = await echoing(160);
    controller.key({ key: "a", code: "KeyA" }, -40);
    run(400);
    expect(controller.keystrokeLatency()!.p50).toBeGreaterThanOrEqual(200);
  });

  test("a ⌘ chord the program never hears is not counted", async () => {
    const { run, controller, stats } = await echoing(160);
    expect(controller.key({ key: "k", code: "KeyK", meta: true })).toBe(false);
    run(400);
    controller.feed(enc("unrelated output"));
    run(100);
    expect(controller.keystrokeLatency()).toBeNull();
    expect(stats).toEqual([]);
  });

  test("a key the program swallows is not counted, and the next output is not its echo", async () => {
    const { run, type, controller, stats } = await echoing(-1);
    type("q");
    run(KEY_ECHO_TIMEOUT_MS + FRAME_MS);
    controller.feed(enc("a clock tick, unrelated"));
    run(FRAME_MS);
    expect(controller.keystrokeLatency()).toBeNull();
    expect(stats).toEqual([]);
  });

  test("a release the program asked for is sent but never timed", async () => {
    const { run, controller, core } = await echoing(50);
    core.write(enc("\x1b[>2u"));
    expect(controller.key({ key: "a", code: "KeyA", release: true })).toBe(true);
    run(200);
    expect(controller.keystrokeLatency()).toBeNull();
  });

  test("bytes that paint nothing settle no key; the visible echo behind them does", async () => {
    const { run, type, controller } = await echoing(-1);
    type("a");
    run(FRAME_MS);
    controller.feed(enc("\x1b[?2004h"));
    run(FRAME_MS);
    expect(controller.keystrokeLatency()).toBeNull();
    controller.feed(enc("a"));
    run(FRAME_MS);
    expect(controller.keystrokeLatency()!.count).toBe(1);
  });

  test("output that arrived before a key was pressed is never that key's echo", async () => {
    const { run, type, controller } = await echoing(-1);
    type("a");
    run(FRAME_MS);
    controller.feed(enc("a"));
    controller.feed(enc("$ "));
    type("b");
    run(FRAME_MS);
    expect(controller.keystrokeLatency()!.count, "only a is echoed; b's echo has not come").toBe(1);
    run(FRAME_MS * 4);
    expect(controller.keystrokeLatency()!.count).toBe(1);
    controller.feed(enc("b"));
    run(FRAME_MS);
    expect(controller.keystrokeLatency()!.count).toBe(2);
  });

  test("the clock stops after the frame draws, so the draw is part of the number", async () => {
    const DRAW_MS = 5;
    const h = await echoing(-1);
    const draw = h.renderer.draw.bind(h.renderer);
    h.renderer.draw = () => {
      h.tick(DRAW_MS);
      draw();
    };
    h.type("a");
    h.tick(160);
    h.controller.feed(enc("a"));
    h.controller.frame();
    expect(h.controller.keystrokeLatency()!.p50).toBe(160 + DRAW_MS);
  });

  test("a replay does not echo the keys typed before it", async () => {
    const { run, type, controller } = await echoing(-1);
    type("a");
    controller.resetForReplay();
    controller.feed(enc("replayed screen"));
    controller.endReplay();
    run(FRAME_MS);
    expect(controller.keystrokeLatency()).toBeNull();
  });
});
