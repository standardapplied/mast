import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FdeView, ServerRoomView } from "../../shared/sail-models";
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

const PEOPLE: FdeView[] = [
  { handle: "ada", display_name: "Ada Lovelace", role: "member" },
  { handle: "bob", role: "member" },
  { handle: "uday", display_name: "Uday", role: "admin" },
];

function gatewayWith(fdes: FdeView[]): Gateway {
  return {
    ...catalogLaneStubs(),
    whoami: async () => ({
      ok: true as const,
      value: { name: "uday", fde: "uday", role: "admin", capabilities: ["read", "write"] },
    }),
    listRooms: async () => ({ ok: true as const, value: { rooms: [room], count: 1 } }),
    listFdes: async () => ({ ok: true as const, value: { fdes } }),
  } as unknown as Gateway;
}

async function mount(roomId = "design", wrap = (composer: ReactNode) => composer) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(wrap(<RoomComposer roomId={roomId} onSend={(body) => sent.push(body)} />)),
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
  catalogStore.connect(gatewayWith(PEOPLE));
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

  test("Enter or Tab that confirms an IME composition neither inserts nor sends", async () => {
    await mount();
    type("@b");
    expect(press("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(press("Tab", { keyCode: 229 } as KeyboardEventInit).defaultPrevented).toBe(false);
    expect(composer().value).toBe("@b");
    expect(listbox()).not.toBeNull();

    type("今日は");
    press("Enter", { isComposing: true });
    expect(sent).toEqual([]);
  });

  test("the keyboard's choice is kept in view", async () => {
    await mount();
    type("@");
    const shown: string[] = [];
    const scrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      shown.push(this.textContent ?? "");
    };
    press("ArrowDown");
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    expect(shown).toEqual(["bob@bob"]);
  });

  test("the row under the pointer is the choice, so one row is lit", async () => {
    await mount();
    type("@");
    const claude = [...document.querySelectorAll<HTMLElement>('[role="option"]')][2]!;
    act(() => {
      claude.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });

    expect([...document.querySelectorAll('[aria-selected="true"]')].map((row) => row.textContent)).toEqual([
      "Claude Code@agent",
    ]);
    expect(document.querySelectorAll(".option.is-active").length).toBe(1);
    press("Enter");
    expect(composer().value).toBe("@agent ");
  });

  test("at most five are offered", async () => {
    catalogStore.connect(
      gatewayWith(["a1", "a2", "a3", "a4", "a5", "a6"].map((handle) => ({ handle, role: "member" }))),
    );
    await mount();
    type("@a");

    expect(options().length).toBe(5);
  });

  test("a handle with dots or dashes is offered as it is typed", async () => {
    catalogStore.connect(
      gatewayWith([
        { handle: "bob.smith", role: "member" },
        { handle: "a-b", role: "member" },
      ]),
    );
    await mount();
    type("@bob.s");
    expect(options()).toEqual(["bob.smith@bob.smith"]);
    type("@a-b");
    expect(options()).toEqual(["a-b@a-b"]);
  });

  test("a name matches from the start of a word, not inside one", async () => {
    await mount();
    type("@ov");

    expect(listbox()).toBeNull();
  });

  test("typing after Escape opens the list again, as a picker's search does", async () => {
    await mount();
    type("@b");
    press("Escape");
    type("@bo");

    expect(options()).toEqual(["bob@bob"]);
  });

  test("the Escape that closes the list goes no further", async () => {
    const escapes: string[] = [];
    await mount("design", (composer) => (
      <div onKeyDown={(event) => event.key === "Escape" && escapes.push("outer")}>{composer}</div>
    ));
    type("@b");
    press("Escape");
    expect(escapes).toEqual([]);
    press("Escape");
    expect(escapes).toEqual(["outer"]);
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

  test("what is typed stays on screen when storage refuses to keep it", async () => {
    roomDrafts.connect({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    });
    await mount();
    type("hello");

    expect(composer().value).toBe("hello");
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
