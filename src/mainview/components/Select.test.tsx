import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Select } from "./Select";

let root: Root;
let container: HTMLElement;

const OPTIONS = [
  { value: "claude-code", label: "claude-code" },
  { value: "codex", label: "codex", description: "OpenAI coding agent" },
];

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

describe("Select", () => {
  test("opens on click and selects an option", () => {
    const onChange = mock(() => {});
    render(<Select value="" onChange={onChange} options={OPTIONS} placeholder="Pick agent" />);

    const trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    expect(trigger?.textContent).toContain("Pick agent");

    act(() => trigger?.click());
    const options = document.querySelectorAll<HTMLButtonElement>(".option");
    expect(options.length).toBe(2);
    expect(options[1]?.textContent).toContain("OpenAI coding agent");

    act(() => options[1]?.click());
    expect(onChange).toHaveBeenCalledWith("codex");
    expect(document.querySelector(".dropdown-panel")).toBeNull();
  });

  test("portals the dropdown to document.body so a transformed dialog ancestor cannot displace it", () => {
    render(<Select value="" onChange={() => {}} options={OPTIONS} />);
    const trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    act(() => trigger?.click());
    const panel = document.querySelector(".dropdown-panel");
    expect(panel, "the dropdown must render").not.toBeNull();
    expect(
      panel?.parentElement,
      "the panel must be a direct child of body, not nested under the transformed dialog subtree",
    ).toBe(document.body);
  });

  test("shows the selected option's label and marks it selected", () => {
    render(<Select value="codex" onChange={() => {}} options={OPTIONS} />);
    const trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    expect(trigger?.textContent).toContain("codex");

    act(() => trigger?.click());
    const selected = document.querySelector(".option.is-selected");
    expect(selected?.textContent).toContain("codex");
  });

  test("searchable filters options locally", () => {
    render(<Select value="" onChange={() => {}} options={OPTIONS} searchable />);
    const input = container.querySelector<HTMLInputElement>(".select-search");

    act(() => input?.focus());
    act(() => {
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(input, "dex");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    const options = document.querySelectorAll(".option");
    expect(options.length).toBe(1);
    expect(options[0]?.textContent).toContain("codex");
  });

  test("multiple mode toggles whole rows with checkbox indicators, panel stays open", () => {
    const toggles: Array<[string, boolean]> = [];
    render(
      <Select
        multiple
        placeholder="Lanes"
        values={["draft"]}
        onToggle={(v, s) => toggles.push([v, s])}
        options={[
          { value: "draft", label: "Draft", disabled: true },
          { value: "done", label: "Done" },
        ]}
      />,
    );

    act(() => container.querySelector<HTMLButtonElement>(".select-trigger")?.click());
    const done = document.querySelector<HTMLButtonElement>('[data-testid="option-done"]');
    expect(done?.querySelector(".checkbox")).not.toBeNull();
    expect(done?.querySelector(".checkbox.is-checked")).toBeNull();

    act(() => done?.click());
    expect(toggles).toEqual([["done", true]]);
    expect(document.querySelector(".dropdown-panel")).not.toBeNull();

    const draft = document.querySelector<HTMLButtonElement>('[data-testid="option-draft"]');
    expect(draft?.disabled).toBe(true);
    expect(draft?.querySelector(".checkbox.is-checked")).not.toBeNull();
  });

  test("renders the error and closes on outside click", () => {
    render(<Select value="" onChange={() => {}} options={OPTIONS} error="Required" />);
    expect(container.querySelector(".field-error")?.textContent).toBe("Required");

    const trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    act(() => trigger?.click());
    expect(document.querySelector(".dropdown-panel")).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.querySelector(".dropdown-panel")).toBeNull();
  });
});
