import { describe, expect, test } from "bun:test";
import { failureLine, headline, localAddress, portLabel, stateLabel, type PortalPort } from "./portal";

const web: PortalPort = {
  name: "web",
  port: 3000,
  kind: "process",
  state: "listening",
  exitCode: null,
  detail: null,
  localPort: 3000,
};

describe("portal", () => {
  test("a port names the Mac's end only when it differs", () => {
    expect(portLabel(web)).toBe("3000");
    expect(portLabel({ ...web, localPort: 3001 })).toBe("3000 → 3001");
    expect(portLabel({ ...web, localPort: null })).toBe("3000");
  });

  test("each state reads in the operator's words", () => {
    expect(stateLabel(web)).toBe("listening");
    expect(stateLabel({ ...web, state: "starting" })).toBe("starting…");
    expect(stateLabel({ ...web, state: "exited", exitCode: 2 })).toBe("exited 2");
    expect(stateLabel({ ...web, state: "exited" })).toBe("exited");
    expect(stateLabel({ ...web, state: "stopped" })).toBe("stopped");
    expect(stateLabel({ ...web, state: "timeout" })).toBe("never listened");
  });

  test("a failure copies as one line naming the project, the port and why", () => {
    expect(failureLine("acme", { ...web, state: "exited", exitCode: 1, detail: "boom" })).toBe(
      "acme web 3000 exited 1: boom",
    );
    expect(failureLine("acme", { ...web, state: "timeout" })).toBe("acme web 3000 never listened");
  });

  test("an address exists only for a forwarded port", () => {
    expect(localAddress({ ...web, localPort: 5433 })).toBe("localhost:5433");
    expect(localAddress({ ...web, localPort: null })).toBeNull();
  });

  test("the headline says what happened or what to do", () => {
    const service: PortalPort = { ...web, name: "postgres", port: 5432, kind: "service" };
    expect(headline({ project: "acme", ports: [service], url: null, settled: true })).toBe(
      "Its services are forwarded to this Mac; no process declares a port to open.",
    );
    expect(
      headline({ project: "acme", ports: [{ ...web, state: "exited" }], url: null, settled: true }),
    ).toBe("No process listens, so nothing was opened.");
  });
});
