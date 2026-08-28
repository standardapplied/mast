import { describe, expect, test } from "bun:test";
import { classifyEnd, Reconnector, STABLE_MS } from "./connection";

describe("classifyEnd", () => {
  test("a transport failure is reconnectable", () => {
    expect(classifyEnd("transport error: Connection reset by peer")).toBe("transport");
    expect(classifyEnd("transport error: Disconnected")).toBe("transport");
  });

  test("a shell exit is a clean end", () => {
    expect(classifyEnd("exited(0)")).toBe("clean");
    expect(classifyEnd("exited(137)")).toBe("clean");
  });

  test("a host-side failure reason is a clean end (the session is gone, not the link)", () => {
    expect(classifyEnd("pty read failed: EIO")).toBe("clean");
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
