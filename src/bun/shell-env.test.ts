import { describe, expect, test } from "bun:test";
import { parseShellEnv } from "./shell-env";

const DELIM = "_MAST_SHELL_ENV_DELIMITER_";

describe("parseShellEnv", () => {
  test("parses the env dump between delimiters", () => {
    const stdout = `noise\n${DELIM}PATH=/usr/bin:/bin\nLANG=en_US.UTF-8\nEMPTY=\n${DELIM}\ntrailing`;
    expect(parseShellEnv(stdout, DELIM)).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      EMPTY: "",
    });
  });

  test("keeps '=' in values", () => {
    const stdout = `${DELIM}KEY=a=b=c${DELIM}`;
    expect(parseShellEnv(stdout, DELIM)).toEqual({ KEY: "a=b=c" });
  });

  test("returns empty when delimiters are missing", () => {
    expect(parseShellEnv("PATH=/usr/bin", DELIM)).toEqual({});
  });
});
