/**
 * The portal as the webview reads it: where each of a project's declared ports stands, the
 * Mac's end of the forward when one is open, and the address to open. The core brings the stack
 * up and forwards; this module only says how a port reads and when to look again.
 */

export type PortalState = "listening" | "starting" | "exited" | "stopped" | "timeout";

export interface PortalPort {
  name: string;
  port: number;
  kind: "service" | "process";
  state: PortalState;
  exitCode: number | null;
  detail: string | null;
  localPort: number | null;
}

export interface PortalView {
  project: string;
  ports: PortalPort[];
  url: string | null;
  settled: boolean;
}

/** How often a portal still bringing a port up looks again, and how many times at most. */
export const SETTLE_EVERY_MS = 1500;
export const SETTLE_LOOKS = 40;

/** The port as its row names it: `3000`, or `3000 → 3001` when the Mac forwards it from another. */
export function portLabel(port: PortalPort): string {
  return port.localPort !== null && port.localPort !== port.port
    ? `${port.port} → ${port.localPort}`
    : String(port.port);
}

/** What the row says of a port's state, in the operator's words. */
export function stateLabel(port: PortalPort): string {
  switch (port.state) {
    case "listening":
      return "listening";
    case "starting":
      return "starting…";
    case "exited":
      return port.exitCode === null ? "exited" : `exited ${port.exitCode}`;
    case "stopped":
      return "stopped";
    case "timeout":
      return "never listened";
  }
}

/** The line Copy puts on the clipboard for a port that failed: what to paste into a room. */
export function failureLine(project: string, port: PortalPort): string {
  const said = port.detail ? `: ${port.detail}` : "";
  return `${project} ${port.name} ${port.port} ${stateLabel(port)}${said}`;
}

/** The address a service port is reached at from this Mac. */
export function localAddress(port: PortalPort): string | null {
  return port.localPort === null ? null : `localhost:${port.localPort}`;
}

/** The sentence over the rows: what happened, or what to do when nothing listens. */
export function headline(view: PortalView): string {
  if (view.ports.length === 0) {
    return "No service or process declares a port: add `port` to a process in the project's definition.";
  }
  if (!view.settled) return `Bringing ${view.project} up.`;
  if (view.url) return `Opened ${view.url} in your browser. The ports stay forwarded while Mast is connected.`;
  if (view.ports.some((port) => port.kind === "process")) {
    return "No process listens, so nothing was opened.";
  }
  return "Its services are forwarded to this Mac; no process declares a port to open.";
}
