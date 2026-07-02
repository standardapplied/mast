import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog } from "./Dialog";

let root: Root;
let container: HTMLElement;

function render(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(ui));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.style.overflow = "";
});

const flush = () => act(async () => {});

describe("Dialog", () => {
  test("renders title, content, footer when open; nothing when closed", () => {
    render(
      <Dialog isOpen={false} onClose={() => {}} title="Dispatch">
        body
      </Dialog>,
    );
    expect(document.querySelector(".dialog-panel")).toBeNull();

    act(() =>
      root.render(
        <Dialog isOpen onClose={() => {}} title="Dispatch" footer={<span>foot</span>}>
          body
        </Dialog>,
      ),
    );
    expect(document.querySelector(".dialog-title")?.textContent).toBe("Dispatch");
    expect(document.querySelector(".dialog-content")?.textContent).toBe("body");
    expect(document.querySelector(".dialog-footer")?.textContent).toBe("foot");
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("escape key closes through onClose", async () => {
    const onClose = mock(() => {});
    render(
      <Dialog isOpen onClose={onClose}>
        body
      </Dialog>,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("outside click closes; inside click does not", async () => {
    const onClose = mock(() => {});
    render(
      <Dialog isOpen onClose={onClose} title="t">
        body
      </Dialog>,
    );
    act(() => {
      document.querySelector(".dialog-content")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flush();
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("onBeforeClose returning false vetoes the close", async () => {
    const onClose = mock(() => {});
    render(
      <Dialog isOpen onClose={onClose} onBeforeClose={() => false} title="t">
        body
      </Dialog>,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(onClose).not.toHaveBeenCalled();

    const close = document.querySelector<HTMLButtonElement>(".dialog-close");
    act(() => close?.click());
    await flush();
    expect(onClose).not.toHaveBeenCalled();
  });
});
