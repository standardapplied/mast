import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { attentionStore } from "../terminal/attention";
import { TerminalTabStrip } from "./TerminalTabStrip";

let container: HTMLDivElement;
let root: Root;

const TABS = [
  { key: "app", target: "app", label: "app" },
  { key: "web", target: "web", label: "web" },
];
const PANES = { app: ["mast-app", "mast-app.2"], web: ["mast-web"] };
const AWAY = { paneFocused: false, windowFocused: true, muted: false };

beforeEach(() => {
  localStorage.clear();
  attentionStore.reset();
  attentionStore.connect(localStorage, async () => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <TerminalTabStrip
        tabs={TABS}
        activeKey="web"
        adding={false}
        statuses={{}}
        panes={PANES}
        onActivate={() => {}}
        onClose={() => {}}
        onAdd={() => {}}
      />,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  attentionStore.reset();
});

const dotOn = (key: string) =>
  container.querySelector(`[role="tab"]:nth-of-type(${key === "app" ? 1 : 2}) [data-testid="term-tab-bell-dot"]`);

describe("TerminalTabStrip", () => {
  test("a bell in a pane of another project dots that project's tab until the pane is seen", () => {
    expect(dotOn("app")).toBeNull();
    act(() => attentionStore.ring("mast-app.2", AWAY));
    expect(dotOn("app"), "app's split rang while web is up").not.toBeNull();
    expect(dotOn("web")).toBeNull();
    act(() => attentionStore.seen("mast-app.2"));
    expect(dotOn("app"), "looked at, the dot is gone").toBeNull();
  });

  test("a pane the tab no longer holds cannot dot it", () => {
    act(() => attentionStore.ring("mast-old", AWAY));
    expect(dotOn("app")).toBeNull();
    expect(dotOn("web")).toBeNull();
  });
});
