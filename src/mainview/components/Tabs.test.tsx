import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

let root: Root;
let container: HTMLElement;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <Tabs defaultValue="specs">
        <TabsList>
          <TabsTrigger value="specs">Specs</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="terminal" disabled>
            Terminal
          </TabsTrigger>
        </TabsList>
        <TabsContent value="specs">Spec board</TabsContent>
        <TabsContent value="agents">Agent list</TabsContent>
      </Tabs>,
    ),
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Tabs", () => {
  test("renders the default tab's content only", () => {
    render();
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe("Spec board");
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe("Specs");
  });

  test("switches content on trigger click", () => {
    render();
    const agents = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (b) => b.textContent === "Agents",
    );
    act(() => agents?.click());
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe("Agent list");
  });

  test("disabled trigger does not switch", () => {
    render();
    const terminal = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) =>
      b.textContent?.includes("Terminal"),
    );
    act(() => terminal?.click());
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe("Spec board");
  });
});
