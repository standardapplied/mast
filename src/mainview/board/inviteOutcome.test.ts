import { describe, expect, test } from "bun:test";
import { mapInviteOutcome } from "./inviteOutcome";

describe("mapInviteOutcome", () => {
  test("a launched read-only invite names the principal", () => {
    const outcome = mapInviteOutcome(
      {
        ok: true,
        value: {
          run_id: "run-1",
          principal: "claude/invite-run-1",
          mode: "read_only",
          snapshot: "",
        },
      },
      "s1",
      "claude-code",
    );

    expect(outcome).toEqual({
      kind: "launched",
      message: "Invited claude-code (read only) into s1 as claude/invite-run-1.",
    });
  });

  test("a launched full invite names the snapshot it paid with", () => {
    const outcome = mapInviteOutcome(
      {
        ok: true,
        value: {
          run_id: "run-2",
          principal: "codex/invite-run-2",
          mode: "full",
          snapshot: "invite-run-2",
        },
      },
      "s1",
      "codex",
    );

    expect(outcome).toEqual({
      kind: "launched",
      message: "Invited codex (full access) into s1 as codex/invite-run-2 · snapshot invite-run-2.",
    });
  });

  test("a refusal carries the server's message and action verbatim", () => {
    const outcome = mapInviteOutcome(
      {
        ok: false,
        error: {
          status: 409,
          code: "agent_already_running",
          message: "Agent run r7 is already working spec 's1' in repo(s) [app].",
          action: "Wait for it to finish or stop it.",
        },
      },
      "s1",
      "codex",
    );

    expect(outcome).toEqual({
      kind: "refused",
      detail:
        "Agent run r7 is already working spec 's1' in repo(s) [app]. — Wait for it to finish or" +
        " stop it.",
    });
  });

  test("a refusal without an action is just the message", () => {
    const outcome = mapInviteOutcome(
      {
        ok: false,
        error: { status: 400, code: "bad_request", message: "Unknown agent CLI: 'gemini'." },
      },
      "s1",
      "gemini",
    );

    expect(outcome).toEqual({ kind: "refused", detail: "Unknown agent CLI: 'gemini'." });
  });
});
