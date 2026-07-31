import { describe, expect, test } from "bun:test";
import { dispatchPush, onPush } from "./push";

describe("push re-dispatch", () => {
  test("dispatchPush emits an rpc:* CustomEvent carrying the payload", () => {
    let detail: unknown;
    const listener = (e: Event) => (detail = (e as CustomEvent).detail);
    window.addEventListener("rpc:update-status", listener);
    dispatchPush("update-status", { status: "downloading", message: "42%" });
    window.removeEventListener("rpc:update-status", listener);
    expect(detail).toEqual({ status: "downloading", message: "42%" });
  });

  test("onPush subscribes, then the returned fn unsubscribes", () => {
    const seen: string[] = [];
    const off = onPush("update-status", (p) => seen.push(p.status));
    dispatchPush("update-status", { status: "checking", message: "" });
    off();
    dispatchPush("update-status", { status: "ready", message: "" });
    expect(seen).toEqual(["checking"]);
  });
});
