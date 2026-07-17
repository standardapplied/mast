import { describe, expect, test } from "bun:test";
import { DEFAULT_WIDTHS, loadWidths, PANE_LIMITS, saveWidths } from "./workbenchLayout";

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

describe("workbench layout persistence", () => {
  test("defaults when nothing is stored", () => {
    expect(loadWidths(fakeStorage(), "devbox-a")).toEqual(DEFAULT_WIDTHS);
  });

  test("round-trips widths per target", () => {
    const storage = fakeStorage();
    saveWidths(storage, "devbox-a", { tree: 250, viewer: 600 });
    expect(loadWidths(storage, "devbox-a")).toEqual({ tree: 250, viewer: 600 });
    expect(loadWidths(storage, "devbox-b")).toEqual(DEFAULT_WIDTHS);
    expect(Object.keys(storage.dump())).toEqual(["mast.workbench.devbox-a"]);
  });

  test("clamps stored values back into pane limits", () => {
    const storage = fakeStorage({
      "mast.workbench.t": JSON.stringify({ tree: 5, viewer: 99999 }),
    });
    expect(loadWidths(storage, "t")).toEqual({
      tree: PANE_LIMITS.tree.min,
      viewer: PANE_LIMITS.viewer.max,
    });
  });

  test("garbage in storage falls back to defaults", () => {
    const storage = fakeStorage({ "mast.workbench.t": "not json" });
    expect(loadWidths(storage, "t")).toEqual(DEFAULT_WIDTHS);
  });
});
