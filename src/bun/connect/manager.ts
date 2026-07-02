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
 * A generation counter fences async transitions: every connect attempt bumps
 * it, and a continuation whose generation is stale (a later attempt or stop()
 * superseded it) is discarded — so a validateToken/tunnel-up resolving late
 * can never revive a dead connection. A supervisor timer re-attempts the
 * connect sequence from any recoverable-not-connected phase, so a transient
 * blip self-heals instead of dead-ending.
 *
 * Login mirrors the CLI ceremony: the SYSTEM BROWSER opens {loginOrigin}/login
 * with a loopback redirect; WebAuthn binds to the page origin (authenticator-
 * signed, string-matched server-side), so the ceremony uses the canonical
 * origin and is refused unless that origin is loopback (a remote cleartext
 * origin would put the state nonce and session token on the wire).
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
  /** Re-attempt recoverable phases on this cadence; injected for tests. */
  scheduleSupervisor: (fn: () => void) => () => void;
};

/** Phases that a periodic re-attempt can recover from (server may come back). */
const RECOVERABLE = new Set<ConnectionStatus["phase"]>(["tunnel-degraded", "failed", "no-host"]);

function tokenKind(token: string | null): "session" | "api" | "none" {
  if (!token) return "none";
  return token.startsWith("sess_") ? "session" : "api";
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export class ConnectionManager {
  private status: ConnectionStatus;
  private token: string | null;
  private tunnel: TunnelLike | null = null;
  private stream: StreamLike | null = null;
  private pendingLogin: CallbackServerHandle | null = null;
  private generation = 0;
  private stopped = false;
  private cancelSupervisor: (() => void) | null = null;
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();

  constructor(private readonly deps: ManagerDeps) {
    const config = deps.config();
    this.token = config.token;
    this.status = {
      phase: "probing",
      server: config.server,
      loginOrigin: config.loginOrigin,
      tokenPresent: config.token !== null,
      tokenKind: tokenKind(config.token),
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

  /** Begin, and arm the supervisor that re-attempts recoverable phases. */
  async start(): Promise<void> {
    this.cancelSupervisor = this.deps.scheduleSupervisor(() => {
      if (!this.stopped && RECOVERABLE.has(this.status.phase)) void this.connect();
    });
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.tunnel?.stop();
    this.tunnel = null;

    const config = this.deps.config();
    this.token = config.token;
    this.update({ phase: "probing", server: config.server, loginOrigin: config.loginOrigin });

    if (await this.deps.probe(config.server)) {
      await this.becomeReachable(config.server, gen);
      return;
    }
    if (gen !== this.generation || this.stopped) return;

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
    tunnel.onState((state) => void this.onTunnelState(state, gen));
    void tunnel.start();
  }

  private async onTunnelState(state: TunnelState, gen: number): Promise<void> {
    if (gen !== this.generation || this.stopped) return;
    if (state.phase === "up") {
      await this.becomeReachable(state.server, gen);
    } else if (state.phase === "backoff") {
      this.stopStream();
      this.update({ phase: "tunnel-degraded", detail: state.lastError });
    } else if (state.phase === "failed") {
      this.stopStream();
      this.update({ phase: "failed", detail: state.lastError });
    }
  }

  private async becomeReachable(server: string, gen: number): Promise<void> {
    if (gen !== this.generation || this.stopped) return;
    this.update({ server });
    this.deps.onStack(server, this.token);

    if (!this.token) {
      this.update({ phase: "unauthenticated", tokenPresent: false, tokenKind: "none" });
      return;
    }
    const verdict = await this.deps.validateToken(server, this.token);
    if (gen !== this.generation || this.stopped) return;

    if (verdict === "ok") {
      this.update({ phase: "ready", tokenPresent: true, tokenKind: tokenKind(this.token) });
      this.startStream(server, this.token, gen);
    } else if (verdict === "unauthenticated") {
      this.update({
        phase: "unauthenticated",
        tokenPresent: true,
        tokenKind: tokenKind(this.token),
        detail: "Session expired or token invalid — sign in again.",
      });
    } else {
      this.update({ phase: "tunnel-degraded", detail: "Reachable then not — retrying." });
    }
  }

  private startStream(server: string, token: string, gen: number): void {
    this.stopStream();
    const stream = this.deps.makeStream(server, token);
    this.stream = stream;
    stream.onState((state) => {
      if (gen === this.generation) this.update({ stream: state });
    });
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
    this.generation++;
    this.stopStream();
    this.update({
      phase: "unauthenticated",
      detail: "Session expired or token invalid — sign in again.",
    });
  }

  /** Browser ceremony: resolves true when signed in and ready. */
  async login(): Promise<{ ok: boolean; detail?: string }> {
    if (this.pendingLogin) return { ok: false, detail: "A sign-in is already in progress." };
    if (!isLoopbackOrigin(this.status.loginOrigin)) {
      return {
        ok: false,
        detail: "Passkey sign-in requires a local or tunnelled control plane, not a remote origin.",
      };
    }

    const state = newState();
    const callback = this.deps.startCallback(state);
    this.pendingLogin = callback;
    this.deps.openExternal(loginUrl(this.status.loginOrigin, callback.port, state));

    const result = await callback.result;
    this.pendingLogin = null;
    if (this.stopped) return { ok: false, detail: "Cancelled." };

    if ("error" in result) return { ok: false, detail: result.error };

    this.deps.writeToken(result.token);
    this.token = result.token;
    const gen = ++this.generation;
    await this.becomeReachable(this.status.server, gen);
    const ready = this.status.phase === "ready";
    return ready ? { ok: true } : { ok: false, detail: this.status.detail };
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.cancelSupervisor?.();
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    this.stopStream();
    this.tunnel?.stop();
    this.tunnel = null;
  }
}
