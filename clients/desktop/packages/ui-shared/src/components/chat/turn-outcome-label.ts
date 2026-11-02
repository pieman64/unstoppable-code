import type { TurnOutcomeCounts } from '@canopy/protocol/portal';

/**
 * One outcome count in words: "2 blocked", "1 error", "3 errors",
 * "1 interrupted". Callers pass nonzero counts only.
 */
export function formatTurnOutcomeLabel(
  key: keyof TurnOutcomeCounts,
  count: number,
): string {
  if (key === 'blocked') return `${count} blocked`;
  if (key === 'interrupted') return `${count} interrupted`;
  return `${count} ${count === 1 ? 'error' : 'errors'}`;
}

/** The order every outcome surface reads in: blocked, errors, interrupted. */
export const TURN_OUTCOME_ORDER: readonly (keyof TurnOutcomeCounts)[] = [
  'blocked',
  'failed',
  'interrupted',
];

/** Tool results alone cannot establish whether the agent recovered. */
export const TURN_OUTCOME_UNKNOWN_IMPACT = 'Effect on the result is unknown';
