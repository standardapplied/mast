import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { mode: 0o600 });
    },
    configPath: join(homedir(), ".sail", "config.yaml"),
  };
}

function yamlValue(line: string): string {
  const raw = line.slice(line.indexOf(":") + 1).trim();
  const unquoted = raw.replace(/^["']|["']$/g, "");
  return unquoted;
}

export function parseConfigYaml(content: string): Partial<SailConfig> {
  const out: Partial<SailConfig> = {};
  for (const line of content.split("\n")) {
    if (/^server\s*:/.test(line)) out.server = yamlValue(line);
    else if (/^token\s*:/.test(line)) out.token = yamlValue(line);
  }
  return out;
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

  return {
    server: (overrides.server ?? io.env.SAIL_SERVER ?? fromFile.server ?? DEFAULT_SERVER).replace(
      /\/+$/,
      "",
    ),
    token: overrides.token ?? envToken ?? fromFile.token ?? null,
  };
}

/** Update server/token in config.yaml in place, preserving every other line. */
export function writeConfig(update: Partial<SailConfig>, io: ConfigIO = defaultConfigIO()): void {
  const existing = io.readFile(io.configPath) ?? "";
  const lines = existing.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const setKey = (key: "server" | "token", value: string) => {
    const pattern = new RegExp(`^${key}\\s*:`);
    const index = lines.findIndex((l) => pattern.test(l));
    const line = `${key}: ${value}`;
    if (index >= 0) lines[index] = line;
    else lines.push(line);
  };

  if (update.server !== undefined) setKey("server", update.server);
  if (update.token !== undefined && update.token !== null) setKey("token", update.token);

  io.writeFile(io.configPath, lines.join("\n") + "\n");
}
