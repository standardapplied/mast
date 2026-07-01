/**
 * Exponential backoff with a cap, used by the updater's retry loop after a
 * failed check. Pure and deterministic so the schedule is unit-testable.
 */
export type BackoffOptions = {
  baseMs: number;
  maxMs: number;
};

export function backoffDelay(attempt: number, { baseMs, maxMs }: BackoffOptions): number {
  if (attempt <= 0) return baseMs;
  const delay = baseMs * 2 ** attempt;
  return Math.min(delay, maxMs);
}
