import { createServer } from "node:net";

/**
 * Ask the kernel for a free ephemeral port on 127.0.0.1 by binding port 0 and
 * releasing it. TOCTOU between release and ssh binding is real but benign:
 * ExitOnForwardFailure makes ssh exit if the port is taken, and the tunnel
 * supervisor retries on a fresh port.
 */
export function pickFreePort(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine bound port")));
        return;
      }
      const bound = address.port;
      server.close(() => resolve(bound));
    });
  });
}

/**
 * Prefer the canonical control-plane port so the tunnel's local origin
 * matches the WebAuthn allowlist; fall back to an ephemeral port (API traffic
 * works on any port — only the login ceremony needs the canonical one).
 */
export async function pickTunnelPort(preferred = 7070): Promise<number> {
  try {
    return await pickFreePort(preferred);
  } catch {
    return pickFreePort(0);
  }
}
