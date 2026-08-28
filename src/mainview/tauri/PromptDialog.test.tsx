import { describe, expect, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { PromptDialog } from "./PromptDialog";

function render(ui: React.ReactElement): { host: HTMLElement; cleanup: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const confirmButton = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Rename")!;

describe("PromptDialog", () => {
  test("an empty value cannot be submitted by default", () => {
    const { cleanup } = render(
      <PromptDialog title="Rename" label="Name" confirmLabel="Rename" onConfirm={() => {}} onClose={() => {}} />,
    );
    expect(confirmButton().disabled).toBe(true);
    cleanup();
  });

  test("allowEmpty accepts a blank submission from the button, not just Enter", () => {
    const got: { value: string | null } = { value: null };
    const { cleanup } = render(
      <PromptDialog
        title="Rename"
        label="Name"
        confirmLabel="Rename"
        allowEmpty
        onConfirm={(v) => {
          got.value = v;
        }}
        onClose={() => {}}
      />,
    );
    const button = confirmButton();
    expect(button.disabled).toBe(false);
    act(() => button.click());
    expect(got.value).toBe("");
    cleanup();
  });
});
