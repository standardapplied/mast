import { afterEach, describe, expect, test } from "bun:test";
import { bindPage, invoke, restartPage, unbindPage } from "./core";

type Sent = { cmd: string; headers: Record<string, string> };

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (...args: unknown[]) => unknown } };

function stubCore(): Sent[] {
  const sent: Sent[] = [];
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: (cmd: unknown, _args: unknown, options: unknown) => {
      sent.push({ cmd: cmd as string, headers: (options as { headers: Record<string, string> }).headers });
      return Promise.resolve(null);
    },
  };
  return sent;
}

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  unbindPage();
});

describe("the page's line to the core", () => {
  test("a page is for the first backend named to it, and for no other after", () => {
    expect(bindPage(undefined), "no backend yet is not another backend").toBe(true);
    expect(bindPage(7)).toBe(true);
    expect(bindPage(7)).toBe(true);
    expect(bindPage(8)).toBe(false);
    expect(bindPage(undefined), "its backend is gone").toBe(false);
    expect(bindPage(7), "a later name never rebinds it").toBe(true);
  });

  test("every command names the page's backend beside the headers it already carries", async () => {
    const sent = stubCore();
    await invoke("session_list", { socketPath: "~/.sail/pty.sock", token: "" });
    bindPage(7);
    await invoke("session_kill", { session: "room-design-talk" });
    await invoke("session_write", new Uint8Array([97]), { headers: { "x-mast-session": "pane-1" } });

    expect(sent).toEqual([
      { cmd: "session_list", headers: {} },
      { cmd: "session_kill", headers: { "x-mast-backend": "7" } },
      { cmd: "session_write", headers: { "x-mast-session": "pane-1", "x-mast-backend": "7" } },
    ]);
  });

  test("a restart leaves the next page nothing that named the box before it", async () => {
    const reload = window.location.reload;
    let reloads = 0;
    window.location.reload = () => void (reloads += 1);
    try {
      window.location.hash = "#/spec/a-spec-of-the-box-before";
      sessionStorage.setItem("mast.board.project", "a-project-of-the-box-before");
      let settled = false;
      void restartPage().finally(() => (settled = true));

      for (let i = 0; i < 10; i++) await Promise.resolve();

      expect(reloads).toBe(1);
      expect(window.location.hash).toBe("");
      expect(sessionStorage.getItem("mast.board.project")).toBeNull();
      expect(settled, "the page that asked has nothing to do next").toBe(false);
    } finally {
      window.location.reload = reload;
    }
  });
});
