import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Splitter } from "./Splitter";

let root: Root;
let container: HTMLElement;

function render(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const pointer = (type: string, clientX: number) =>
  new MouseEvent(type, { clientX, bubbles: true });

function drag(sep: HTMLElement, from: number, ...to: number[]) {
  act(() => {
    sep.dispatchEvent(pointer("pointerdown", from));
    for (const x of to) window.dispatchEvent(pointer("pointermove", x));
    window.dispatchEvent(pointer("pointerup", to.at(-1) ?? from));
  });
}

describe("Splitter", () => {
  test("renders an accessible vertical separator", () => {
    render(<Splitter value={300} min={200} max={640} onChange={() => {}} />);
    const sep = container.querySelector('[role="separator"]')!;
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-valuenow")).toBe("300");
  });

  test("dragging left grows an after-pane; values are clamped", () => {
    const seen: number[] = [];
    let ended = -1;
    render(
      <Splitter
        value={300}
        min={200}
        max={640}
        controls="after"
        onChange={(w) => seen.push(w)}
        onDragEnd={(w) => (ended = w)}
      />,
    );
    const sep = container.querySelector<HTMLElement>('[role="separator"]')!;
    drag(sep, 1000, 950, 100, 1900);
    expect(seen).toEqual([350, 640, 200]); // grows, clamps high, clamps low
    expect(ended).toBe(200);
  });

  test("controls=before sizes the pane to the left instead", () => {
    const seen: number[] = [];
    render(<Splitter value={300} min={200} max={640} controls="before" onChange={(w) => seen.push(w)} />);
    const sep = container.querySelector<HTMLElement>('[role="separator"]')!;
    drag(sep, 1000, 1050);
    expect(seen).toEqual([350]);
  });

  test("listeners detach on pointerup", () => {
    const seen: number[] = [];
    render(<Splitter value={300} min={200} max={640} onChange={(w) => seen.push(w)} />);
    const sep = container.querySelector<HTMLElement>('[role="separator"]')!;
    drag(sep, 1000, 990);
    act(() => {
      window.dispatchEvent(pointer("pointermove", 500));
    });
    expect(seen).toEqual([310]); // the post-up move changed nothing
  });
});
