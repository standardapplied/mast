import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SailEvent } from "../../shared/sail-models";
import { createDemoGateway, type DemoGateway } from "../gateway";
import type { DeckServices, RoomWorkbenchProps } from "../terminal/roomDeck";
import { RoomTerminalRoute } from "./RoomTerminalRoute";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = async () => {
  await act(async () => {});
  await act(async () => {});
};

const workbenches: RoomWorkbenchProps[] = [];
const services: DeckServices = {
  Workbench: (props) => {
    workbenches.push(props);
    return <div data-testid="fake-workbench" data-room={props.roomId} />;
  },
};

function message(spec: string): SailEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    project: "sail-mast",
    spec,
    type: "spec_message_posted",
    agent: "mady",
    host: "devbox",
    data: { message_id: crypto.randomUUID() },
  };
}

async function render(
  gateway: DemoGateway,
  over: { withServices?: boolean; onBack?: () => void } = {},
) {
  workbenches.length = 0;
  await act(async () => {
    root.render(
      <RoomTerminalRoute
        gateway={gateway}
        request={{
          roomId: "design-talk",
          project: "sail-mast",
          title: "Design talk",
          focus: "room-design-talk.2",
          launch: "claude",
        }}
        services={over.withServices ? services : undefined}
        active
        onBack={over.onBack ?? (() => {})}
      />,
    );
  });
  await flush();
}

describe("RoomTerminalRoute", () => {
  test("the bar names the room and its context; the body is the injected workbench", async () => {
    await render(createDemoGateway(), { withServices: true });
    const bar = container.querySelector('[data-testid="room-route-bar"]');
    expect(bar?.textContent).toContain("Design talk");
    expect(container.querySelector('[data-testid="route-context"]')?.textContent).toBe(
      "design-talk · sail-mast",
    );
    expect(container.querySelector('[data-testid="fake-workbench"]')).not.toBeNull();
    // The entry request and the required visibility threading reach the workbench intact.
    expect(workbenches[0]).toMatchObject({
      roomId: "design-talk",
      project: "sail-mast",
      active: true,
      focus: "room-design-talk.2",
      launch: "claude",
    });
  });

  test("back is the bar's one verb", async () => {
    let backs = 0;
    await render(createDemoGateway(), { withServices: true, onBack: () => backs++ });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="route-back"]')?.click();
    });
    expect(backs).toBe(1);
  });

  test("messages posted to this room while attached badge the back affordance", async () => {
    const gateway = createDemoGateway();
    await render(gateway, { withServices: true });
    expect(container.querySelector('[data-testid="route-unread"]')).toBeNull();

    await act(async () => {
      gateway.emit(message("design-talk"));
      gateway.emit(message("some-other-room"));
      gateway.emit(message("design-talk"));
    });
    await flush();
    expect(container.querySelector('[data-testid="route-unread"]')?.textContent).toBe("2");
  });

  test("without the Tauri edge the route explains where attaching lives", async () => {
    await render(createDemoGateway());
    expect(container.querySelector('[data-testid="deck-attach-unavailable"]')).not.toBeNull();
  });
});
