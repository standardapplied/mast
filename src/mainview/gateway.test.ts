import { describe, expect, test } from "bun:test";
import type { SailEvent } from "../shared/sail-models";
import { createDemoGateway } from "./gateway";

describe("project roster", () => {
  test("the demo gateway serves the full catalog with container states", async () => {
    const result = await createDemoGateway().listProjects();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.projects.map((p) => p.name)).toEqual(["chorus", "nautilus", "sail-mast"]);
      expect(result.value.projects.map((p) => p.container_status)).toEqual([
        "running",
        "not_created",
        "stopped",
      ]);
    }
  });
});

describe("FDE roster", () => {
  test("the demo gateway serves the org's FDEs with handles and display names", async () => {
    const result = await createDemoGateway().listFdes();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fdes.map((f) => f.handle)).toEqual(["ravi", "sumesh", "uday"]);
      expect(result.value.fdes.every((f) => f.role)).toBe(true);
    }
  });
});

describe("spec runs", () => {
  test("the demo gateway serves a running build run for an in-progress spec", async () => {
    const result = await createDemoGateway().listRuns("chorus-invoice-ui");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const run = result.value.runs.find((r) => r.role === "build");
      expect(run?.status).toBe("running");
      expect(run?.branch).toBe("agent/chorus-invoice-ui");
    }
  });

  test("a spec with no active work has no runs", async () => {
    const result = await createDemoGateway().listRuns("chorus-onboarding");
    expect(result.ok && result.value.runs).toEqual([]);
  });
});

describe("review findings", () => {
  test("the demo gateway serves a review's findings consistent with its counts", async () => {
    const gateway = createDemoGateway();
    const reviews = await gateway.specReviews("chorus-rate-limits");
    expect(reviews.ok && reviews.value.reviews[0]?.id).toBe("rev-1");

    const detail = await gateway.reviewDetail("rev-1");
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      const counted = reviews.ok
        ? reviews.value.reviews[0]!.stages.reduce((n, s) => n + s.finding_count, 0)
        : -1;
      expect(detail.value.findings.length).toBe(counted);
      expect(detail.value.findings.every((f) => f.severity && f.title && f.description)).toBe(true);
    }
  });

  test("an unknown review id is a 404, not a crash", async () => {
    const result = await createDemoGateway().reviewDetail("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(404);
  });
});

describe("spec body edits go through the content resource", () => {
  test("putSpecContent updates the body and getSpecContent reflects it", async () => {
    const gateway = createDemoGateway();
    const put = await gateway.putSpecContent("chorus-billing-export", { body: "# Rewritten body" });
    expect(put.ok).toBe(true);

    const after = await gateway.getSpecContent("chorus-billing-export");
    expect(after.ok && after.value.body).toBe("# Rewritten body");
  });

  test("a spec id already taken is sail's 409 conflict, with its fix", async () => {
    const result = await createDemoGateway().createSpec({
      id: "chorus-billing-export",
      title: "Again",
      project: "chorus",
    });
    expect(result).toEqual({
      ok: false,
      error: {
        status: 409,
        code: "conflict",
        message: "Spec 'chorus-billing-export' already exists.",
        action: "Pick another spec id, or edit it with: sail spec update chorus-billing-export",
      },
    });
  });

  test("a spec born over a room holding its id adopts that room and mints none", async () => {
    const gateway = createDemoGateway();
    const room = await gateway.createRoom({ id: "pairing", title: "Pairing", project: "chorus" });
    expect(room.ok).toBe(true);
    await gateway.engage("pairing", { agent: "claude-code", mode: "read_only", model: "claude-fable-5" });
    const before = await gateway.getRoom("pairing");
    const roster = before.ok ? before.value.members : [];
    expect(roster.map((member) => member.agent)).toEqual(["claude-code"]);

    const born = await gateway.createSpec({ id: "pairing", title: "Pairing", project: "chorus" });

    expect(born.ok).toBe(true);
    const rooms = await gateway.listRooms("chorus");
    const adopted = rooms.ok ? rooms.value.rooms.filter((r) => r.id === "pairing") : [];
    expect(adopted.map((r) => r.members)).toEqual([roster]);
    const after = await gateway.getRoom("pairing");
    expect(after.ok && after.value.members).toEqual(roster);
  });

  test("a spec born over a room nobody is engaged in adopts it with an empty roster", async () => {
    const gateway = createDemoGateway();
    await gateway.createRoom({ id: "pairing", title: "Pairing", project: "chorus" });

    const born = await gateway.createSpec({ id: "pairing", title: "Pairing", project: "chorus" });

    expect(born.ok && born.value.spec.engagement).toBeUndefined();
    const after = await gateway.getRoom("pairing");
    expect(after.ok && after.value.members).toEqual([]);
  });

  test("a stale If-Match is a 412 conflict, not a silent overwrite", async () => {
    const gateway = createDemoGateway();
    const result = await gateway.putSpecContent("chorus-billing-export", { body: "x" }, '"stale"');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.status).toBe(412);
  });
});

describe("the demo's live member", () => {
  const ROOM = "chorus-billing-export";
  const LIVE_TYPES = ["agent_text_delta", "agent_tool_call", "agent_turn_ended"];

  /** A demo whose scripted turn waits to be fired, step by step, by the test. */
  async function demo(agent?: string) {
    const steps: Array<() => void> = [];
    const gateway = createDemoGateway((step) => void steps.push(step));
    if (agent) await gateway.engage(ROOM, { agent });
    const live: SailEvent[] = [];
    const wide: SailEvent[] = [];
    const stream = gateway.openRoomStream(ROOM);
    stream.onEvent((event) => live.push(event));
    gateway.onEvent((event) => wide.push(event));
    return { gateway, steps, live, wide, stream };
  }

  test("a post in its room streams the reply, posts it as the member, and ends the turn", async () => {
    const { gateway, steps, live, wide } = await demo("claude-code");

    await gateway.postSpecMessage(ROOM, { body: "Where do we start?" });
    expect(live).toEqual([]);
    expect(steps.length).toBeGreaterThan(0);
    steps.forEach((step) => step());

    expect(live.map((event) => [event.type, event.data?.status].filter(Boolean).join(":"))).toEqual([
      "agent_text_delta",
      "agent_tool_call:started",
      "agent_tool_call:finished",
      "agent_text_delta",
      "agent_text_delta",
      "agent_text_delta",
      "agent_text_delta",
      "agent_turn_ended",
    ]);
    const principal = `claude-code/demo-live-${ROOM}`;
    for (const event of live) {
      expect(event.spec).toBe(ROOM);
      expect(event.data).toMatchObject({
        run_id: `demo-live-${ROOM}`,
        room_id: ROOM,
        principal,
        turn: 1,
      });
    }

    const written = live
      .filter((event) => event.type === "agent_text_delta")
      .map((event) => event.data?.text)
      .join("");
    const messages = await gateway.listSpecMessages(ROOM);
    const reply = messages.ok ? messages.value.messages.at(-1) : undefined;
    expect(reply).toMatchObject({ author: principal, body: written });
    expect(live.at(-1)?.data).toMatchObject({ message_id: reply?.id, is_error: false });

    const order = wide.map((event) => event.type);
    expect(order.lastIndexOf("spec_message_posted")).toBe(order.indexOf("agent_turn_ended") - 1);
    expect(wide.findLast((event) => event.type === "spec_message_posted")?.agent).toBe(principal);
  });

  test("nothing live is stored: history holds the message's event and none of the turn's", async () => {
    const { gateway, steps } = await demo("claude-code");
    await gateway.postSpecMessage(ROOM, { body: "Where do we start?" });
    steps.forEach((step) => step());

    const stored = await gateway.specEvents(ROOM, { limit: 500 });
    const types = stored.ok ? stored.value.events.map((event) => event.type) : [];
    expect(types.filter((type) => type === "spec_message_posted")).toHaveLength(2);
    expect(types.filter((type) => LIVE_TYPES.includes(type))).toEqual([]);
  });

  test("its next reply is the next turn of the same run", async () => {
    const { gateway, steps, live } = await demo("claude-code");
    await gateway.postSpecMessage(ROOM, { body: "One" });
    await gateway.postSpecMessage(ROOM, { body: "Two" });
    steps.forEach((step) => step());

    expect(new Set(live.map((event) => event.data?.run_id)).size).toBe(1);
    expect([...new Set(live.map((event) => event.data?.turn))]).toEqual([1, 2]);
  });

  test("a Codex member is not live, and a room with no member has none: nothing is scripted", async () => {
    for (const agent of ["codex", undefined]) {
      const { gateway, steps, live } = await demo(agent);
      await gateway.postSpecMessage(ROOM, { body: "Anyone?" });

      expect(steps).toEqual([]);
      expect(live).toEqual([]);
    }
  });

  test("a room's stream carries its own room's turn, and nothing once it is closed", async () => {
    const { gateway, steps, live, stream } = await demo("claude-code");
    const elsewhere: SailEvent[] = [];
    gateway.openRoomStream("chorus-invoice-ui").onEvent((event) => elsewhere.push(event));

    await gateway.postSpecMessage(ROOM, { body: "Where do we start?" });
    steps[0]!();
    expect(live).toHaveLength(1);
    expect(elsewhere).toEqual([]);

    stream.stop();
    steps.slice(1).forEach((step) => step());
    expect(live).toHaveLength(1);
  });
});
