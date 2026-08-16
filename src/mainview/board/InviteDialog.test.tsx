import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  AgentListResponse,
  GlobalSpecView,
  InviteResponse,
} from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";
import type { Gateway } from "../gateway";
import { InviteDialog } from "./InviteDialog";

let root: Root;
let container: HTMLElement;

const SPEC: GlobalSpecView = {
  id: "s1",
  project: "chorus",
  title: "Spec one",
  status: "draft",
  priority: 0,
  depends_on: [],
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-16T00:00:00Z",
};

const CODEX_REASON =
  "Codex CLI has no harness-enforced read-only session inside a sail container.";

const AGENTS: SailResult<AgentListResponse> = {
  ok: true,
  value: {
    agents: [
      {
        name: "claude-code",
        display_name: "Claude Code",
        modes: [
          { mode: "read_only", supported: true },
          { mode: "full", supported: true },
        ],
      },
      {
        name: "codex",
        display_name: "Codex CLI",
        modes: [
          { mode: "read_only", supported: false, reason: CODEX_REASON },
          { mode: "full", supported: true },
        ],
      },
    ],
  },
};

const LAUNCHED: SailResult<InviteResponse> = {
  ok: true,
  value: {
    run_id: "run-1",
    principal: "claude/invite-run-1",
    mode: "read_only",
    snapshot: "",
  },
};

function mount({
  agents = AGENTS,
  invite = LAUNCHED,
  canDispatch = true,
  roleKnown = true,
}: {
  agents?: SailResult<AgentListResponse>;
  invite?: SailResult<InviteResponse>;
  canDispatch?: boolean;
  roleKnown?: boolean;
} = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const calls = {
    closed: 0,
    results: [] as Array<{ message: string; ok: boolean }>,
    requests: [] as Array<Record<string, unknown>>,
  };
  const gateway = {
    listAgents: async () => agents,
    invite: async (_id: string, request: Record<string, unknown>) => {
      calls.requests.push(request);
      return invite;
    },
  } as unknown as Gateway;
  act(() =>
    root.render(
      <InviteDialog
        gateway={gateway}
        spec={SPEC}
        canDispatch={canDispatch}
        roleKnown={roleKnown}
        onClose={() => calls.closed++}
        onResult={(message, ok) => calls.results.push({ message, ok })}
      />,
    ),
  );
  return calls;
}

const settle = async () => {
  await act(async () => {});
  await act(async () => {});
};
const go = () => container.querySelector('[data-testid="invite-go"]') as HTMLButtonElement;
const openSelect = () => {
  const trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
  act(() => trigger?.click());
};
const option = (value: string) =>
  document.querySelector<HTMLButtonElement>(`[data-testid="option-${value}"]`);

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("InviteDialog", () => {
  test("renders exactly the reported agents, greying read-only-unsupported with the server reason", async () => {
    mount();
    await settle();
    openSelect();

    const codex = option("codex");
    expect(codex).not.toBeNull();
    expect(codex?.disabled).toBe(true);
    expect(codex?.textContent).toContain(CODEX_REASON);
    expect(option("claude-code")?.disabled).toBe(false);
  });

  test("checking Full lifts the codex greying — every agent supports the full lane", async () => {
    mount();
    await settle();
    const checkbox = container.querySelector('[role="checkbox"]') as HTMLElement;
    act(() => checkbox.click());
    openSelect();

    expect(option("codex")?.disabled).toBe(false);
  });

  test("a read-only invite submits agent and model and toasts the launched principal", async () => {
    const calls = mount();
    await settle();
    const model = container.querySelector('[data-testid="invite-model"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(model, "opus-x");
      model.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => go().click());
    await settle();

    expect(calls.requests).toEqual([{ agent: "claude-code", model: "opus-x", full: false }]);
    expect(calls.results).toEqual([
      { message: "Invited claude-code (read only) into s1 as claude/invite-run-1.", ok: true },
    ]);
    expect(calls.closed).toBe(1);
  });

  test("a full invite's toast names the snapshot it paid with", async () => {
    const calls = mount({
      invite: {
        ok: true,
        value: {
          run_id: "run-2",
          principal: "codex/invite-run-2",
          mode: "full",
          snapshot: "invite-run-2",
        },
      },
    });
    await settle();
    const checkbox = container.querySelector('[role="checkbox"]') as HTMLElement;
    act(() => checkbox.click());
    act(() => go().click());
    await settle();

    expect(calls.requests).toEqual([{ agent: "claude-code", full: true }]);
    expect(calls.results[0]?.message).toContain("snapshot invite-run-2");
  });

  test("a 409 reservation refusal renders verbatim inline and holds the dialog open", async () => {
    const calls = mount({
      invite: {
        ok: false,
        error: {
          status: 409,
          code: "agent_already_running",
          message: "Agent run r7 is already working spec 's1' in repo(s) [app].",
          action: "Wait for it to finish or stop it, or dispatch a spec targeting disjoint repos.",
        },
      },
    });
    await settle();
    act(() => go().click());
    await settle();

    const refusal = container.querySelector('[data-testid="invite-refusal"]');
    expect(refusal?.textContent).toBe(
      "Agent run r7 is already working spec 's1' in repo(s) [app]. — Wait for it to finish or" +
        " stop it, or dispatch a spec targeting disjoint repos.",
    );
    expect(calls.closed).toBe(0);
    expect(calls.results).toEqual([]);
  });

  test("an unavailable agents endpoint falls back to free-text agent entry", async () => {
    mount({
      agents: {
        ok: false,
        error: { status: 404, code: "not_found", message: "no such route" },
      },
    });
    await settle();

    expect(container.querySelector('[data-testid="invite-agent-input"]')).not.toBeNull();
  });

  test("a read-only credential explains itself and disables the submit", async () => {
    mount({ canDispatch: false });
    await settle();

    expect(container.querySelector('[data-testid="invite-role"]')).not.toBeNull();
    expect(go().disabled).toBe(true);
  });
});
