import { describe, expect, test } from "bun:test";
import { createPeek, PEEK_CLOSE_DELAY_MS, PEEK_OPEN_DELAY_MS, type PeekState } from "./peek";

/** A hand-cranked scheduler: fire(ms) runs everything due at or before ms. */
function fakeClock() {
  let now = 0;
  const pending: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  return {
    schedule(fn: () => void, ms: number) {
      const entry = { at: now + ms, fn, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const entry of [...pending]) {
        if (entry.cancelled || entry.at > now) continue;
        pending.splice(pending.indexOf(entry), 1);
        entry.fn();
      }
    },
  };
}

function harness() {
  const clock = fakeClock();
  const states: PeekState[] = [];
  const peek = createPeek((state) => states.push(state), clock.schedule);
  return { clock, states, peek };
}

describe("createPeek", () => {
  test("hover peeks only after the open delay", () => {
    const { clock, peek } = harness();
    peek.enterTrigger();
    clock.advance(PEEK_OPEN_DELAY_MS - 1);
    expect(peek.state()).toBe("closed");
    clock.advance(1);
    expect(peek.state()).toBe("peek");
  });

  test("a quick pass over the trigger never opens", () => {
    const { clock, peek } = harness();
    peek.enterTrigger();
    clock.advance(100);
    peek.leave();
    clock.advance(PEEK_OPEN_DELAY_MS * 2);
    expect(peek.state()).toBe("closed");
  });

  test("leaving a peek closes after the grace delay, unless the panel catches it", () => {
    const { clock, peek } = harness();
    peek.enterTrigger();
    clock.advance(PEEK_OPEN_DELAY_MS);
    peek.leave();
    clock.advance(PEEK_CLOSE_DELAY_MS - 1);
    peek.enterPanel();
    clock.advance(PEEK_CLOSE_DELAY_MS * 2);
    expect(peek.state(), "the grace path into the panel forgives the leave").toBe("peek");
    peek.leave();
    clock.advance(PEEK_CLOSE_DELAY_MS);
    expect(peek.state()).toBe("closed");
  });

  test("click pins: it opens immediately and survives leaving", () => {
    const { clock, peek } = harness();
    peek.click();
    expect(peek.state()).toBe("pinned");
    peek.leave();
    clock.advance(PEEK_CLOSE_DELAY_MS * 2);
    expect(peek.state()).toBe("pinned");
    peek.click();
    expect(peek.state()).toBe("closed");
  });

  test("clicking a peek upgrades it to pinned", () => {
    const { clock, peek } = harness();
    peek.enterTrigger();
    clock.advance(PEEK_OPEN_DELAY_MS);
    peek.click();
    expect(peek.state()).toBe("pinned");
  });

  test("dismiss closes even a pinned popover and cancels pending opens", () => {
    const { clock, peek } = harness();
    peek.click();
    peek.dismiss();
    expect(peek.state()).toBe("closed");
    peek.enterTrigger();
    peek.dismiss();
    clock.advance(PEEK_OPEN_DELAY_MS * 2);
    expect(peek.state()).toBe("closed");
  });
});
