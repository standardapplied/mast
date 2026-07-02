import type { ConnectionStatus, EventStreamState, SailEvent } from "../../shared/sail-models";
import type { SailConfig } from "../api/config";
import { validateSshTarget } from "./ssh-target";
import type { TunnelState } from "./tunnel";
import { loginUrl, newState, type CallbackServerHandle } from "./login-callback";

/**
 * One state machine over the whole connection: reachability (direct or owned
 * tunnel), credential validity, and the SSE stream. "Ready" means all three
 * are healthy — the UI's Live pill derives from nothing else.
 *
 * Login mirrors the CLI ceremony: the SYSTEM BROWSER opens
 * {loginOrigin}/login with a loopback redirect; WebAuthn binds to the page
 * origin (clientDataJSON.origin is authenticator-signed and string-matched
 * server-side), which is why the ceremony uses the canonical origin — the
 * raw configured server, typically http://localhost:7070 — and why the owned
 * tunnel prefers local port 7070 before falling back to an ephemeral port
 * (API traffic works on any port; the ceremony does not).
 */

export type { ConnectionStatus } from "../../shared/sail-models";

export type TunnelLike = {
  start: () => Promise<void>;
  stop: () => void;
  onState: (listener: (state: TunnelState) => void) => () => void;
};

export type StreamLike = {
  start: () => Promise<void>;
  stop: () => void;
  onState: (listener: (state: EventStreamState) => void) => () => void;
  onEvent: (listener: (event: SailEvent) => void) => () => void;
};

export type ManagerDeps = {
  config: () => SailConfig;
  sshHost: () => string | null;
  probe: (server: string) => Promise<boolean>;
  validateToken: (server: string, token: string) => Promise<"ok" | "unauthenticated" | "unreachable">;
  makeTunnel: (host: string) => TunnelLike;
  makeStream: (server: string, token: string) => StreamLike;
  writeToken: (token: string) => void;
  openExternal: (url: string) => void;
  startCallback: (state: string) => CallbackServerHandle;
  onStack: (server: string, token: string | null) => void;
  onEvent: (event: SailEvent) => void;
};

export class ConnectionManager {
  private status: ConnectionStatus;
  private token: string | null;
  private tunnel: TunnelLike | null = null;
  private stream: StreamLike | null = null;
  private pendingLogin: CallbackServerHandle | null = null;
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();

  constructor(private readonly deps: ManagerDeps) {
    const config = deps.config();
    this.token = config.token;
    this.status = {
      phase: "probing",
      server: config.server,
      loginOrigin: config.loginOrigin,
      tokenPresent: config.token !== null,
      stream: "disconnected",
    };
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  private update(patch: Partial<ConnectionStatus>): void {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((l) => l(this.status));
  }

  async start(): Promise<void> {
    const config = this.deps.config();
    this.update({ phase: "probing", server: config.server });

    if (await this.deps.probe(config.server)) {
      await this.becomeReachable(config.server);
      return;
    }

    const host = validateSshTarget(this.deps.sshHost());
    if (!host) {
      this.update({
        phase: "no-host",
        detail:
          "Control plane unreachable and no ssh host: in ~/.sail/config.yaml to build a tunnel from.",
      });
      return;
    }

    this.update({ phase: "tunnel-connecting" });
    const tunnel = this.deps.makeTunnel(host.host);
    this.tunnel = tunnel;
    tunnel.onState((state) => void this.onTunnelState(state));
    void tunnel.start();
  }

  private async onTunnelState(state: TunnelState): Promise<void> {
    if (state.phase === "up") {
      await this.becomeReachable(state.server);
    } else if (state.phase === "backoff") {
      this.stopStream();
      this.update({ phase: "tunnel-degraded", detail: state.lastError });
    } else if (state.phase === "failed") {
      this.stopStream();
      this.update({ phase: "failed", detail: state.lastError });
    }
  }

  private async becomeReachable(server: string): Promise<void> {
    this.update({ server });
    this.deps.onStack(server, this.token);

    if (!this.token) {
      this.update({ phase: "unauthenticated", tokenPresent: false });
      return;
    }
    const verdict = await this.deps.validateToken(server, this.token);
    if (verdict === "ok") {
      this.update({ phase: "ready", tokenPresent: true });
      this.startStream(server, this.token);
    } else if (verdict === "unauthenticated") {
      this.update({
        phase: "unauthenticated",
        tokenPresent: true,
        detail: "Session expired or token invalid — sign in again.",
      });
    } else {
      this.update({ phase: "tunnel-degraded", detail: "Reachable then not — retrying." });
    }
  }

  private startStream(server: string, token: string): void {
    this.stopStream();
    const stream = this.deps.makeStream(server, token);
    this.stream = stream;
    stream.onState((state) => this.update({ stream: state }));
    stream.onEvent((event) => this.deps.onEvent(event));
    void stream.start();
  }

  private stopStream(): void {
    this.stream?.stop();
    this.stream = null;
    this.update({ stream: "disconnected" });
  }

  /** Any API call answered 401/403 auth-invalid lands here (via handlers). */
  onAuthError(): void {
    if (this.status.phase !== "ready") return;
    this.stopStream();
    this.update({
      phase: "unauthenticated",
      detail: "Session expired or token invalid — sign in again.",
    });
  }

  /** Browser ceremony: resolves true when signed in and ready. */
  async login(): Promise<{ ok: boolean; detail?: string }> {
    if (this.pendingLogin) return { ok: false, detail: "A sign-in is already in progress." };

    const state = newState();
    const callback = this.deps.startCallback(state);
    this.pendingLogin = callback;
    this.deps.openExternal(loginUrl(this.status.loginOrigin, callback.port, state));

    const result = await callback.result;
    this.pendingLogin = null;

    if ("error" in result) return { ok: false, detail: result.error };

    this.deps.writeToken(result.token);
    this.token = result.token;
    await this.becomeReachable(this.status.server);
    const ready = this.status.phase === "ready";
    return ready ? { ok: true } : { ok: false, detail: this.status.detail };
  }

  stop(): void {
    this.pendingLogin?.stop();
    this.stopStream();
    this.tunnel?.stop();
    this.tunnel = null;
  }
}
