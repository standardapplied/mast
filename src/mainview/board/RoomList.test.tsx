import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GlobalSpecView } from "../../shared/sail-models";
import { RoomList } from "./RoomList";
import type { RoomView } from "./rooms";

let container: HTMLElement;
let root: Root;

function spec(id: string, status: string, title: string): GlobalSpecView {
  return {
    id,
    project: "acme",
    title,
    status: status as GlobalSpecView["status"],
    priority: 0,
    created_by: "uday",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    repos: [],
    depends_on: [],
  };
}

function room(id: string, status: string, title: string): RoomView {
  return {
    room: {
      id,
      project: "acme",
      title,
      members: [],
      spec_ids: [id],
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
    spec: spec(id, status, title),
    activityAt: "2026-08-01T00:00:00Z",
    unread: false,
    needsReply: false,
  };
}

function chat(id: string): RoomView {
  return {
    room: {
      id,
      project: "acme",
      title: "acme",
      members: [{ agent: "claude-code", mode: "full", engaged_at: "2026-08-01T00:00:00Z" }],
      spec_ids: [],
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    },
    activityAt: "2026-08-01T00:00:00Z",
    unread: false,
    needsReply: false,
  };
}

function mount(rooms: RoomView[], extra: Partial<Parameters<typeof RoomList>[0]> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  rerender(rooms, extra);
}

function rerender(rooms: RoomView[], extra: Partial<Parameters<typeof RoomList>[0]> = {}) {
  act(() =>
    root.render(
      <RoomList
        gateway={{ listAgents: async () => ({ ok: true as const, value: { agents: [] } }) }}
        rooms={rooms}
        projects={["acme"]}
        project="acme"
        showArchive={false}
        creating={false}
        now={Date.parse("2026-08-01T00:01:00Z")}
        onProject={() => {}}
        onSelect={() => {}}
        onShowArchive={() => {}}
        onCreate={async () => true}
        {...extra}
      />,
    ),
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("a room awaiting a reply shows the needs-reply mark", () => {
  const asking = { ...room("stuck-spec", "in_progress", "Stuck"), needsReply: true };
  mount([asking, room("quiet-spec", "in_progress", "Quiet")]);

  expect(
    container.querySelector('[data-testid="needs-reply-stuck-spec"]'),
    "the flagged room wears the mark",
  ).not.toBeNull();
  expect(
    container.querySelector('[data-testid="needs-reply-quiet-spec"]'),
    "a room with no open question stays unmarked",
  ).toBeNull();
});

test("a room row shows only the spec id — no title, no status", () => {
  mount([room("linkedin-bulk-capture", "in_progress", "Bulk capture campaign")]);

  const row = container.querySelector('[data-testid="room-linkedin-bulk-capture"]')!;
  expect(row.querySelector(".room-row-id-label")?.textContent).toBe("linkedin-bulk-capture");
  expect(row.textContent, "the long title is not repeated in the compact nav").not.toContain(
    "Bulk capture campaign",
  );
  expect(
    row.textContent,
    "status is redundant with the section grouping and is dropped",
  ).not.toContain("In progress");
});

test("the home room leads the sidebar under the project's name, outside every section", () => {
  const home = chat("acme--ada");
  mount([chat("notes"), home, room("s1", "draft", "Sketch")], { homeRoom: home });

  const rows = Array.from(container.querySelectorAll<HTMLElement>(".room-row"));
  expect(rows.map((row) => row.dataset.testid)).toEqual([
    "room-acme--ada",
    "room-notes",
    "room-s1",
  ]);
  expect(rows[0]!.querySelector(".room-row-id-label")?.textContent).toBe("acme");
  const firstSection = container.querySelector(".room-section")!;
  expect(firstSection.querySelector(".room-section-head")).toBeNull();
});

test("without a home room the sidebar lists every room in its section", () => {
  mount([chat("acme--ada")]);

  const conversations = container.querySelector(".room-section")!;
  expect(conversations.querySelector(".room-section-head")?.textContent).toBe("Conversations");
  expect(conversations.querySelector('[data-testid="room-acme--ada"]')?.textContent).toContain(
    "acme--ada",
  );
});

test("a new room's agent starts on the project's member", async () => {
  const agents = ["claude-code", "codex"].map((name) => ({
    name,
    display_name: name === "codex" ? "Codex CLI" : "Claude Code",
    modes: [],
  }));
  mount([], {
    member: { agent: "codex", mode: "full" },
    gateway: { listAgents: async () => ({ ok: true as const, value: { agents } }) },
  });

  act(() => container.querySelector<HTMLButtonElement>('[aria-label="New room"]')!.click());
  await act(async () => {});

  const selects = document.querySelectorAll('[role="dialog"] .select-value');
  expect(selects[selects.length - 1]?.textContent).toBe("Codex CLI");
});

test("a member or agent list landing after the viewer chose no agent leaves their choice", async () => {
  const agents = ["claude-code", "codex"].map((name) => ({
    name,
    display_name: name === "codex" ? "Codex CLI" : "Claude Code",
    modes: [],
  }));
  let answer: () => void = () => {};
  const created: Array<string | undefined> = [];
  const extra = {
    gateway: {
      listAgents: () =>
        new Promise<{ ok: true; value: { agents: typeof agents } }>(
          (resolve) => (answer = () => resolve({ ok: true, value: { agents } })),
        ),
    },
    onCreate: async (_title: string, _project: string, agent?: string) => {
      created.push(agent);
      return true;
    },
  };
  mount([], extra);
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="New room"]')!.click());
  const triggers = () => document.querySelectorAll<HTMLElement>('[role="dialog"] .select-trigger');
  act(() => triggers()[triggers().length - 1]!.click());
  act(() => document.querySelector<HTMLElement>('[data-testid="option-"]')!.click());

  await act(async () => answer());
  rerender([], { ...extra, member: { agent: "codex", mode: "full" } });

  const values = document.querySelectorAll('[role="dialog"] .select-value');
  expect(values[values.length - 1]?.textContent).toBe("No agent");
  const title = document.querySelector<HTMLInputElement>('[aria-label="Room title"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "Notes");
    title.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    document.querySelector<HTMLFormElement>("#create-room-form")!.requestSubmit();
  });
  expect(created).toEqual([undefined]);
});
