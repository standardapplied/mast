import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createDemoGateway, type Gateway } from "../gateway";
import { createTauriGateway } from "../tauri/gateway";
import type { SailEvent, SyncStatus } from "../../shared/sail-models";
import { SyncHealthChip, useSyncStatus } from "./SyncHealth";

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };

let root: Root | undefined;
let container: HTMLElement | undefined;
const now = Date.parse("2026-09-17T00:00:00Z");
const response = (state: SyncStatus["state"]): SyncStatus & { schema_version: number } => ({
  schema_version: 1,
  role: "node", main: "sail@main", state,
  last_attempt_at: "2026-09-17T00:00:00Z",
  last_success_at: "2026-09-14T00:00:00Z",
  consecutive_failures: state === "stale" ? 5 : 0,
  last_error_kind: state === "stale" ? "protocol" : null,
  last_error: state === "stale" ? "message: page exceeded 4 MiB" : null,
  stale_since: state === "stale" ? "2026-09-14T00:00:00Z" : null,
  last_report: { pulled: 1, pushed: 2, merged: 0, conflicts: 0 },
});

function Health({ gateway, ready = true }: { gateway: Gateway; ready?: boolean }) {
  return <SyncHealthChip status={useSyncStatus(gateway, ready)} now={now} />;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

const cases: [SyncStatus["state"], string][] = [
  ["in_sync", "in sync"],
  ["syncing", "syncing"],
  ["stale", "stale since 3 d — message: page exceeded 4 MiB"],
];

for (const [state, label] of cases) {
  test(`the chip renders ${state} from GET /v1/sync`, async () => {
    const calls: unknown[] = [];
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: unknown) => {
        calls.push({ cmd, args });
        return { status: 200, body: JSON.stringify(response(state!)) };
      },
    };
    const gateway = { ...createDemoGateway(), syncStatus: createTauriGateway().syncStatus };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Health gateway={gateway} />));
    expect(container.textContent).toBe(label);
    expect(calls).toEqual([{ cmd: "sail_request", args: { method: "GET", path: "/v1/sync", body: null, ifMatch: null } }]);
    expect(container.querySelector("[role=status]")?.getAttribute("title")).toBe(
      state === "stale" ? "message: page exceeded 4 MiB" : state === "syncing" ? "Syncing with sail@main" : "In sync with sail@main",
    );
  });
}

test("health events refresh the stored status and disconnect clears it", async () => {
  let state: SyncStatus["state"] = "stale";
  const gateway = createDemoGateway();
  gateway.syncStatus = async () => ({ ok: true, value: response(state) });
  let onEvent: ((event: SailEvent) => void) | undefined;
  gateway.onEvent = (listener) => { onEvent = listener; return () => { onEvent = undefined; }; };
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root!.render(<Health gateway={gateway} />));
  expect(container.textContent).toContain("stale since 3 d");
  state = "in_sync";
  await act(async () => onEvent!({ type: "sync_recovered" } as SailEvent));
  expect(container.textContent).toBe("in sync");
  await act(async () => root!.render(<Health gateway={gateway} ready={false} />));
  expect(container.textContent).toBe("");
  expect(onEvent).toBeUndefined();
});
