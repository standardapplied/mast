/**
 * A macOS `.app` launched from Finder inherits a bare PATH and no LANG — it does
 * NOT see anything from the user's `~/.zshrc`/`~/.zprofile`. Before Mast shells
 * out (ssh, rsync, agents) we must resolve the user's real login-shell
 * environment. Heavy dotfiles can take 5–30s, so callers gate first
 * connect/dispatch on this completing.
 */

const DELIMITER = "_MAST_SHELL_ENV_DELIMITER_";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Parse the `env` dump printed between two delimiter markers. Pure so the
 * parsing contract is unit-testable without spawning a shell.
 */
export function parseShellEnv(stdout: string, delimiter = DELIMITER): Record<string, string> {
  const start = stdout.indexOf(delimiter);
  const end = stdout.lastIndexOf(delimiter);
  if (start === -1 || end <= start) return {};

  const body = stdout.slice(start + delimiter.length, end);
  const env: Record<string, string> = {};
  for (const line of body.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

/**
 * Run the user's login shell and capture its environment. Returns a snapshot of
 * the current `process.env` on non-macOS platforms or if resolution yields
 * nothing (already-correct env when launched from a terminal).
 */
export async function resolveShellEnv(
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  const current = { ...process.env } as Record<string, string>;
  if (process.platform !== "darwin") return current;

  const shell = process.env.SHELL || "/bin/zsh";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const command = `echo -n "${DELIMITER}"; env; echo -n "${DELIMITER}"`;

  const proc = Bun.spawn([shell, "-ilc", command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
  });

  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const resolved = parseShellEnv(stdout);
    return Object.keys(resolved).length > 0 ? resolved : current;
  } catch {
    return current;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge a resolved login-shell environment into `process.env` so subsequently
 * spawned children (ssh/rsync/agents) inherit the correct PATH, LANG, etc.
 */
export function hydrateProcessEnv(resolved: Record<string, string>): void {
  for (const [key, value] of Object.entries(resolved)) {
    process.env[key] = value;
  }
}
