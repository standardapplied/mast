import { describe, expect, test } from "bun:test";
import {
  absenceReason,
  HOST_RESTARTED,
  isUnwell,
  NOT_RUNNING,
  Reconnector,
  resolveTransportEnd,
  type SessionEnd,
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
  const ended: SessionStatus = { kind: "ended", reason: "exited(0)", disposition: "close-pane" };
  const failed: SessionStatus = { kind: "failed", reason: "no webgpu" };

  test("a tab reports its most broken pane", () => {
    expect(worstStatus([up, up])).toEqual(up);
    expect(worstStatus([up, first])).toEqual(first);
    expect(worstStatus([first, retrying])).toEqual(retrying);
    expect(worstStatus([up, retrying, ended])).toEqual(ended);
    expect(worstStatus([ended, down, up])).toEqual(down);
    expect(worstStatus([down, failed])).toEqual(failed);
  });

  test("no panes reads as no status at all — an empty tab shows no cluster", () => {
    expect(worstStatus([])).toBeNull();
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

  test("an ending's disposition is part of its identity — a parked card is not a closed pane", () => {
    expect(statusEqual(ended, { ...ended })).toBe(true);
    expect(statusEqual(ended, { ...ended, disposition: "park-card" })).toBe(false);
  });
});

describe("absenceReason", () => {
  test("a changed boot id proves the host restarted; anything less is just not running", () => {
    expect(absenceReason("boot-1", "boot-2")).toBe(HOST_RESTARTED);
    expect(absenceReason("boot-1", "boot-1")).toBe(NOT_RUNNING);
    expect(absenceReason(undefined, "boot-2")).toBe(NOT_RUNNING);
    expect(absenceReason("boot-1", null)).toBe(NOT_RUNNING);
    expect(absenceReason("", "")).toBe(NOT_RUNNING);
  });
});

describe("resolveTransportEnd — one reconcile listing before any backoff", () => {
  const lost: SessionEnd = { klass: "transport", reason: "channel closed" };
  const listing = (live: boolean, hostBootId = "boot-1") => ({
    hostBootId,
    sessions: [{ name: "mast-a", live }],
  });

  test("the session is listed live: a genuine link loss, reconnect on the backoff", () => {
    expect(resolveTransportEnd(lost, "mast-a", "boot-1", listing(true))).toEqual(lost);
  });

  test("the listing itself is unreachable: the link IS down, reconnect on the backoff", () => {
    expect(resolveTransportEnd(lost, "mast-a", "boot-1", null)).toEqual(lost);
  });

  test("the session is listed dead: it ended — park, never retry", () => {
    expect(resolveTransportEnd(lost, "mast-a", "boot-1", listing(false))).toEqual({
      klass: "ended",
      reason: "ended",
    });
  });

  test("the session is absent under the same boot: not running — park", () => {
    expect(
      resolveTransportEnd(lost, "mast-a", "boot-1", { hostBootId: "boot-1", sessions: [] }),
    ).toEqual({ klass: "ended", reason: NOT_RUNNING });
  });

  test("the session is absent under a new boot: the host restarted — park with that reason", () => {
    expect(
      resolveTransportEnd(lost, "mast-a", "boot-1", { hostBootId: "boot-2", sessions: [] }),
    ).toEqual({ klass: "ended", reason: HOST_RESTARTED });
  });

  test("a listed-live session under a new boot is still live — the name was recreated; reconnect", () => {
    expect(resolveTransportEnd(lost, "mast-a", "boot-1", listing(true, "boot-2"))).toEqual(lost);
  });

  test("an ending that was never a transport drop passes through untouched", () => {
    const ended: SessionEnd = { klass: "ended", reason: "exited(0)" };
    expect(resolveTransportEnd(ended, "mast-a", "boot-1", null)).toEqual(ended);
    const refused: SessionEnd = { klass: "refused", reason: "no" };
    expect(resolveTransportEnd(refused, "mast-a", "boot-1", listing(false))).toEqual(refused);
  });
});
