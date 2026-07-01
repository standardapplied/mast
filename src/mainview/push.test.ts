import { describe, expect, test } from "bun:test";
import { dispatchPush, onPush } from "./push";

describe("push re-dispatch", () => {
  test("dispatchPush emits an rpc:* CustomEvent carrying the payload", () => {
    let detail: unknown;
    const listener = (e: Event) => (detail = (e as CustomEvent).detail);
    window.addEventListener("rpc:bridge-status", listener);
    dispatchPush("bridge-status", { status: "reconnecting" });
    window.removeEventListener("rpc:bridge-status", listener);
    expect(detail).toEqual({ status: "reconnecting" });
  });

  test("onPush subscribes, then the returned fn unsubscribes", () => {
    const seen: string[] = [];
    const off = onPush("bridge-status", (p) => seen.push(p.status));
    dispatchPush("bridge-status", { status: "connected" });
    off();
    dispatchPush("bridge-status", { status: "disconnected" });
    expect(seen).toEqual(["connected"]);
  });
});
