import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GHOSTTY_KEY } from "./input";

/**
 * Mechanical parity between the hand-written TS mirrors and the vendored C headers (see PIN.md).
 * The GhosttyKey enum has implicit ordinals — the declaration order IS the ABI — so a re-pin that
 * inserts a key mid-enum must fail here, not silently send wrong keys for everything after it.
 */

const headers = (name: string) =>
  readFileSync(join(import.meta.dir, "ghostty-vt-headers", name), "utf8");

/** GHOSTTY_KEY_SNAKE_CASE → the W3C KeyboardEvent.code spelling the TS mirror uses. */
function w3cName(snake: string): string {
  if (/^[A-Z]$/.test(snake)) return `Key${snake}`;
  return snake
    .split("_")
    .map((tok) => tok[0] + tok.slice(1).toLowerCase())
    .join("");
}

describe("vendored header parity", () => {
  test("GHOSTTY_KEY mirrors the GhosttyKey enum, entry for entry, in order", () => {
    // Enum bodies contain no braces, so [^{}]* anchors to the nearest opening brace — a lazy
    // [\s\S]*? would swallow every earlier enum in the file.
    const enumBlock = headers("key_event.h").match(
      /typedef enum GHOSTTY_ENUM_TYPED \{([^{}]*)\} GhosttyKey;/,
    )![1]!;
    const fromHeader = [...enumBlock.matchAll(/GHOSTTY_KEY_([A-Z0-9_]+)/g)]
      .map((m) => m[1]!)
      .filter((n) => n !== "MAX_VALUE")
      .map(w3cName);
    expect(GHOSTTY_KEY).toEqual(fromHeader);
  });

  test("the encoder option ordinal for macos-option-as-alt matches the header", () => {
    const m = headers("key_encoder.h").match(
      /GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT = (\d+)/,
    );
    // vtCore.ts KEY_OPT_MACOS_OPTION_AS_ALT must equal this; it is private, so pin the source.
    expect(m![1]).toBe("6");
    expect(readFileSync(join(import.meta.dir, "vtCore.ts"), "utf8")).toContain(
      "const KEY_OPT_MACOS_OPTION_AS_ALT = 6",
    );
  });

  test("the key action values match the header", () => {
    const block = headers("key_event.h").match(
      /typedef enum GHOSTTY_ENUM_TYPED \{([^{}]*)\} GhosttyKeyAction;/,
    )![1]!;
    expect(block).toContain("GHOSTTY_KEY_ACTION_RELEASE = 0");
    expect(block).toContain("GHOSTTY_KEY_ACTION_PRESS = 1");
    expect(block).toContain("GHOSTTY_KEY_ACTION_REPEAT = 2");
  });

  test("the modifier bits match the header", () => {
    const h = headers("key_event.h");
    expect(h).toContain("GHOSTTY_MODS_SHIFT (1 << 0)");
    expect(h).toContain("GHOSTTY_MODS_CTRL (1 << 1)");
    expect(h).toContain("GHOSTTY_MODS_ALT (1 << 2)");
    expect(h).toContain("GHOSTTY_MODS_SUPER (1 << 3)");
    expect(h).toContain("GHOSTTY_MODS_CAPS_LOCK (1 << 4)");
    expect(h).toContain("GHOSTTY_MODS_NUM_LOCK (1 << 5)");
  });
});
