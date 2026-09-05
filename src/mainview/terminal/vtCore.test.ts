import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyEventFor, MODS, type KeyStroke } from "./input";
import { SCROLLBACK_MAX_BYTES, VtCore } from "./vtCore";

// Drives the real vendored libghostty-vt wasm (see PIN.md) — no mocks. If the wasm's ABI drifts on
// a re-pin, these tests fail loudly, which is exactly the guard we want around an alpha C ABI.
const WASM = readFileSync(join(import.meta.dir, "ghostty-vt.wasm"));

async function vt(cols = 80, rows = 24): Promise<VtCore> {
  return VtCore.create(WASM, cols, rows);
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function rowText(core: VtCore, y: number): string {
  const row = core.snapshot().rows.find((r) => r.y === y);
  return row ? row.cells.map((c) => c.text).join("").replace(/\u0000/g, "").trimEnd() : "";
}

let open: VtCore[] = [];
afterEach(() => {
  open.forEach((c) => c.free());
  open = [];
});
async function track(cols?: number, rows?: number): Promise<VtCore> {
  const core = await vt(cols, rows);
  open.push(core);
  return core;
}

describe("VtCore", () => {
  test("indexed ANSI colors resolve through the configured palette; true color passes through", async () => {
    // a fake but distinct 16-color palette so we can prove the lookup uses OUR palette, not ghostty's
    const palette = Array.from({ length: 16 }, (_, i) => [i * 15, 200 - i, i] as const);
    const theme = { fg: [1, 2, 3] as const, bg: [4, 5, 6] as const, cursor: [7, 8, 9] as const, palette };
    const core = await VtCore.create(WASM, 24, 3, theme);
    open.push(core);
    // SGR 31 = ANSI index 1; a 24-bit true-color; then a default cell
    core.write(bytes("\x1b[31mA\x1b[0m\x1b[38;2;100;150;200mB\x1b[0mC"));
    const cells = core.readAll().rows[0]!.cells;

    expect(cells[0]!.fg).toEqual(palette[1]!); // ANSI red → the configured palette entry, not ghostty's
    expect(cells[1]!.fg).toEqual([100, 150, 200]); // true color is untouched
    expect(cells[2]!.fg).toEqual(theme.fg); // an unstyled cell falls back to the theme foreground
  });

  test("reports display width: wide CJK and emoji are 2 columns, ASCII is 1", async () => {
    const core = await track(20, 2);
    core.write(bytes("A世x😀"));
    const cells = core.readAll().rows[0]!.cells;
    expect(cells[0]).toMatchObject({ text: "A", width: 1 });
    expect(cells[1]).toMatchObject({ text: "世", width: 2 });
    // the cell after a wide glyph is a blank spacer, itself width 1
    expect(cells[2]).toMatchObject({ text: "", width: 1 });
    expect(cells[3]).toMatchObject({ text: "x", width: 1 });
    expect(cells[4]).toMatchObject({ text: "😀", width: 2 });
    expect(core.readAll().rows[0]!.cells[0]!.width).toBe(1); // stable across reads
  });

  test("scrollback is budgeted like a real terminal, not the library's 10 KB default", async () => {
    const core = await track(80, 4);
    expect(core.scrollbackMaxBytes()).toBe(SCROLLBACK_MAX_BYTES);
    // ~1 MB of history: well past the library default and past one internal page, so a pruned
    // terminal would have lost the first lines.
    const lines = 20_000;
    let chunk = "";
    for (let i = 0; i < lines; i++) {
      chunk += `line ${i} ${"x".repeat(40)}\r\n`;
      if (chunk.length > 65_536) {
        core.write(bytes(chunk));
        chunk = "";
      }
    }
    core.write(bytes(chunk));
    core.scroll("top");
    expect(rowText(core, 0)).toBe(`line 0 ${"x".repeat(40)}`);
    core.scroll("bottom");
    expect(rowText(core, 2)).toBe(`line ${lines - 1} ${"x".repeat(40)}`);
  });

  test("a precompiled module serves many terminals, each with its own memory", async () => {
    const module = await WebAssembly.compile(WASM);
    const a = await VtCore.create(module, 10, 2);
    const b = await VtCore.create(module, 10, 2);
    open.push(a, b);
    a.write(bytes("only-a"));
    expect(rowText(a, 0)).toBe("only-a");
    expect(rowText(b, 0)).toBe("");
  });

  describe("selection the core owns", () => {
    // 10×20 px cells. As in Ghostty, the pointer's half of a cell decides the boundary: a press in
    // the left half anchors before that cell, a drag past the midpoint includes the cell.
    const px = (x: number, y: number) => ({ x: (x + 0.8) * 10, y: (y + 0.5) * 20 });
    const pressPx = (x: number, y: number) => ({ x: (x + 0.2) * 10, y: (y + 0.5) * 20 });
    const sized = async (cols: number, rows: number) => {
      const core = await track(cols, rows);
      core.setCellPixels(10, 20);
      return core;
    };
    const selectedRow = (core: VtCore, y: number) =>
      core
        .readAll()
        .rows[y]!.cells.map((c) => (c.selected ? "#" : "."))
        .join("")
        .replace(/\.+$/, "");

    test("press, drag, release selects cells; the text is what the cells say", async () => {
      const core = await sized(20, 4);
      core.write(bytes("hello world\r\nsecond line"));
      expect(core.hasSelection()).toBe(false);
      core.selectionPress({ x: 0, y: 0 }, pressPx(0, 0), 1000);
      expect(core.hasSelection()).toBe(false); // a press alone selects nothing
      core.selectionDrag({ x: 3, y: 1 }, px(3, 1));
      core.selectionRelease({ x: 3, y: 1 });
      expect(core.hasSelection()).toBe(true);
      expect(selectedRow(core, 0)).toBe("####################");
      expect(selectedRow(core, 1)).toBe("####");
      expect(core.selectionText()).toBe("hello world\nseco");
    });

    test("the selection follows its content when the viewport scrolls, and reads across history", async () => {
      const core = await sized(20, 3);
      core.write(bytes("one\r\ntwo\r\nthree\r\nfour\r\nfive"));
      core.selectionPress({ x: 0, y: 0 }, pressPx(0, 0), 1000); // "three" is at the top of the viewport
      core.selectionDrag({ x: 2, y: 1 }, px(2, 1));
      core.selectionRelease({ x: 2, y: 1 });
      expect(core.selectionText()).toBe("three\nfou");
      core.scroll({ delta: -2 }); // "one" at the top now; "three" is viewport row 2
      expect(selectedRow(core, 0)).toBe("");
      expect(selectedRow(core, 2)).toBe("####################");
      expect(core.selectionText()).toBe("three\nfou");
      core.scroll("bottom");
      core.write(bytes("\r\nsix\r\nseven")); // the selected rows leave the viewport entirely
      expect(selectedRow(core, 0)).toBe("");
      expect(core.selectionText()).toBe("three\nfou");
    });

    test("a second click within the repeat window selects the word, a third the line", async () => {
      const core = await sized(30, 3);
      core.write(bytes("alpha beta-gamma delta"));
      const click = (t: number) => {
        core.selectionPress({ x: 7, y: 0 }, pressPx(7, 0), t);
        core.selectionRelease({ x: 7, y: 0 });
      };
      click(1000);
      expect(core.hasSelection()).toBe(false);
      click(1200);
      expect(core.selectionText()).toBe("beta-gamma");
      click(1400);
      expect(core.selectionText()).toBe("alpha beta-gamma delta");
    });

    test("a click long after the last one starts over", async () => {
      const core = await sized(30, 3);
      core.write(bytes("alpha beta"));
      core.selectionPress({ x: 1, y: 0 }, pressPx(1, 0), 1000);
      core.selectionRelease({ x: 1, y: 0 });
      core.selectionPress({ x: 1, y: 0 }, pressPx(1, 0), 5000);
      core.selectionRelease({ x: 1, y: 0 });
      expect(core.hasSelection()).toBe(false);
    });

    test("clearing drops the selection and the gesture behind it", async () => {
      const core = await sized(20, 3);
      core.write(bytes("hello"));
      core.selectionPress({ x: 0, y: 0 }, pressPx(0, 0), 1000);
      core.selectionDrag({ x: 4, y: 0 }, px(4, 0));
      core.clearSelection();
      expect(core.hasSelection()).toBe(false);
      expect(core.selectionText()).toBe("");
      expect(selectedRow(core, 0)).toBe("");
    });

    test("a press off the grid is clamped, never a crash", async () => {
      const core = await sized(10, 2);
      core.write(bytes("x"));
      core.selectionPress({ x: 99, y: 99 }, pressPx(99, 99), 1000);
      core.selectionDrag({ x: -5, y: -5 }, px(-5, -5));
      expect(core.hasSelection()).toBe(true);
    });
  });

  test("viewportActive says whether the user is looking at the live screen", async () => {
    const core = await track(20, 3);
    core.write(bytes("a\r\nb\r\nc\r\nd\r\ne"));
    expect(core.viewportActive()).toBe(true);
    core.scroll({ delta: -1 });
    expect(core.viewportActive()).toBe(false);
    core.write(bytes("\r\nf")); // output while scrolled up does not move the viewport
    expect(core.viewportActive()).toBe(false);
    core.scroll("bottom");
    expect(core.viewportActive()).toBe(true);
  });

  test("scrolls the viewport up into scrollback and back to the live bottom", async () => {
    const core = await track(20, 4); // a 4-row viewport
    for (let i = 1; i <= 12; i++) core.write(bytes(`line${i}\r\n`));
    const view = () =>
      core
        .readAll()
        .rows.map((r) => r.cells.map((c) => c.text).join("").trimEnd())
        .join("\n");

    const live = view();
    expect(live).toContain("line12"); // the newest line is visible at the bottom

    core.scroll({ delta: -6 }); // up into history
    const scrolled = view();
    expect(scrolled).not.toEqual(live);
    expect(scrolled).not.toContain("line12"); // scrolled away from the newest
    expect(scrolled).toContain("line"); // ...but still showing history

    core.scroll("bottom");
    expect(view()).toEqual(live); // snapped back to the live view
  });

  test("reads SGR style attributes per cell", async () => {
    const core = await track(30, 3);
    // bold, italic, underline, strikethrough, faint, then a plain cell
    core.write(
      bytes("\x1b[1mB\x1b[0m\x1b[3mI\x1b[0m\x1b[4mU\x1b[0m\x1b[9mS\x1b[0m\x1b[2mF\x1b[0mP"),
    );
    const c = core.readAll().rows[0]!.cells;
    expect(c[0]).toMatchObject({ text: "B", bold: true, italic: false });
    expect(c[1]).toMatchObject({ text: "I", italic: true, bold: false });
    expect(c[2]).toMatchObject({ text: "U", underline: "single", underlineColor: null });
    expect(c[3]).toMatchObject({ text: "S", strikethrough: true });
    expect(c[4]).toMatchObject({ text: "F", faint: true });
    expect(c[5]).toMatchObject({
      text: "P",
      bold: false,
      italic: false,
      underline: "none",
      strikethrough: false,
      faint: false,
      overline: false,
      invisible: false,
    });
  });

  test("reads every SGR 4:x underline style, the SGR 58 underline color, overline and invisible", async () => {
    const core = await track(30, 3);
    core.write(
      bytes(
        "\x1b[4:2mD\x1b[0m\x1b[4:3m\x1b[58;2;10;20;30mC\x1b[0m\x1b[4:4m\x1b[58;5;1mO\x1b[0m" +
          "\x1b[4:5mA\x1b[0m\x1b[53mV\x1b[0m\x1b[8mH\x1b[0m",
      ),
    );
    const c = core.readAll().rows[0]!.cells;
    expect(c[0]).toMatchObject({ text: "D", underline: "double", underlineColor: null });
    expect(c[1]).toMatchObject({ text: "C", underline: "curly", underlineColor: [10, 20, 30] });
    // palette index 1 resolves through the configured palette (the default theme's red)
    expect(c[2]).toMatchObject({ text: "O", underline: "dotted", underlineColor: [224, 123, 111] });
    expect(c[3]).toMatchObject({ text: "A", underline: "dashed" });
    expect(c[4]).toMatchObject({ text: "V", overline: true, underline: "none" });
    expect(c[5]).toMatchObject({ text: "H", invisible: true });
  });

  test("reports the cursor shape and blink request: DECSCUSR and mode 12", async () => {
    const core = await track(10, 2);
    expect(core.cursor()).toMatchObject({ style: "block", blinking: true }); // Mast's default
    core.write(bytes("\x1b[5 q"));
    expect(core.cursor()).toMatchObject({ style: "bar", blinking: true });
    core.write(bytes("\x1b[6 q"));
    expect(core.cursor()).toMatchObject({ style: "bar", blinking: false });
    core.write(bytes("\x1b[3 q"));
    expect(core.cursor()).toMatchObject({ style: "underline", blinking: true });
    core.write(bytes("\x1b[2 q"));
    expect(core.cursor()).toMatchObject({ style: "block", blinking: false });
    core.write(bytes("\x1b[0 q"));
    expect(core.cursor()).toMatchObject({ style: "block", blinking: true });
    core.write(bytes("\x1b[?12l"));
    expect(core.cursor()).toMatchObject({ blinking: false });
    core.write(bytes("\x1b[?25l"));
    expect(core.cursor()).toMatchObject({ visible: false });
  });

  test("reverse video swaps a cell's foreground and background", async () => {
    const theme = {
      fg: [240, 240, 240] as const,
      bg: [10, 10, 10] as const,
      cursor: [255, 0, 0] as const,
      palette: Array.from({ length: 16 }, (_, i) => [i, i, i] as const),
    };
    const core = await VtCore.create(WASM, 10, 2, theme);
    open.push(core);
    core.write(bytes("\x1b[7mX"));
    const cell = core.readAll().rows[0]!.cells[0]!;
    // default fg/bg, inverted: the glyph is drawn in the background color on the foreground color
    expect(cell.fg).toEqual(theme.bg);
    expect(cell.bg).toEqual(theme.fg);
  });

  test("default-colored cells resolve to the theme, explicit SGR colors pass through", async () => {
    const theme = {
      fg: [200, 210, 220] as const,
      bg: [10, 12, 16] as const,
      cursor: [255, 0, 0] as const,
      palette: Array.from({ length: 16 }, (_, i) => [i, i, i] as const),
    };
    const core = await VtCore.create(WASM, 40, 4, theme);
    open.push(core);
    // explicit red fg 'R', explicit green bg 'G', then a default-colored 'p'
    core.write(bytes("\x1b[31mR\x1b[0m\x1b[42mG\x1b[0mp"));
    const cells = core.readAll().rows[0]!.cells;

    expect(cells[0]!.fg).not.toEqual(theme.fg); // 'R' keeps its explicit red
    expect(cells[0]!.bg).toEqual(theme.bg); // ...but its default bg becomes the theme bg
    expect(cells[1]!.bg).not.toEqual(theme.bg); // 'G' keeps its explicit green bg
    expect(cells[2]!.fg).toEqual(theme.fg); // default 'p' is painted in the theme fg, not black
    expect(cells[2]!.bg).toEqual(theme.bg);
  });

  test("writes plain text and reads it back cell for cell", async () => {
    const core = await track();
    core.write(bytes("hello"));

    const row = core.snapshot().rows.find((r) => r.y === 0)!;
    expect(row.cells.slice(0, 5).map((c) => c.text)).toEqual(["h", "e", "l", "l", "o"]);
  });

  test("resolves SGR colors into the cells", async () => {
    const core = await track();
    core.write(bytes("a\x1b[31mR\x1b[0mb"));

    const row = core.snapshot().rows.find((r) => r.y === 0)!;
    const [a, r, b] = row.cells;
    expect(a.text).toBe("a");
    expect(r.text).toBe("R");
    expect(b.text).toBe("b");
    // The red cell's foreground differs from the default; the plain cells share the default fg.
    expect(r.fg).not.toEqual(a.fg);
    expect(a.fg).toEqual(b.fg);
    expect(r.fg[0]).toBeGreaterThan(r.fg[1]); // red dominates
  });

  test("preserves multi-byte UTF-8 and combining graphemes as single cells", async () => {
    const core = await track();
    core.write(bytes("café 🚀 é"));

    const row = core.snapshot().rows.find((r) => r.y === 0)!;
    const nonBlank = row.cells.map((c) => c.text).filter((s) => s !== " " && s !== "");
    // "é" is one codepoint; "e" + combining-acute is one grapheme cluster — each occupies one cell.
    expect(nonBlank.slice(0, 4)).toEqual(["c", "a", "f", "é"]);
    expect(nonBlank).toContain("🚀");
    expect(nonBlank).toContain("é");
  });

  test("lays out multiple lines at their own y positions", async () => {
    const core = await track();
    core.write(bytes("one\r\ntwo\r\nthree"));

    expect(rowText(core, 0)).toBe("one");
    expect(rowText(core, 1)).toBe("two");
    expect(rowText(core, 2)).toBe("three");
  });

  test("tracks damage: full after a write, none after clean, dirty again on the next write", async () => {
    const core = await track();
    core.write(bytes("x"));
    expect(core.snapshot().dirty).toBe("full");

    core.clean();
    expect(core.snapshot().dirty).toBe("none");
    expect(core.snapshot().rows).toHaveLength(0);

    core.write(bytes("y"));
    const after = core.snapshot();
    expect(after.dirty).not.toBe("none");
    expect(after.rows.length).toBeGreaterThan(0);
  });

  test("reports the cursor advancing with the text", async () => {
    const core = await track();
    const start = core.cursor();
    expect(start.present).toBe(true);
    expect(start.x).toBe(0);
    expect(start.y).toBe(0);

    core.write(bytes("abc"));
    const moved = core.cursor();
    expect(moved.x).toBe(3);
    expect(moved.y).toBe(0);
    expect(moved.visible).toBe(true);
  });

  test("reflows on resize and keeps driving", async () => {
    const core = await track(80, 24);
    expect(core.size).toEqual({ cols: 80, rows: 24 });

    core.resize(100, 30);
    expect(core.size).toEqual({ cols: 100, rows: 30 });

    core.write(bytes("still-here"));
    expect(rowText(core, 0)).toBe("still-here");
  });

  test("rejects an out-of-range geometry at create and resize", async () => {
    await expect(VtCore.create(WASM, 0, 24)).rejects.toThrow("must be in 1..");
    await expect(VtCore.create(WASM, 70000, 24)).rejects.toThrow("must be in 1..");
    const core = await track();
    expect(() => core.resize(80, 0)).toThrow("must be in 1..");
    expect(() => core.resize(70000, 24)).toThrow("must be in 1..");
    // A rejected resize never desyncs the cached size from the real grid.
    expect(core.size).toEqual({ cols: 80, rows: 24 });
  });

  test("is inert and loud after free", async () => {
    const core = await vt();
    core.write(bytes("gone"));
    core.free();
    core.free(); // idempotent

    expect(() => core.write(bytes("x"))).toThrow("freed");
    expect(() => core.snapshot()).toThrow("freed");
  });

  test("fullSnapshot returns every viewport row, including blanks", async () => {
    const core = await track(20, 4);
    core.write(bytes("hi"));
    const snap = core.fullSnapshot();
    expect(snap.rows.map((r) => r.y)).toEqual([0, 1, 2, 3]);
    expect(snap.rows[0].cells.map((c) => c.text).join("").trimEnd()).toBe("hi");
    expect(snap.rows[1].cells.map((c) => c.text).join("").trimEnd()).toBe("");
  });

  test("after a scroll, fullSnapshot shows the shifted viewport (dirty rows alone would misalign)", async () => {
    const core = await track(20, 4);
    // Six lines into a four-row viewport scrolls twice; the viewport is the last four.
    core.write(bytes("l0\r\nl1\r\nl2\r\nl3\r\nl4\r\nl5"));
    const full = core.fullSnapshot();
    expect(full.rows.map((r) => r.cells.map((c) => c.text).join("").trimEnd())).toEqual([
      "l2",
      "l3",
      "l4",
      "l5",
    ]);
  });

  test("fullSnapshot is empty when nothing changed since clean", async () => {
    const core = await track(20, 4);
    core.write(bytes("x"));
    core.snapshot();
    core.clean();
    expect(core.fullSnapshot()).toEqual({ dirty: "none", rows: [] });
  });
});

describe("key encoding", () => {
  const decode = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));
  const press = (core: VtCore, stroke: KeyStroke) => decode(core.encodeKey(keyEventFor(stroke)));

  test("plain and shifted text keys encode as their text", async () => {
    const core = await track();
    expect(press(core, { key: "a", code: "KeyA" })).toBe("a");
    expect(press(core, { key: "A", code: "KeyA", shift: true })).toBe("A");
    expect(press(core, { key: "€", code: "Digit2", alt: false })).toBe("€");
  });

  test("control chords byte correctly", async () => {
    const core = await track();
    expect(press(core, { key: "a", code: "KeyA", ctrl: true })).toBe("\x01");
    expect(press(core, { key: " ", code: "Space", ctrl: true })).toBe("\x00");
  });

  test("the classic Ctrl symbol chords byte like ghostty (nothing vanishes)", async () => {
    const core = await track();
    expect(press(core, { key: "/", code: "Slash", ctrl: true })).toBe("\x1f");
    expect(press(core, { key: "_", code: "Minus", ctrl: true, shift: true })).toBe("\x1f");
    expect(press(core, { key: "2", code: "Digit2", ctrl: true })).toBe("\x00");
    expect(press(core, { key: "Tab", code: "Tab", shift: true })).toBe("\x1b[Z");
  });

  test("ghostty's deliberate fixterms divergences are preserved, not 'fixed'", async () => {
    // Upstream encodes Ctrl+[/I/M and shifted ctrl-letters as CSI-u even in legacy mode — kitty
    // parity, pinned by ghostty's own tests — so apps can tell Ctrl+[ from Escape. Do not expect
    // the old raw bytes here; modern vim/neovim parse these.
    const core = await track();
    expect(press(core, { key: "[", code: "BracketLeft", ctrl: true })).toBe("\x1b[91;5u");
    expect(press(core, { key: "A", code: "KeyA", ctrl: true, shift: true })).toBe("\x1b[97;6u");
  });

  test("non-US layouts byte by the layout, not the physical key", async () => {
    const core = await track();
    // German QWERTZ Ctrl+Z (physical KeyY) must SIGTSTP, not DSUSP.
    expect(press(core, { key: "z", code: "KeyY", ctrl: true })).toBe("\x1a");
    // AZERTY Ctrl+A (physical KeyQ) must be 0x01, never XON.
    expect(press(core, { key: "a", code: "KeyQ", ctrl: true })).toBe("\x01");
  });

  test("named keys still encode when a synthetic event arrives with an empty code", async () => {
    const core = await track();
    expect(press(core, { key: "Enter", code: "" })).toBe("\r");
    expect(press(core, { key: "Backspace", code: "" })).toBe("\x7f");
    expect(press(core, { key: "ArrowUp", code: "" })).toBe("\x1b[A");
  });

  test("the classic named keys", async () => {
    const core = await track();
    expect(press(core, { key: "Enter", code: "Enter" })).toBe("\r");
    expect(press(core, { key: "Tab", code: "Tab" })).toBe("\t");
    expect(press(core, { key: "Backspace", code: "Backspace" })).toBe("\x7f");
    expect(press(core, { key: "Escape", code: "Escape" })).toBe("\x1b");
    expect(press(core, { key: "Delete", code: "Delete" })).toBe("\x1b[3~");
    expect(press(core, { key: "Home", code: "Home" })).toBe("\x1b[H");
    expect(press(core, { key: "F1", code: "F1" })).toBe("\x1bOP");
    expect(press(core, { key: "F5", code: "F5" })).toBe("\x1b[15~");
    expect(press(core, { key: "F12", code: "F12" })).toBe("\x1b[24~");
  });

  test("arrows honor DECCKM — the reason this migration exists", async () => {
    const core = await track();
    expect(press(core, { key: "ArrowUp", code: "ArrowUp" })).toBe("\x1b[A");
    core.write(bytes("\x1b[?1h")); // vim/less enter application cursor mode
    expect(press(core, { key: "ArrowUp", code: "ArrowUp" })).toBe("\x1bOA");
    expect(press(core, { key: "ArrowLeft", code: "ArrowLeft" })).toBe("\x1bOD");
    core.write(bytes("\x1b[?1l"));
    expect(press(core, { key: "ArrowUp", code: "ArrowUp" })).toBe("\x1b[A");
  });

  test("modified arrows carry the xterm modifier parameter", async () => {
    const core = await track();
    expect(press(core, { key: "ArrowUp", code: "ArrowUp", shift: true })).toBe("\x1b[1;2A");
    expect(press(core, { key: "ArrowRight", code: "ArrowRight", alt: true })).toBe("\x1b[1;3C");
  });

  test("option-as-alt sends ESC plus the unshifted key, not the composed character", async () => {
    const core = await track();
    expect(press(core, { key: "∫", code: "KeyB", alt: true })).toBe("\x1bb");
  });

  test("a bare modifier encodes nothing", async () => {
    const core = await track();
    expect(press(core, { key: "Shift", code: "ShiftLeft", shift: true })).toBeNull();
    expect(press(core, { key: "Meta", code: "MetaLeft", meta: true })).toBeNull();
  });

  test("the kitty keyboard protocol engages when the app pushes its flags", async () => {
    const core = await track();
    core.write(bytes("\x1b[>1u")); // push: disambiguate escape codes
    expect(press(core, { key: "Escape", code: "Escape" })).toBe("\x1b[27u");
    expect(press(core, { key: "a", code: "KeyA", ctrl: true })).toBe("\x1b[97;5u");
    core.write(bytes("\x1b[<u")); // pop back to legacy
    expect(press(core, { key: "Escape", code: "Escape" })).toBe("\x1b");
  });

  test("composition in progress encodes nothing", async () => {
    const core = await track();
    expect(core.encodeKey(keyEventFor({ key: "Dead", code: "KeyE", composing: true }))).toBeNull();
  });
});

describe("paste", () => {
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);

  test("reset returns the terminal to a blank ground state — the mid-stream replay baseline", async () => {
    const core = await track(20, 4);
    core.write(bytes("garbled\x1b[?2004h\x1b[?1049h leftovers"));
    expect(core.bracketedPaste()).toBe(true);
    core.reset();
    expect(core.bracketedPaste()).toBe(false);
    expect(core.altScreen()).toBe(false);
    const text = core
      .readAll()
      .rows.map((r) => r.cells.map((c) => c.text).join("").trimEnd())
      .join("");
    expect(text).toBe("");
    core.write(bytes("fresh"));
    expect(rowText(core, 0)).toBe("fresh");
  });

  test("focus reporting encodes CSI I / CSI O", async () => {
    const core = await track();
    const decode = (b: Uint8Array) => new TextDecoder().decode(b);
    expect(core.focusReporting()).toBe(false);
    core.write(bytes("\x1b[?1004h")); // vim, claude-code opt in
    expect(core.focusReporting()).toBe(true);
    expect(decode(core.encodeFocus(true))).toBe("\x1b[I");
    expect(decode(core.encodeFocus(false))).toBe("\x1b[O");
  });

  test("answers the queries agent TUIs make, through onWritePty", async () => {
    const core = await VtCore.create(WASM, 80, 24, undefined, { identity: "mast 9.9.9" });
    open.push(core);
    const replies: string[] = [];
    core.hooks.onWritePty = (b) => replies.push(new TextDecoder().decode(b));
    const ask = (seq: string) => {
      replies.length = 0;
      core.write(bytes(seq));
      return replies.join("");
    };
    expect(ask("\x1b[c")).toBe("\x1b[?62;22c"); // DA1
    expect(ask("\x1b[>c")).toBe("\x1b[>1;0;0c"); // DA2
    expect(ask("\x1b[3;5H\x1b[6n")).toBe("\x1b[3;5R"); // cursor position report
    expect(ask("\x1b[5n")).toBe("\x1b[0n"); // device status
    expect(ask("\x1b[?u")).toBe("\x1b[?0u"); // kitty keyboard flags: none yet
    expect(ask("\x1b[>1u\x1b[?u")).toBe("\x1b[?1u"); // pushed, then queried
    expect(ask("\x1b[?2026$p")).toBe("\x1b[?2026;2$y"); // DECRQM: reset
    expect(ask("\x1b[>q")).toBe("\x1bP>|mast 9.9.9\x1b\\"); // XTVERSION is the embedder
    expect(ask("\x1b[?996n")).toBe("\x1b[?997;1n"); // color scheme: dark by default
    // OSC 10/11 answer with the theme colors the terminal was configured with
    expect(ask("\x1b]11;?\x1b\\")).toBe("\x1b]11;rgb:0b0b/0e0e/1414\x1b\\");
    expect(ask("\x1b]10;?\x07")).toBe("\x1b]10;rgb:dcdc/e0e0/e6e6\x07");
  });

  test("reports its size in cells and pixels once told the cell size", async () => {
    const core = await track(80, 24);
    const replies: string[] = [];
    core.hooks.onWritePty = (b) => replies.push(new TextDecoder().decode(b));
    core.setCellPixels(18, 40);
    core.write(bytes("\x1b[14t\x1b[16t\x1b[18t"));
    expect(replies).toEqual(["\x1b[4;960;1440t", "\x1b[6;40;18t", "\x1b[8;24;80t"]);
    replies.length = 0;
    core.write(bytes("\x1b[?2048h")); // in-band resize: enabling reports once immediately
    expect(replies).toEqual(["\x1b[48;24;80;960;1440t"]);
  });

  test("a light embedder reports a light scheme, and the identity defaults to mast", async () => {
    const core = await VtCore.create(WASM, 10, 2, undefined, { scheme: "light" });
    open.push(core);
    const replies: string[] = [];
    core.hooks.onWritePty = (b) => replies.push(new TextDecoder().decode(b));
    core.write(bytes("\x1b[?996n\x1b[>q"));
    expect(replies).toEqual(["\x1b[?997;2n", "\x1bP>|mast\x1b\\"]);
  });

  test("title changes (OSC 0/2) reach onTitle with the title text", async () => {
    const core = await track(20, 2);
    const titles: string[] = [];
    core.hooks.onTitle = (t) => titles.push(t);
    core.write(bytes("\x1b]0;uday@box: ~/ws\x07\x1b]2;vim README.md\x1b\\"));
    expect(titles).toEqual(["uday@box: ~/ws", "vim README.md"]);
    expect(core.title()).toBe("vim README.md");
  });

  test("OSC 52 writes reach onClipboard decoded; queries and other OSCs do not", async () => {
    const core = await track(20, 2);
    const copied: string[] = [];
    core.hooks.onClipboard = (t) => copied.push(t);
    core.write(bytes("\x1b]52;c;aGVsbG8=\x07")); // "hello"
    core.write(bytes("\x1b]52;c;5LiW55WMIPCfmIA=\x1b\\")); // "世界 😀"
    core.write(bytes("\x1b]52;c;?\x07")); // a read request, ignored
    core.write(bytes("\x1b]0;a title\x07"));
    expect(copied).toEqual(["hello", "世界 😀"]);
  });

  test("an OSC 52 clear reaches onClipboard as the empty string", async () => {
    const core = await track(20, 2);
    const copied: string[] = [];
    core.hooks.onClipboard = (t) => copied.push(t);
    core.write(bytes("\x1b]52;c;\x07"));
    expect(copied).toEqual([""]);
  });

  test("BEL reaches onBell and never the screen", async () => {
    const core = await track(20, 2);
    let bells = 0;
    core.hooks.onBell = () => bells++;
    core.write(bytes("a\x07b\x07"));
    expect(bells).toBe(2);
    expect(rowText(core, 0)).toBe("ab");
  });

  test("mouse reports follow the application's tracking mode and format", async () => {
    const core = await track(40, 10);
    const enc = (spec: Parameters<VtCore["encodeMouse"]>[0]) => {
      const out = core.encodeMouse(spec);
      return out === null ? null : new TextDecoder().decode(out);
    };
    const press = { action: "press", button: "left", mods: 0, x: 2, y: 1 } as const;
    expect(core.mouseTracking()).toBe(false);
    expect(enc(press)).toBeNull(); // nobody asked
    core.write(bytes("\x1b[?1000h\x1b[?1006h")); // normal tracking, SGR format — Claude Code's pair
    expect(core.mouseTracking()).toBe(true);
    expect(enc(press)).toBe("\x1b[<0;3;2M");
    expect(enc({ ...press, action: "release" })).toBe("\x1b[<0;3;2m");
    expect(enc({ ...press, button: "middle" })).toBe("\x1b[<1;3;2M");
    expect(enc({ ...press, button: "wheelUp" })).toBe("\x1b[<64;3;2M");
    expect(enc({ ...press, button: "wheelDown" })).toBe("\x1b[<65;3;2M");
    expect(enc({ ...press, mods: MODS.SHIFT | MODS.CTRL })).toBe("\x1b[<20;3;2M");
    expect(enc({ action: "motion", mods: 0, x: 5, y: 1 })).toBeNull(); // mode 1000 has no motion
    core.write(bytes("\x1b[?1002h")); // button-event tracking: motion while a button is held
    expect(enc({ action: "motion", button: "left", mods: 0, x: 5, y: 1 })).toBe("\x1b[<32;6;2M");
    expect(enc({ action: "motion", mods: 0, x: 6, y: 1 })).toBeNull(); // no button held
    core.write(bytes("\x1b[?1003h")); // any-event tracking: motion with no button too
    expect(enc({ action: "motion", mods: 0, x: 7, y: 1 })).toBe("\x1b[<35;8;2M");
    core.write(bytes("\x1b[?1003l\x1b[?1002l\x1b[?1000l"));
    expect(core.mouseTracking()).toBe(false);
  });

  test("without SGR the legacy X10 byte format is used; with 1016 pixels are reported", async () => {
    const core = await track(40, 10);
    core.write(bytes("\x1b[?1000h"));
    const press = { action: "press", button: "left", mods: 0, x: 2, y: 1 } as const;
    expect(Array.from(core.encodeMouse(press)!)).toEqual([0x1b, 0x5b, 0x4d, 32, 32 + 3, 32 + 2]);
    core.setCellPixels(18, 40);
    core.write(bytes("\x1b[?1016h")); // SGR-pixels: the cell's center in pixels
    expect(new TextDecoder().decode(core.encodeMouse(press)!)).toBe("\x1b[<0;45;60M");
  });

  test("synchronizedOutput tracks mode 2026 around an app's redraw", async () => {
    const core = await vt();
    expect(core.synchronizedOutput()).toBe(false);
    core.write(bytes("\x1b[?2026h"));
    expect(core.synchronizedOutput()).toBe(true);
    core.write(bytes("\x1b[?2026l"));
    expect(core.synchronizedOutput()).toBe(false);
  });

  test("altScreen tracks the application's alternate-screen modes", async () => {
    const core = await track();
    expect(core.altScreen()).toBe(false);
    core.write(bytes("\x1b[?1049h")); // vim, less, claude-code
    expect(core.altScreen()).toBe(true);
    core.write(bytes("\x1b[?1049l"));
    expect(core.altScreen()).toBe(false);
    core.write(bytes("\x1b[?47h")); // the legacy variant
    expect(core.altScreen()).toBe(true);
    core.write(bytes("\x1b[?47l"));
    expect(core.altScreen()).toBe(false);
  });

  test("bracketed paste mode tracks the application's own requests", async () => {
    const core = await track();
    expect(core.bracketedPaste()).toBe(false);
    core.write(bytes("\x1b[?2004h")); // what vim/zsh/claude-code send on startup
    expect(core.bracketedPaste()).toBe(true);
    core.write(bytes("\x1b[?2004l"));
    expect(core.bracketedPaste()).toBe(false);
  });

  test("unbracketed paste converts newlines to carriage returns", async () => {
    const core = await track();
    expect(decode(core.encodePaste("echo a\necho b"))).toBe("echo a\recho b");
  });

  test("bracketed paste wraps the text so the app sees one paste, not keystrokes", async () => {
    const core = await track();
    core.write(bytes("\x1b[?2004h"));
    expect(decode(core.encodePaste("echo a\necho b"))).toBe("\x1b[200~echo a\necho b\x1b[201~");
  });

  test("escape bytes are stripped, so pasted text cannot inject sequences", async () => {
    const core = await track();
    core.write(bytes("\x1b[?2004h"));
    const encoded = decode(core.encodePaste("a\x1b[201~b"));
    expect(encoded.startsWith("\x1b[200~")).toBe(true);
    expect(encoded.endsWith("\x1b[201~")).toBe(true);
    // The paste body carries no ESC of its own — the terminator can't be forged from inside.
    expect(encoded.slice(6, -6)).not.toContain("\x1b");
    expect(encoded.slice(6, -6)).toContain("[201~b");
  });

  test("a large paste survives the round trip intact", async () => {
    const core = await track();
    const text = "x".repeat(100_000);
    expect(decode(core.encodePaste(text))).toBe(text);
  });
});
