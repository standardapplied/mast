import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NumberStepper } from "./NumberStepper";

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
});

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>(".stepper-btn")];

describe("NumberStepper", () => {
  test("increments and decrements by step, clamped to bounds", () => {
    const onChange = mock(() => {});
    render(<NumberStepper value={40} min={0} max={100} step={10} onChange={onChange} />);
    const [dec, inc] = buttons();
    act(() => inc?.click());
    expect(onChange).toHaveBeenCalledWith(50);
    act(() => dec?.click());
    expect(onChange).toHaveBeenCalledWith(30);
  });

  test("disables the buttons at the bounds", () => {
    render(<NumberStepper value={0} min={0} max={100} step={10} onChange={() => {}} />);
    expect(buttons()[0]?.disabled).toBe(true);
    render(<NumberStepper value={100} min={0} max={100} step={10} onChange={() => {}} />);
    expect(buttons().at(-1)?.disabled).toBe(true);
  });

  test("click-to-edit commits a clamped typed value on Enter", () => {
    const onChange = mock(() => {});
    render(<NumberStepper value={40} min={0} max={100} step={10} onChange={onChange} />);
    act(() => container.querySelector<HTMLButtonElement>(".stepper-value")?.click());
    const input = container.querySelector<HTMLInputElement>("input.stepper-value")!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "250");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(100);
  });
});
