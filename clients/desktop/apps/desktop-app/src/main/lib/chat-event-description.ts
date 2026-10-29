interface DescribeChatEventDataOptions {
  includePhaseEvents?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeChatEventData(
  data: unknown,
  options?: DescribeChatEventDataOptions,
): string {
  if (!isRecord(data)) {
    return typeof data;
  }

  const type = typeof data.type === 'string' ? data.type : 'unknown';
  if (options?.includePhaseEvents === true && type === 'phase') {
    const phase = typeof data.phase === 'string' ? data.phase : 'unknown';
    return `phase:${phase}`;
  }

  if (type !== 'codex') {
    return type;
  }

  const event = isRecord(data.event) ? data.event : null;
  const eventType = event && typeof event.type === 'string' ? event.type : null;
  return eventType ? `codex:${eventType}` : 'codex';
}
