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

function mount(rooms: RoomView[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
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
