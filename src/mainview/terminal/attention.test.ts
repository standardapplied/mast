import { afterEach, describe, expect, test } from "bun:test";
import type { AttentionRequest } from "./terminalServices";
import { attentionFor, attentionStore, BELL_SETTINGS, type BellSetting, RING_COALESCE_MS, STORAGE_KEY } from "./attention";

afterEach(() => attentionStore.reset());

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

function connect(seed?: Record<string, string>) {
  const calls: AttentionRequest[] = [];
  let clock = 10_000;
  const storage = memoryStorage(seed);
  attentionStore.connect(storage, async (r) => void calls.push(r), () => clock);
  return { calls, storage, tick: (ms: number) => (clock += ms) };
}

const unfocused = { paneFocused: false, windowFocused: true, muted: false };

describe("attentionFor", () => {
  test("a focused pane in a focused window, or a muted pane, flashes only under every setting", () => {
    for (const setting of BELL_SETTINGS) {
      expect(attentionFor(setting, { paneFocused: true, windowFocused: true, muted: false })).toBeNull();
      for (const paneFocused of [true, false]) {
        for (const windowFocused of [true, false]) {
          expect(attentionFor(setting, { paneFocused, windowFocused, muted: true })).toBeNull();
        }
      }
    }
  });

  test("an unseen bell rings what the setting says, whether the pane or the window lost focus", () => {
    const rings: Record<BellSetting, { sound: boolean; bounce: boolean }> = {
      "sound+bounce": { sound: true, bounce: true },
      sound: { sound: true, bounce: false },
      bounce: { sound: false, bounce: true },
      flash: { sound: false, bounce: false },
    };
    for (const setting of BELL_SETTINGS) {
      for (const facts of [
        { paneFocused: false, windowFocused: true },
        { paneFocused: true, windowFocused: false },
        { paneFocused: false, windowFocused: false },
      ]) {
        expect(attentionFor(setting, { ...facts, muted: false })).toEqual(rings[setting]);
      }
    }
  });
});

describe("attentionStore", () => {
  test("the setting seeds from storage, defaults to Ghostty's, and writes back", () => {
    let { storage } = connect({ [STORAGE_KEY]: "bounce" });
    expect(attentionStore.bell()).toBe("bounce");
    attentionStore.setBell("flash");
    expect(storage.map.get(STORAGE_KEY)).toBe("flash");
    ({ storage } = connect({ [STORAGE_KEY]: "loud" }));
    expect(attentionStore.bell()).toBe("sound+bounce");
  });

  test("an unseen ring joins the set, badges its size, and is seen on focus", () => {
    const { calls } = connect();
    attentionStore.ring("a", unfocused);
    expect([...attentionStore.unseen()]).toEqual(["a"]);
    expect(calls).toEqual([{ sound: true, bounce: true, badge: 1 }]);
    attentionStore.ring("b", { ...unfocused, paneFocused: true, windowFocused: false });
    expect([...attentionStore.unseen()]).toEqual(["a", "b"]);
    expect(calls.at(-1)).toEqual({ sound: true, bounce: true, badge: 2 });
    attentionStore.seen("a");
    expect([...attentionStore.unseen()]).toEqual(["b"]);
    expect(calls.at(-1)).toEqual({ sound: false, bounce: false, badge: 1 });
    attentionStore.seen("b");
    expect(attentionStore.unseen().size).toBe(0);
    expect(calls.at(-1)).toEqual({ sound: false, bounce: false, badge: null });
    expect(calls).toHaveLength(4);
  });

  test("a seen or muted bell changes nothing and calls nothing", () => {
    const { calls } = connect();
    attentionStore.ring("a", { paneFocused: true, windowFocused: true, muted: false });
    attentionStore.ring("a", { ...unfocused, muted: true });
    expect(attentionStore.unseen().size).toBe(0);
    expect(calls).toEqual([]);
    attentionStore.seen("a");
    attentionStore.forget(["a"]);
    expect(calls).toEqual([]);
  });

  test("a looping bell rings once per two seconds per pane; a badge change still lands", () => {
    const { calls, tick } = connect();
    for (let i = 0; i < 5; i++) attentionStore.ring("a", unfocused);
    expect(calls).toHaveLength(1);
    tick(RING_COALESCE_MS - 1);
    attentionStore.ring("a", unfocused);
    expect(calls).toHaveLength(1);
    tick(1);
    attentionStore.ring("a", unfocused);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ sound: true, bounce: true, badge: 1 });
    attentionStore.seen("a");
    attentionStore.ring("a", unfocused);
    expect(calls.at(-1)).toEqual({ sound: false, bounce: false, badge: 1 });
    attentionStore.ring("b", unfocused);
    expect(calls.at(-1)).toEqual({ sound: true, bounce: true, badge: 2 });
  });

  test("the flash setting keeps the dot and the badge, rings nothing", () => {
    const { calls } = connect({ [STORAGE_KEY]: "flash" });
    attentionStore.ring("a", unfocused);
    expect([...attentionStore.unseen()]).toEqual(["a"]);
    expect(calls).toEqual([{ sound: false, bounce: false, badge: 1 }]);
  });

  test("a closed pane is forgotten: its dot, its badge, its coalescing window", () => {
    const { calls } = connect();
    attentionStore.ring("a", unfocused);
    attentionStore.forget(["a", "never"]);
    expect(attentionStore.unseen().size).toBe(0);
    expect(calls.at(-1)).toEqual({ sound: false, bounce: false, badge: null });
    attentionStore.ring("a", unfocused);
    expect(calls.at(-1)).toEqual({ sound: true, bounce: true, badge: 1 });
  });

  test("subscribers hear the set and the setting change", () => {
    connect();
    let heard = 0;
    const off = attentionStore.subscribe(() => heard++);
    attentionStore.ring("a", unfocused);
    attentionStore.setBell("sound");
    attentionStore.setBell("sound");
    expect(heard).toBe(2);
    off();
    attentionStore.seen("a");
    expect(heard).toBe(2);
  });
});
