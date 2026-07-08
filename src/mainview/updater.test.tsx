import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useUpdater, type PendingUpdate, type Updater, type UpdaterView } from "./updater";

let root: Root;
let container: HTMLElement;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(updater?: Updater) {
  let latest!: UpdaterView;
  function Harness() {
    latest = useUpdater(updater);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
  return { view: () => latest };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function fakeUpdater(over: Partial<Updater> = {}): Updater {
  return {
    currentVersion: async () => "0.1.0",
    check: async () => null,
    relaunch: async () => {},
    openReleases: async () => {},
    ...over,
  };
}

describe("useUpdater", () => {
  test("no updater injected → disabled, idle, no work", () => {
    const { view } = render();
    expect(view().enabled).toBe(false);
    expect(view().phase).toBe("idle");
  });

  test("manual check finds an update → available → install → ready", async () => {
    let installed = false;
    const pending: PendingUpdate = {
      version: "0.2.0",
      install: async (onProgress) => {
        onProgress(0.5);
        installed = true;
        onProgress(1);
      },
    };
    const { view } = render(fakeUpdater({ check: async () => pending }));
    expect(view().enabled).toBe(true);

    await act(async () => {
      view().check();
      await settle();
    });
    expect(view().phase).toBe("available");
    expect(view().available).toBe("0.2.0");

    await act(async () => {
      view().install();
      await settle();
    });
    expect(installed).toBe(true);
    expect(view().phase).toBe("ready");
  });

  test("manual check with no update → current", async () => {
    const { view } = render(fakeUpdater({ check: async () => null }));
    await act(async () => {
      view().check();
      await settle();
    });
    expect(view().phase).toBe("current");
  });

  test("a failed check surfaces the error phase", async () => {
    const { view } = render(
      fakeUpdater({
        check: async () => {
          throw new Error("offline");
        },
      }),
    );
    await act(async () => {
      view().check();
      await settle();
    });
    expect(view().phase).toBe("error");
  });
});
