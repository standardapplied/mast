import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GHOSTTY_KEY } from "./input";
import { GHOSTTY_SEARCH } from "./vtCore";

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

describe("vendored search.h parity", () => {
  /** The `NAME = value` entries of one enum, MAX_VALUE excluded — the values are explicit there. */
  const enumValues = (typeName: string, prefix: string): Record<string, number> => {
    const block = headers("search.h").match(new RegExp(`typedef enum GHOSTTY_ENUM_TYPED \\{([^{}]*)\\} ${typeName};`))![1]!;
    const entries = [...block.matchAll(new RegExp(`${prefix}([A-Z_]+) = (\\d+)`, "g"))].map(
      (m) => [m[1]!, Number(m[2])] as const,
    );
    expect(entries.length).toBeGreaterThan(0);
    return Object.fromEntries(entries);
  };

  test("GHOSTTY_SEARCH mirrors the option, data, status and scroll enums entry for entry", () => {
    const mirror: Record<string, Record<string, number>> = GHOSTTY_SEARCH;
    expect(mirror.OPT).toEqual(enumValues("GhosttySearchOption", "GHOSTTY_SEARCH_OPT_"));
    expect(mirror.DATA).toEqual(enumValues("GhosttySearchData", "GHOSTTY_SEARCH_DATA_"));
    expect(mirror.STATUS).toEqual(enumValues("GhosttySearchStatus", "GHOSTTY_SEARCH_STATUS_"));
    expect(mirror.SCROLL).toEqual(enumValues("GhosttySearchScroll", "GHOSTTY_SEARCH_SCROLL_"));
  });
});
