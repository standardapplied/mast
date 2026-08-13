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
  return { spec: spec(id, status, title), activityAt: "2026-08-01T00:00:00Z", unread: false };
}

function mount(rooms: RoomView[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <RoomList
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

test("a room row shows its spec id and the board's real status label", () => {
  mount([room("linkedin-bulk-capture", "in_progress", "Bulk capture")]);

  const row = container.querySelector('[data-testid="room-linkedin-bulk-capture"]')!;
  expect(row.querySelector(".room-row-id")?.textContent).toBe("linkedin-bulk-capture");
  expect(row.textContent).toContain("In progress");
  expect(row.textContent).not.toContain("In flight");
});

test("every lifecycle status renders the same label the board uses", () => {
  mount([
    room("d", "draft", "Draft one"),
    room("p", "pending", "Pending one"),
    room("r", "review", "Review one"),
    room("m", "awaiting_merge", "Merge one"),
  ]);

  const text = container.textContent ?? "";
  expect(text).toContain("Draft");
  expect(text).toContain("Pending");
  expect(text).toContain("Review");
  expect(text).toContain("Awaiting merge");
});
