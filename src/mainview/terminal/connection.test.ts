import { describe, expect, test } from "bun:test";
import {
  isUnwell,
  Reconnector,
  type SessionStatus,
  STABLE_MS,
  statusEqual,
  toSessionEnd,
  worstStatus,
} from "./connection";

describe("toSessionEnd", () => {
  test("the structured payload the Rust side emits passes through", () => {
    expect(toSessionEnd({ class: "ended", reason: "exited(0)" })).toEqual({
      klass: "ended",
      reason: "exited(0)",
    });
    expect(toSessionEnd({ class: "transport", reason: "Disconnected" })).toEqual({
      klass: "transport",
      reason: "Disconnected",
    });
    expect(toSessionEnd({ class: "refused", reason: "attach: session belongs to mady" })).toEqual({
      klass: "refused",
      reason: "attach: session belongs to mady",
    });
  });

  test("anything unrecognized is treated as a transport drop — the retryable default", () => {
    expect(toSessionEnd("Connection reset by peer")).toEqual({
      klass: "transport",
      reason: "Connection reset by peer",
    });
    expect(toSessionEnd({ class: "shrug", reason: "?" }).klass).toBe("transport");
    expect(toSessionEnd(null).klass).toBe("transport");
    expect(toSessionEnd(42)).toEqual({ klass: "transport", reason: "42" });
  });
});

describe("Reconnector", () => {
  const at = (t: { ms: number }) => new Reconnector(() => t.ms);

  test("backs off exponentially across consecutive failures", () => {
    const clock = { ms: 0 };
    const r = at(clock);
    expect(r.lost()).toBe(500);
    expect(r.lost()).toBe(1000);
    expect(r.lost()).toBe(2000);
    expect(r.lost()).toBe(4000);
    expect(r.lost()).toBe(8000);
    expect(r.lost()).toBe(15000);
  });

  test("caps the delay instead of growing forever", () => {
    const r = at({ ms: 0 });
    for (let i = 0; i < 20; i++) r.lost();
    expect(r.lost()).toBe(15000);
  });

  test("a stable connection resets the ladder; a flapping one does not", () => {
    const clock = { ms: 0 };
    const r = at(clock);
    r.lost();
    r.lost();
    r.opened();
    clock.ms += STABLE_MS; // held long enough to trust the link again
    expect(r.lost()).toBe(500);

    r.opened();
    clock.ms += 1000; // dropped again almost immediately — keep escalating
    expect(r.lost()).toBe(1000);
  });

  test("a failure before any successful open keeps escalating", () => {
    const r = at({ ms: 0 });
    expect(r.lost()).toBe(500);
    expect(r.lost()).toBe(1000);
  });

  test("reset starts the ladder over (manual reconnect)", () => {
    const r = at({ ms: 0 });
    r.lost();
    r.lost();
    r.reset();
    expect(r.lost()).toBe(500);
  });
});

describe("worstStatus", () => {
  const up: SessionStatus = { kind: "up" };
  const first: SessionStatus = { kind: "connecting", retrying: false };
  const retrying: SessionStatus = { kind: "connecting", retrying: true };
  const down: SessionStatus = { kind: "down", reason: "transport error: gone" };
  const ended: SessionStatus = { kind: "ended", reason: "exited(0)" };
  const failed: SessionStatus = { kind: "failed", reason: "no webgpu" };

  test("a tab reports its most broken pane", () => {
    expect(worstStatus([up, up])).toEqual(up);
    expect(worstStatus([up, first])).toEqual(first);
    expect(worstStatus([first, retrying])).toEqual(retrying);
    expect(worstStatus([up, retrying, ended])).toEqual(ended);
    expect(worstStatus([ended, down, up])).toEqual(down);
    expect(worstStatus([down, failed])).toEqual(failed);
  });

  test("no panes reads as a quiet first connect", () => {
    expect(worstStatus([])).toEqual(first);
  });

  test("isUnwell flags everything except live and a quiet first connect", () => {
    expect(isUnwell(up)).toBe(false);
    expect(isUnwell(first)).toBe(false);
    expect(isUnwell(retrying)).toBe(true);
    expect(isUnwell(down)).toBe(true);
    expect(isUnwell(ended)).toBe(true);
    expect(isUnwell(failed)).toBe(true);
  });

  test("statusEqual compares structure, not identity", () => {
    expect(statusEqual({ kind: "up" }, { kind: "up" })).toBe(true);
    expect(statusEqual(first, { ...first })).toBe(true);
    expect(statusEqual(first, retrying)).toBe(false);
    expect(statusEqual(down, { kind: "down", reason: down.reason })).toBe(true);
    expect(statusEqual(down, { kind: "down", reason: "other" })).toBe(false);
    expect(statusEqual(down, failed)).toBe(false);
  });
});
