import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SailEvent, SnapshotView } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import type { Gateway } from "../gateway";
import { SnapshotsPanel } from "./SnapshotsPanel";

let root: Root;
let container: HTMLElement;

const SNAPSHOTS: SnapshotView[] = [
  { name: "invite-run-3", created_at: "2026-08-17T10:00:00Z", source: "invite" },
  { name: "snap-20260817-080000", created_at: "2026-08-17T08:00:00Z", source: "dispatch" },
];

function makeGateway(overrides: Partial<Record<string, unknown>> = {}) {
  const listeners = new Set<(e: SailEvent) => void>();
  const calls = { restore: [] as string[], delete: [] as string[] };
  let snapshots = [...SNAPSHOTS];
  const accepted = (name: string, action: string): SailResult<unknown> => ({
    ok: true,
    value: { project: "acme", name, action, status: "accepted" },
  });
  const gateway = {
    listSnapshots: async () => ({ ok: true as const, value: { snapshots, total: snapshots.length } }),
    restoreSnapshot: async (_project: string, name: string) => {
      calls.restore.push(name);
      return accepted(name, "restore");
    },
    deleteSnapshot: async (_project: string, name: string) => {
      calls.delete.push(name);
      return accepted(name, "delete");
    },
    onEvent: (l: (e: SailEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    ...overrides,
  };
  return {
    gateway: gateway as unknown as Gateway,
    calls,
    emit: (e: SailEvent) => listeners.forEach((l) => l(e)),
    setSnapshots: (next: SnapshotView[]) => (snapshots = next),
  };
}

function mount(gateway: Gateway, onClose: () => void = () => {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<SnapshotsPanel gateway={gateway} project="acme" onClose={onClose} />));
}

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};

const text = (selector: string) => container.querySelector(selector)?.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const confirmButton = (action: string, label: string) =>
  [
    ...(container.querySelector(`[data-testid="confirm-${action}"]`)?.querySelectorAll("button") ??
      []),
  ].find((b) => b.textContent?.trim() === label);
const row = (name: string) => container.querySelector(`[data-testid="snapshot-${name}"]`);

const snapshotEvent = (type: string, label: string, error?: string): SailEvent => ({
  v: 1,
  ts: "2026-08-17T11:00:00Z",
  project: "acme",
  type,
  agent: "sail",
  host: "box",
  data: error ? { label, error } : { label },
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SnapshotsPanel", () => {
  test("renders the list newest-first with source badges and ages", async () => {
    const { gateway } = makeGateway();
    mount(gateway);
    await settle();

    const rows = [...container.querySelectorAll('[data-testid^="snapshot-"]')].filter((el) =>
      el.className.includes("history-row"),
    );
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toContain("invite-run-3");
    expect(rows[0]!.textContent).toContain("invite");
    expect(rows[1]!.textContent).toContain("dispatch");
  });

  test("delete asks for confirmation and only calls the gateway on confirm", async () => {
    const { gateway, calls, emit, setSnapshots } = makeGateway();
    mount(gateway);
    await settle();

    await act(async () => row("invite-run-3")!.querySelectorAll("button")[1]!.click());
    expect(text('[data-testid="confirm-delete"]')).toContain("Delete snapshot 'invite-run-3'?");
    expect(calls.delete).toEqual([]);

    await act(async () => confirmButton("delete", "Delete")!.click());
    await settle();
    expect(calls.delete).toEqual(["invite-run-3"]);
    expect(text('[data-testid="snapshot-busy"]')).toContain("deleting…");

    setSnapshots([SNAPSHOTS[1]!]);
    await act(async () => emit(snapshotEvent("snapshot_deleted", "invite-run-3")));
    await settle();
    expect(row("invite-run-3")).toBeNull();
    expect(text('[data-testid="snapshot-notice"]')).toContain("Deleted 'invite-run-3'.");
  });

  test("cancelling a confirm never mutates", async () => {
    const { gateway, calls } = makeGateway();
    mount(gateway);
    await settle();

    await act(async () => row("invite-run-3")!.querySelectorAll("button")[0]!.click());
    expect(text('[data-testid="confirm-restore"]')).toContain("discarded");
    await act(async () => confirmButton("restore", "Cancel")!.click());
    expect(container.querySelector('[data-testid="confirm-restore"]')).toBeNull();
    expect(calls.restore).toEqual([]);
    expect(calls.delete).toEqual([]);
  });

  test("a restore refusal is rendered verbatim and clears on a later success", async () => {
    const { gateway, emit } = makeGateway({
      restoreSnapshot: async () => ({
        ok: false,
        error: {
          status: 409,
          code: "agent_already_running",
          message: "Agent run r-7 is already working spec 'auth' in this container; restoring snapshot 'invite-run-3' would discard its live work.",
          action: "Wait for it to finish or stop it, then retry the restore.",
        },
      }),
    });
    mount(gateway);
    await settle();

    await act(async () => row("invite-run-3")!.querySelectorAll("button")[0]!.click());
    await act(async () => confirmButton("restore", "Restore")!.click());
    await settle();

    expect(text('[data-testid="snapshot-refusal"]')).toBe(
      "Agent run r-7 is already working spec 'auth' in this container; restoring snapshot 'invite-run-3' would discard its live work. — Wait for it to finish or stop it, then retry the restore.",
    );
    expect(container.querySelector('[data-testid="snapshot-busy"]')).toBeNull();

    await act(async () => emit(snapshotEvent("snapshot_created", "snap-new")));
    await settle();
    expect(text('[data-testid="snapshot-refusal"]')).toContain("would discard its live work");
  });

  test("a completion event that outruns the accepted response still resolves the row", async () => {
    const { gateway, emit } = makeGateway();
    (gateway as unknown as Record<string, unknown>).restoreSnapshot = async (
      _project: string,
      name: string,
    ) => {
      emit(snapshotEvent("snapshot_restored", name));
      return { ok: true, value: { project: "acme", name, action: "restore", status: "accepted" } };
    };
    mount(gateway);
    await settle();

    await act(async () => row("invite-run-3")!.querySelectorAll("button")[0]!.click());
    await act(async () => confirmButton("restore", "Restore")!.click());
    await settle();

    expect(container.querySelector('[data-testid="snapshot-busy"]')).toBeNull();
    expect(text('[data-testid="snapshot-notice"]')).toContain("Restored 'invite-run-3'.");
    const buttons = [...row("invite-run-3")!.querySelectorAll("button")];
    expect(buttons.every((b) => !b.disabled)).toBe(true);
  });

  test("an accepted restore resolves in-progress state on its event, or surfaces its error", async () => {
    const { gateway, calls, emit } = makeGateway();
    mount(gateway);
    await settle();

    await act(async () => row("invite-run-3")!.querySelectorAll("button")[0]!.click());
    await act(async () => confirmButton("restore", "Restore")!.click());
    await settle();
    expect(calls.restore).toEqual(["invite-run-3"]);
    expect(text('[data-testid="snapshot-busy"]')).toContain("restoring…");

    await act(async () => emit(snapshotEvent("snapshot_restored", "invite-run-3", "boom")));
    await settle();
    expect(container.querySelector('[data-testid="snapshot-busy"]')).toBeNull();
    expect(text('[data-testid="snapshot-refusal"]')).toBe("boom");
  });
});
