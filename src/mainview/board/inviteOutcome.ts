import type { InviteResponse } from "../../shared/sail-models";
import type { SailResult } from "../../shared/types";

/**
 * Maps an invite result to what the dialog does next. Success closes and
 * toasts the launched run. Any refusal keeps the dialog open and renders the
 * server's words verbatim — the reservation vocabulary on a 409, the mode
 * refusal on a 400, the policy refusal on a 403 — so the user sees exactly
 * what the control plane decided, never a guessed cause.
 */
export type InviteOutcome =
  | { kind: "launched"; message: string }
  | { kind: "refused"; detail: string };

export function mapInviteOutcome(
  result: SailResult<InviteResponse>,
  specId: string,
  agent: string,
): InviteOutcome {
  if (!result.ok) {
    const detail = `${result.error.message}${result.error.action ? ` — ${result.error.action}` : ""}`;
    return { kind: "refused", detail };
  }
  const mode = result.value.mode === "full" ? "full access" : "read only";
  const snapshot = result.value.snapshot ? ` · snapshot ${result.value.snapshot}` : "";
  return {
    kind: "launched",
    message: `Invited ${agent} (${mode}) into ${specId} as ${result.value.principal}${snapshot}.`,
  };
}
