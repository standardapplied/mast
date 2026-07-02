import { describe, expect, test } from "bun:test";
import { resolveConfig, writeConfig, type ConfigIO } from "./config";

function fakeIO(files: Record<string, string> = {}, env: Record<string, string> = {}): ConfigIO & {
  files: Record<string, string>;
} {
  const store = { ...files };
  return {
    env,
    files: store,
    readFile: (path) => store[path] ?? null,
    writeFile: (path, content) => {
      store[path] = content;
    },
    configPath: "/home/u/.sail/config.yaml",
  };
}

describe("config resolution (CLI parity)", () => {
  test("defaults to loopback with no token", () => {
    const config = resolveConfig({}, fakeIO());
    expect(config).toEqual({ server: "http://127.0.0.1:7070", token: null });
  });

  test("reads server and token from ~/.sail/config.yaml", () => {
    const io = fakeIO({
      "/home/u/.sail/config.yaml": 'server: http://localhost:9999\ntoken: "sess_abc"\nhandle: uday\n',
    });
    expect(resolveConfig({}, io)).toEqual({ server: "http://127.0.0.1:9999", token: "sess_abc" });
  });

  test("env beats file; SAIL_TOKEN_FILE is read and trimmed", () => {
    const io = fakeIO(
      {
        "/home/u/.sail/config.yaml": "server: http://file:1\ntoken: file-token\n",
        "/secrets/token": "  tok_env_file  \n",
      },
      { SAIL_SERVER: "http://env:2", SAIL_TOKEN_FILE: "/secrets/token" },
    );
    expect(resolveConfig({}, io)).toEqual({ server: "http://env:2", token: "tok_env_file" });
  });

  test("SAIL_TOKEN beats SAIL_TOKEN_FILE; overrides beat everything", () => {
    const io = fakeIO({}, { SAIL_TOKEN: "tok_env", SAIL_TOKEN_FILE: "/nope", SAIL_SERVER: "http://env:2" });
    expect(resolveConfig({}, io).token).toBe("tok_env");
    expect(resolveConfig({ server: "http://cli:3", token: "tok_cli" }, io)).toEqual({
      server: "http://cli:3",
      token: "tok_cli",
    });
  });

  test("trailing slashes are stripped from the server", () => {
    expect(resolveConfig({ server: "http://x:1//" }, fakeIO()).server).toBe("http://x:1");
  });

  test("parses the CLI's flow-style config (the real thin-client format)", () => {
    const io = fakeIO({
      "/home/u/.sail/config.yaml":
        "{host: devbox, user: sail, server: 'http://localhost:7070', token: sess_b6b99639ab22}\n",
    });
    expect(resolveConfig({}, io)).toEqual({
      server: "http://127.0.0.1:7070",
      token: "sess_b6b99639ab22",
    });
  });

  test("localhost pins to 127.0.0.1 so fetch never dials the ::1 lane an ssh -L tunnel mishandles", () => {
    expect(resolveConfig({ server: "http://localhost:9999" }, fakeIO()).server).toBe(
      "http://127.0.0.1:9999",
    );
    expect(resolveConfig({}, fakeIO()).server).toBe("http://127.0.0.1:7070");
    expect(resolveConfig({ server: "http://node.internal:7070" }, fakeIO()).server).toBe(
      "http://node.internal:7070",
    );
  });
});

describe("writeConfig", () => {
  test("updates keys in place and preserves unrelated lines", () => {
    const io = fakeIO({
      "/home/u/.sail/config.yaml": "handle: uday\nserver: http://old:1\ntoken: old\n",
    });
    writeConfig({ server: "http://new:2", token: "sess_new" }, io);
    expect(io.files["/home/u/.sail/config.yaml"]).toBe(
      "handle: uday\nserver: 'http://new:2'\ntoken: sess_new\n",
    );
  });

  test("appends missing keys to a fresh file", () => {
    const io = fakeIO();
    writeConfig({ server: "http://n:1", token: "t" }, io);
    expect(io.files["/home/u/.sail/config.yaml"]).toBe("server: 'http://n:1'\ntoken: t\n");
  });

  test("updates a flow-style file in place, preserving style and other keys", () => {
    const io = fakeIO({
      "/home/u/.sail/config.yaml":
        "{host: devbox, user: sail, server: 'http://localhost:7070', token: old}\n",
    });
    writeConfig({ token: "sess_new" }, io);
    expect(io.files["/home/u/.sail/config.yaml"]).toBe(
      "{host: devbox, user: sail, server: 'http://localhost:7070', token: sess_new}\n",
    );
  });
});
