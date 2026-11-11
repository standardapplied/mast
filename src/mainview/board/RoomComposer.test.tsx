import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ServerRoomView } from "../../shared/sail-models";
import { catalogLaneStubs } from "../../../test/catalogStubs";
import type { Gateway } from "../gateway";
import { catalogStore } from "./catalogStore";
import { RoomComposer } from "./RoomComposer";
import { roomDrafts } from "./roomDrafts";

let root: Root;
let container: HTMLElement;
let sent: string[];

const room: ServerRoomView = {
  id: "design",
  project: "acme",
  title: "Design",
  members: [
    { agent: "claude-code", agent_name: "Claude Code", mode: "full", engaged_at: "2026-11-01T00:00:00Z" },
  ],
  spec_ids: [],
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const gateway = {
  ...catalogLaneStubs(),
  listRooms: async () => ({ ok: true as const, value: { rooms: [room], count: 1 } }),
  listFdes: async () => ({
    ok: true as const,
    value: {
      fdes: [
        { handle: "ada", display_name: "Ada Lovelace", role: "member" },
        { handle: "bob", role: "member" },
        { handle: "uday", display_name: "Uday", role: "admin" },
      ],
    },
  }),
} as unknown as Gateway;

async function mount(roomId = "design") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(<RoomComposer roomId={roomId} me="uday" onSend={(body) => sent.push(body)} />),
  );
  await act(async () => {});
}

const composer = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const listbox = () => document.querySelector<HTMLElement>('[role="listbox"]');
const options = () =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent);

function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(composer(), text);
    composer().setSelectionRange(text.length, text.length);
    composer().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => composer().dispatchEvent(event));
  return event;
}

beforeEach(() => {
  sent = [];
  roomDrafts.reset();
  catalogStore.connect(gateway);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  catalogStore.reset();
});

describe("RoomComposer mentions", () => {
  test("typing @b offers bob, and Enter inserts @bob without sending", async () => {
    await mount();
    type("ping @b");

    expect(options()).toEqual(["bob@bob"]);
    expect(press("Enter").defaultPrevented).toBe(true);

    expect(composer().value).toBe("ping @bob ");
    expect(composer().selectionStart).toBe("ping @bob ".length);
    expect(listbox()).toBeNull();
    expect(sent).toEqual([]);
  });

  test("@ offers the room's people and its agent members, not you", async () => {
    await mount();
    type("@");

    expect(options()).toEqual(["Ada Lovelace@ada", "bob@bob", "Claude Code@agent"]);
  });

  test("a name matches by any of its words", async () => {
    await mount();
    type("@love");

    expect(options()).toEqual(["Ada Lovelace@ada"]);
  });

  test("an agent member inserts the handle sail wakes agents by", async () => {
    await mount();
    type("@cl");
    press("Tab");

    expect(composer().value).toBe("@agent ");
  });

  test("the arrows move the choice, the textarea names it, and a click inserts", async () => {
    await mount();
    type("@");
    expect(composer().getAttribute("role")).toBe("combobox");
    expect(composer().getAttribute("aria-expanded")).toBe("true");
    expect(composer().getAttribute("aria-controls")).toBe(listbox()!.id);
    expect(listbox()!.getAttribute("aria-label")).toBe("Mention someone");

    press("ArrowDown");
    const active = document.getElementById(composer().getAttribute("aria-activedescendant")!)!;
    expect(active.textContent).toBe("bob@bob");
    expect(active.getAttribute("aria-selected")).toBe("true");
    press("ArrowUp");
    press("ArrowUp");
    expect(document.getElementById(composer().getAttribute("aria-activedescendant")!)!.textContent).toBe(
      "Claude Code@agent",
    );

    const ada = [...document.querySelectorAll<HTMLElement>('[role="option"]')][0]!;
    act(() => ada.click());
    expect(composer().value).toBe("@ada ");
  });

  test("Escape closes the list and keeps what was typed; Enter then sends it", async () => {
    await mount();
    type("@b");
    const escape = press("Escape");

    expect(escape.defaultPrevented).toBe(true);
    expect(listbox()).toBeNull();
    expect(composer().getAttribute("aria-expanded")).toBe("false");

    press("Enter");
    expect(sent).toEqual(["@b"]);
  });

  test("leaving the composer closes the list", async () => {
    await mount();
    type("@b");
    act(() => composer().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

    expect(listbox()).toBeNull();
  });

  test("an @ inside a word offers no one", async () => {
    await mount();
    type("mail uday@b");

    expect(listbox()).toBeNull();
  });
});

describe("RoomComposer drafts", () => {
  test("Enter sends the draft and clears it; Shift+Enter is a new line", async () => {
    await mount();
    type("first line");
    expect(press("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    press("Enter");

    expect(sent).toEqual(["first line"]);
    expect(composer().value).toBe("");
    expect(roomDrafts.draft("design")).toBe("");
  });

  test("a blank draft does not send", async () => {
    await mount();
    type("   ");
    press("Enter");

    expect(sent).toEqual([]);
  });

  test("each room holds its own draft", async () => {
    await mount("design");
    type("for design");
    act(() => root.unmount());
    container.remove();
    await mount("other");
    expect(composer().value).toBe("");
    act(() => root.unmount());
    container.remove();
    await mount("design");

    expect(composer().value).toBe("for design");
  });
});
