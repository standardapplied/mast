import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SailResult } from "../../shared/types";
import type { Gateway } from "../gateway";
import type { PortalPort, PortalView } from "./portal";
import { PortalPanel } from "./PortalPanel";

let root: Root;
let container: HTMLElement;

const port = (over: Partial<PortalPort> & Pick<PortalPort, "name" | "port">): PortalPort => ({
  kind: "process",
  state: "listening",
  exitCode: null,
  detail: null,
  localPort: over.port,
  ...over,
});

const view = (ports: PortalPort[], over: Partial<PortalView> = {}): PortalView => ({
  project: "acme",
  ports,
  url: null,
  settled: true,
  ...over,
});

const SETTLED = view(
  [
    port({ name: "web", port: 3000, localPort: 3001 }),
    port({ name: "postgres", port: 5432, kind: "service" }),
    port({
      name: "worker",
      port: 8080,
      state: "exited",
      exitCode: 1,
      detail: "Error: Cannot find module 'bullmq'",
      localPort: null,
    }),
  ],
  { url: "http://127.0.0.1:3001" },
);

const STARTING = view(
  [
    port({ name: "web", port: 3000, state: "starting", localPort: null }),
    port({ name: "postgres", port: 5432, kind: "service" }),
  ],
  { settled: false },
);

function harness(answers: { open: SailResult<PortalView>; refresh?: SailResult<PortalView>[] }) {
  const opened: string[] = [];
  const copied: string[] = [];
  const scheduled: (() => void)[] = [];
  const calls = { open: 0, refresh: 0, stop: 0 };
  const refreshes = [...(answers.refresh ?? [])];
  const gateway = {
    portalOpen: async () => {
      calls.open += 1;
      return answers.open;
    },
    portalRefresh: async () => {
      calls.refresh += 1;
      return refreshes.shift() ?? answers.open;
    },
    portalStop: async () => {
      calls.stop += 1;
      return {
        ok: true as const,
        value: view([port({ name: "web", port: 3000, state: "stopped", localPort: null })]),
      };
    },
  } as unknown as Gateway;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <PortalPanel
        gateway={gateway}
        project="acme"
        openUrl={async (url) => {
          opened.push(url);
        }}
        copyText={async (text) => {
          copied.push(text);
        }}
        schedule={(run) => {
          scheduled.push(run);
          return () => {};
        }}
        onClose={() => {}}
      />,
    ),
  );
  return { opened, copied, scheduled, calls };
}

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};

const find = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("PortalPanel", () => {
  test("opening brings the stack up and opens the first process that listens, once", async () => {
    const h = harness({ open: { ok: true, value: SETTLED } });
    await settle();

    expect(h.calls.open).toBe(1);
    expect(h.opened).toEqual(["http://127.0.0.1:3001"]);
    expect(find("portal-headline")?.textContent).toBe(
      "Opened http://127.0.0.1:3001 in your browser. The ports stay forwarded while Mast is connected.",
    );
    expect(find("portal-port-web")?.textContent).toContain("3000 → 3001");
    expect(h.scheduled).toHaveLength(0);
  });

  test("a port that exited shows its last line and Copy puts it on the clipboard", async () => {
    const h = harness({ open: { ok: true, value: SETTLED } });
    await settle();

    expect(find("portal-detail-worker")?.textContent).toBe(
      "exited 1: Error: Cannot find module 'bullmq'",
    );
    const copy = find("portal-port-worker")?.querySelector("button");
    await act(async () => copy!.click());

    expect(h.copied).toEqual(["acme worker 8080 exited 1: Error: Cannot find module 'bullmq'"]);
    expect(copy?.textContent).toBe("Copied");
  });

  test("a service shows the address a client on this Mac reaches it at", async () => {
    const h = harness({ open: { ok: true, value: SETTLED } });
    await settle();

    await act(async () => button("Copy address")!.click());

    expect(h.copied).toEqual(["127.0.0.1:5432"]);
  });

  test("a port still starting is looked at again until it settles, then the browser opens", async () => {
    const h = harness({
      open: { ok: true, value: STARTING },
      refresh: [
        { ok: true, value: STARTING },
        { ok: true, value: view([port({ name: "web", port: 3000 })], { url: "http://127.0.0.1:3000" }) },
      ],
    });
    await settle();
    expect(find("portal-headline")?.textContent).toBe("Bringing acme up.");
    expect(h.opened).toEqual([]);

    await act(async () => h.scheduled.shift()!());
    await settle();
    await act(async () => h.scheduled.shift()!());
    await settle();

    expect(h.calls.refresh).toBe(2);
    expect(h.opened).toEqual(["http://127.0.0.1:3000"]);
    expect(h.scheduled).toHaveLength(0);
  });

  test("a refusal is the box's own sentence", async () => {
    harness({
      open: {
        ok: false,
        error: {
          status: 0,
          code: "portal",
          message: "Project 'acme' is stopped. Start it with sail project start acme.",
        },
      },
    });
    await settle();

    expect(find("portal-refusal")?.textContent).toBe(
      "Project 'acme' is stopped. Start it with sail project start acme.",
    );
  });

  test("stop stops the processes and the rows say so", async () => {
    const h = harness({ open: { ok: true, value: SETTLED } });
    await settle();

    await act(async () => button("Stop processes")!.click());
    await settle();

    expect(h.calls.stop).toBe(1);
    expect(find("portal-port-web")?.textContent).toContain("stopped");
    expect(button("Open in browser")).toBeUndefined();
  });

  test("a project whose ports nobody declares says how to declare one", async () => {
    harness({ open: { ok: true, value: view([]) } });
    await settle();

    expect(find("portal-headline")?.textContent).toBe(
      "No service or process declares a port: add `port` to a process in the project's definition.",
    );
  });

  test("re-rendering the sheet with new callbacks and no schedule serves the project once", async () => {
    let opens = 0;
    const gateway = {
      portalOpen: async () => {
        opens += 1;
        return { ok: true as const, value: SETTLED };
      },
    } as unknown as Gateway;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = () =>
      root.render(
        <PortalPanel
          gateway={gateway}
          project="acme"
          openUrl={async () => {}}
          copyText={async () => {}}
          onClose={() => {}}
        />,
      );
    act(render);
    await settle();
    act(render);
    act(render);
    await settle();

    expect(opens).toBe(1);
  });

  test("a clipboard or browser that refuses says so where it was asked", async () => {
    const gateway = {
      portalOpen: async () => ({ ok: true as const, value: SETTLED }),
    } as unknown as Gateway;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <PortalPanel
          gateway={gateway}
          project="acme"
          openUrl={async () => {
            throw new Error("no browser");
          }}
          copyText={async () => {
            throw new Error("denied");
          }}
          onClose={() => {}}
        />,
      ),
    );
    await settle();

    expect(find("portal-refusal")?.textContent).toBe(
      "The browser could not be opened at http://127.0.0.1:3001: no browser",
    );
    await act(async () => button("Copy address")!.click());
    await settle();
    expect(button("Copy failed")).toBeDefined();
  });
});
