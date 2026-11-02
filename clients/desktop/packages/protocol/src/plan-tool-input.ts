const WIRE_TRUNCATION_MARKER = /\[truncated \d+ chars\]$/;
/** Claude Code's default plans directory, `~/.claude/plans`. */
const DEFAULT_PLANS_DIRECTORY_FILE =
  /(?:^|[\\/])\.claude[\\/]plans[\\/][^\\/]+\.md$/i;

export type ParsedToolInput =
  | { readonly kind: 'record'; readonly record: Record<string, unknown> }
  | { readonly kind: 'truncated' }
  | { readonly kind: 'invalid' };

export function parseToolInput(input: unknown): ParsedToolInput {
  if (typeof input === 'string') {
    if (WIRE_TRUNCATION_MARKER.test(input)) return { kind: 'truncated' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return { kind: 'invalid' };
    }
    return parseToolInput(parsed);
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { kind: 'invalid' };
  }
  return { kind: 'record', record: { ...input } };
}

/** Matches the established artifact path convention, without filesystem access. */
export function isDefaultPlanFilePath(path: string): boolean {
  return DEFAULT_PLANS_DIRECTORY_FILE.test(path);
}

/**
 * Recognizes Claude Code plan-file Write calls, independently of mode or result.
 * This convention identifies an artifact, not proof of plan mode or success.
 * Unknown, malformed and truncated inputs cannot establish plan-file identity.
 */
export function isPlanFileWrite(toolName: string, input: unknown): boolean {
  if (toolName !== 'Write') return false;
  const parsed = parseToolInput(input);
  if (parsed.kind !== 'record') return false;
  const path = parsed.record['file_path'];
  return typeof path === 'string' && isDefaultPlanFilePath(path);
}
