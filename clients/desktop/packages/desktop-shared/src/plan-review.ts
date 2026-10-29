/** Explicit review mode wins over the legacy Codex and OpenCode source fallbacks. */
export function isPlanProposal(
  value:
    | {
        reviewMode?: unknown;
        source?: unknown;
      }
    | null
    | undefined,
): boolean {
  return value?.reviewMode !== undefined
    ? value.reviewMode === 'proposal'
    : value?.source === 'codex' || value?.source === 'opencode';
}

export const CURSOR_PLAN_EXECUTION_UNAVAILABLE =
  'Cursor plan execution is unavailable.';
