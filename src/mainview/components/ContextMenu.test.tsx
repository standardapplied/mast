import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextMenu, submenuSide } from "./ContextMenu";

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
});

describe("submenuSide", () => {
  test("opens right when the submenu fits", () => {
    expect(submenuSide(300, 160, 1200)).toBe("right");
  });

  test("flips left when the viewport edge would clip it", () => {
    expect(submenuSide(1100, 160, 1200)).toBe("left");
    expect(submenuSide(1192, 1, 1200)).toBe("left");
  });
});

describe("ContextMenu submenu", () => {
  async function open(rowRight: number, submenuWidth: number) {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      const width = this.classList?.contains?.("context-submenu") ? submenuWidth : 120;
      return {
        left: rowRight - 120,
        right: this.classList?.contains?.("context-submenu") ? rowRight + submenuWidth : rowRight,
        top: 0,
        bottom: 24,
        width,
        height: 24,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
    try {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root.render(
          <ContextMenu
            x={0}
            y={0}
            onClose={() => {}}
            items={[
              {
                kind: "item",
                label: "Open terminal",
                submenu: [{ kind: "item", label: "Shell", onSelect: () => {} }],
              },
            ]}
          />,
        );
      });
      const row = document.querySelector(".context-menu-row")!;
      await act(async () => {
        row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      return document.querySelector(".context-submenu");
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  }

  test("a submenu with room opens to the right", async () => {
    const submenu = await open(200, 160);
    expect(submenu).not.toBeNull();
    expect(submenu?.classList.contains("context-submenu--left")).toBe(false);
  });

  test("a submenu at the viewport edge flips left instead of rendering off-screen", async () => {
    const submenu = await open(window.innerWidth - 10, 160);
    expect(submenu).not.toBeNull();
    expect(submenu?.classList.contains("context-submenu--left")).toBe(true);
  });
});
