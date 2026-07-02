/**
 * The tunnel's ssh destination comes from ~/.sail/config.yaml, which is
 * user-writable — treat it as untrusted input. The target is validated to a
 * strict hostname/alias charset and rejected outright if it could ever be
 * parsed as an ssh OPTION (leading '-') or smuggle words past the argv
 * boundary (whitespace/control chars). ssh is always spawned in array form
 * (no shell) with '--' before the destination as a second fence.
 *
 * Deliberately NOT used: the config's `user:` key. That user (`sail`) is the
 * control-plane gateway identity — a forced-command, `restrict`ed account
 * where port forwarding is disabled by design. Tunnels ride the engineer's
 * own ssh alias/identity for the host, exactly like the manual
 * `ssh -N -L 7070:localhost:7070 devbox` this replaces; ~/.ssh/config
 * resolves user and key material.
 */

const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_HOST_LENGTH = 253;

export type SshTarget = { host: string };

export function validateSshTarget(host: string | undefined | null): SshTarget | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HOST_LENGTH) return null;
  if (!HOST_PATTERN.test(trimmed)) return null;
  return { host: trimmed };
}

export function tunnelCommand(target: SshTarget, localPort: number, remotePort = 7070): string[] {
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error(`Refusing to bind tunnel to port ${localPort}`);
  }
  return [
    "ssh",
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    "--",
    target.host,
  ];
}
