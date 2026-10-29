/** Exact counters from Cursor's latest reported response, not session totals. */
export interface CursorReportedUsage {
  /** Includes cache reads/writes in the pinned runtime's hook contract. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseCursorReportedUsage(
  value: unknown,
): CursorReportedUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  if (
    !('inputTokens' in value) ||
    !isCounter(value.inputTokens) ||
    !('outputTokens' in value) ||
    !isCounter(value.outputTokens)
  )
    return undefined;
  const cacheReadTokens =
    'cacheReadTokens' in value ? value.cacheReadTokens : undefined;
  const cacheWriteTokens =
    'cacheWriteTokens' in value ? value.cacheWriteTokens : undefined;
  if (cacheReadTokens !== undefined && !isCounter(cacheReadTokens))
    return undefined;
  if (cacheWriteTokens !== undefined && !isCounter(cacheWriteTokens))
    return undefined;
  if ((cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) > value.inputTokens)
    return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}
