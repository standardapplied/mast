import { describe, expect, test } from "bun:test";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_PX,
  TERMINAL_LINE_PAD,
  TERMINAL_PAD_X,
  TERMINAL_PAD_Y,
} from "./metrics";

/**
 * The glyph-fidelity regression guard (mast-room-terminal-ux, Brick D): the room stage
 * and the Terminal view must render with identical font metrics. Both go through
 * SessionTerminalPane, so the guard is twofold — the constants themselves are pinned,
 * and the pane is pinned to source them from the one metrics module instead of
 * redeclaring its own.
 */

describe("terminal font metrics", () => {
  test("the metrics are pinned", () => {
    expect(TERMINAL_FONT_FAMILY).toBe('"JetBrains Mono", ui-monospace, "SF Mono", monospace');
    expect(TERMINAL_FONT_PX).toBe(15);
    expect(TERMINAL_LINE_PAD).toBe(0.25);
    expect(TERMINAL_PAD_X).toBe(10);
    expect(TERMINAL_PAD_Y).toBe(8);
  });

  test("SessionTerminalPane sources its metrics from this module alone", async () => {
    // The pane imports @tauri-apps/* so it cannot load under bun test; pin its source.
    const source = await Bun.file(
      new URL("../tauri/SessionTerminalPane.tsx", import.meta.url).pathname,
    ).text();
    expect(source).toContain('from "../terminal/metrics"');
    expect(source).not.toMatch(/const FONT_PX\s*=/);
    expect(source).not.toMatch(/const FONT_FAMILY\s*=/);
    expect(source).not.toMatch(/const LINE_PAD\s*=/);
    expect(source).not.toMatch(/const PAD_[XY]\s*=/);
  });
});
