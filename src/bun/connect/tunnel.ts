import { tunnelCommand, type SshTarget } from "./ssh-target";

/**
 * Owns one `ssh -N -L` child: spawn (array form, no shell), health-check the
 * forwarded API, supervise with exponential backoff, kill on stop. Binds
 * 127.0.0.1 exclusively on both ends; BatchMode means ssh NEVER prompts (an
 * unknown host key or missing agent fails fast and is surfaced as an error —
 * host key checking stays fully enforced). All side effects are injected.
 */

export type TunnelState =
  | { phase: "idle" }
  | { phase: "starting"; port: number }
  | { phase: "up"; port: number; server: string }
  | { phase: "backoff"; retryInMs: number; lastError: string }
  | { phase: "failed"; lastError: string }
  | { phase: "stopped" };

export type TunnelChild = {
  exited: Promise<number | null>;
  kill: () => void;
};

export type TunnelDeps = {
  spawn: (argv: string[]) => TunnelChild;
  pickPort: () => Promise<number>;
  healthCheck: (server: string) => Promise<boolean>;
  schedule: (fn: () => void, ms: number) => () => void;
};

const HEALTH_ATTEMPTS = 20;
const HEALTH_INTERVAL_MS = 500;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 8;

export class TunnelManager {
  private state: TunnelState = { phase: "idle" };
  private child: TunnelChild | null = null;
  private stopped = false;
  private failures = 0;
  private readonly listeners = new Set<(state: TunnelState) => void>();

  constructor(
    private readonly target: SshTarget,
    private readonly deps: TunnelDeps,
  ) {}

  onState(listener: (state: TunnelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get currentState(): TunnelState {
    return this.state;
  }

  private setState(next: TunnelState): void {
    this.state = next;
    this.listeners.forEach((l) => l(next));
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.schedule(resolve, ms));
  }

  async start(): Promise<void> {
    while (!this.stopped) {
      let port: number;
      try {
        port = await this.deps.pickPort();
      } catch (error) {
        await this.failAndMaybeRetry(`No free local port: ${message(error)}`);
        if (this.state.phase === "failed" || this.stopped) return;
        continue;
      }

      this.setState({ phase: "starting", port });
      let child: TunnelChild;
      try {
        child = this.deps.spawn(tunnelCommand(this.target, port));
      } catch (error) {
        await this.failAndMaybeRetry(`ssh failed to launch: ${message(error)}`);
        if (this.state.phase === "failed" || this.stopped) return;
        continue;
      }
      this.child = child;
      const server = `http://127.0.0.1:${port}`;

      const healthy = await this.awaitHealthy(server, child);
      if (this.stopped) return;

      if (!healthy) {
        child.kill();
        await child.exited.catch(() => null);
        await this.failAndMaybeRetry("Tunnel never became healthy (ssh auth or forward failure?)");
        if (this.state.phase === "failed") return;
        continue;
      }

      this.failures = 0;
      this.setState({ phase: "up", port, server });

      const code = await child.exited.catch(() => null);
      this.child = null;
      if (this.stopped) return;
      await this.failAndMaybeRetry(`ssh exited (${code ?? "signal"})`);
      if (this.state.phase === "failed") return;
    }
  }

  private async awaitHealthy(server: string, child: TunnelChild): Promise<boolean> {
    let dead = false;
    void child.exited.then(() => {
      dead = true;
    });
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt++) {
      if (this.stopped || dead) return false;
      if (await this.deps.healthCheck(server).catch(() => false)) return true;
      await this.wait(HEALTH_INTERVAL_MS);
    }
    return false;
  }

  private async failAndMaybeRetry(lastError: string): Promise<void> {
    this.failures++;
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.setState({ phase: "failed", lastError });
      return;
    }
    const retryInMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
    this.setState({ phase: "backoff", retryInMs, lastError });
    await this.wait(retryInMs);
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    this.setState({ phase: "stopped" });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
