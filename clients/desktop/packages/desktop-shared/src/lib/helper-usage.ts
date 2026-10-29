export interface HelperUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
  messageCount?: number;
  assistantMessageCount?: number;
}

function sumOptional(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

/** Add provider usage from separate helper attempts without inventing zeroes. */
export function mergeHelperUsage(
  left: HelperUsage,
  right: HelperUsage,
): HelperUsage {
  return {
    inputTokens: sumOptional(left.inputTokens, right.inputTokens),
    outputTokens: sumOptional(left.outputTokens, right.outputTokens),
    cacheReadInputTokens: sumOptional(
      left.cacheReadInputTokens,
      right.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: sumOptional(
      left.cacheCreationInputTokens,
      right.cacheCreationInputTokens,
    ),
    reasoningOutputTokens: sumOptional(
      left.reasoningOutputTokens,
      right.reasoningOutputTokens,
    ),
    totalCostUsd: sumOptional(left.totalCostUsd, right.totalCostUsd),
    messageCount: sumOptional(left.messageCount, right.messageCount),
    assistantMessageCount: sumOptional(
      left.assistantMessageCount,
      right.assistantMessageCount,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Read the standard `usage` payload carried by helper results and errors.
 * Returns undefined for unrelated retry results such as plain strings.
 */
export function readHelperUsage(value: unknown): HelperUsage | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) {
    return undefined;
  }
  const usage = value.usage;
  const normalized: HelperUsage = {
    inputTokens: readOptionalNumber(usage, 'inputTokens'),
    outputTokens: readOptionalNumber(usage, 'outputTokens'),
    cacheReadInputTokens: readOptionalNumber(usage, 'cacheReadInputTokens'),
    cacheCreationInputTokens: readOptionalNumber(
      usage,
      'cacheCreationInputTokens',
    ),
    reasoningOutputTokens: readOptionalNumber(usage, 'reasoningOutputTokens'),
    totalCostUsd: readOptionalNumber(usage, 'totalCostUsd'),
    messageCount: readOptionalNumber(usage, 'messageCount'),
    assistantMessageCount: readOptionalNumber(usage, 'assistantMessageCount'),
  };
  return Object.values(normalized).some((entry) => entry !== undefined)
    ? normalized
    : undefined;
}

/** Replace a standard helper result/error usage payload with a merged total. */
export function writeHelperUsage(value: unknown, usage: HelperUsage): void {
  if (!isRecord(value) || !isRecord(value.usage)) {
    return;
  }
  Object.assign(value.usage, usage);
}
