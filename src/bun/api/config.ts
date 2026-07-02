import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Connection config with CLI parity, resolved in the same order as the `sail`
 * CLI: explicit overrides → SAIL_SERVER / SAIL_TOKEN / SAIL_TOKEN_FILE env →
 * ~/.sail/config.yaml (`server:` / `token:`) → default localhost. Reading AND
 * writing the same file keeps Mast and the CLI in sync.
 */

export type SailConfig = {
  server: string;
  token: string | null;
  /**
   * The raw configured origin (before the 127.0.0.1 pin) — the passkey
   * ceremony must load from EXACTLY this origin string because WebAuthn
   * string-matches clientDataJSON.origin against the server's allowlist.
   */
  loginOrigin: string;
};

export type ConfigIO = {
  env: Record<string, string | undefined>;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  configPath: string;
};

export const DEFAULT_SERVER = "http://localhost:7070";

export function defaultConfigIO(): ConfigIO {
  return {
    env: process.env,
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    configPath: join(homedir(), ".sail", "config.yaml"),
  };
}

function unquote(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

function isFlowStyle(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

/**
 * Split a YAML flow mapping's interior into key/value pairs, respecting
 * quotes (the CLI single-quotes URLs, whose colons would otherwise split).
 */
export function parseFlowPairs(content: string): Array<[string, string]> {
  const inner = content.trim().slice(1, -1);
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  const pairs: Array<[string, string]> = [];
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    pairs.push([part.slice(0, colon).trim(), unquote(part.slice(colon + 1))]);
  }
  return pairs;
}

type ParsedConfig = Partial<SailConfig> & { host?: string };

/**
 * The CLI's SnakeYAML writes small configs in FLOW style —
 * `{host: devbox, server: 'http://localhost:7070', token: ...}` — and larger
 * ones in block style. Parse both.
 */
export function parseConfigYaml(content: string): ParsedConfig {
  const out: ParsedConfig = {};
  const take = (key: string, value: string) => {
    if (key === "server") out.server = value;
    else if (key === "token") out.token = value;
    else if (key === "host") out.host = value;
  };
  if (isFlowStyle(content)) {
    for (const [key, value] of parseFlowPairs(content)) take(key, value);
    return out;
  }
  for (const line of content.split("\n")) {
    const match = line.match(/^(server|token|host)\s*:/);
    if (match) take(match[1]!, unquote(line.slice(line.indexOf(":") + 1)));
  }
  return out;
}

/** The ssh host/alias for the tunnel autopilot (null when not configured). */
export function resolveSshHost(io: ConfigIO = defaultConfigIO()): string | null {
  const file = io.readFile(io.configPath);
  if (!file) return null;
  return parseConfigYaml(file).host ?? null;
}

export function resolveConfig(
  overrides: Partial<SailConfig> = {},
  io: ConfigIO = defaultConfigIO(),
): SailConfig {
  const file = io.readFile(io.configPath);
  const fromFile = file ? parseConfigYaml(file) : {};

  const envToken =
    io.env.SAIL_TOKEN ??
    (io.env.SAIL_TOKEN_FILE ? (io.readFile(io.env.SAIL_TOKEN_FILE)?.trim() ?? null) : undefined);

  const rawServer = (overrides.server ?? io.env.SAIL_SERVER ?? fromFile.server ?? DEFAULT_SERVER)
    .replace(/\/+$/, "");

  return {
    server: rawServer.replace("://localhost", "://127.0.0.1"),
    loginOrigin: rawServer,
    token: overrides.token ?? envToken ?? fromFile.token ?? null,
  };
}

function flowValue(value: string): string {
  return /[:#,{}\[\]]/.test(value) ? `'${value}'` : value;
}

/**
 * Update server/token in config.yaml in place, preserving every other key and
 * the file's own style — flow files stay flow, block files stay block.
 */
export function writeConfig(update: Partial<SailConfig>, io: ConfigIO = defaultConfigIO()): void {
  const existing = io.readFile(io.configPath) ?? "";
  const updates: Array<["server" | "token", string]> = [];
  if (update.server !== undefined) updates.push(["server", update.server]);
  if (update.token !== undefined && update.token !== null) updates.push(["token", update.token]);

  if (isFlowStyle(existing)) {
    const pairs = parseFlowPairs(existing);
    for (const [key, value] of updates) {
      const index = pairs.findIndex(([k]) => k === key);
      if (index >= 0) pairs[index] = [key, value];
      else pairs.push([key, value]);
    }
    const body = pairs.map(([k, v]) => `${k}: ${flowValue(v)}`).join(", ");
    io.writeFile(io.configPath, `{${body}}\n`);
    return;
  }

  const lines = existing.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const [key, value] of updates) {
    const pattern = new RegExp(`^${key}\\s*:`);
    const index = lines.findIndex((l) => pattern.test(l));
    const line = `${key}: ${flowValue(value)}`;
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  }
  io.writeFile(io.configPath, lines.join("\n") + "\n");
}
