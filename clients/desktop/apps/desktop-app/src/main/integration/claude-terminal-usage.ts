export interface ClaudeTerminalTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumberField(value: unknown, field: string): number | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === 'number' ? fieldValue : undefined;
}

export function emptyClaudeTerminalTurnUsage(): ClaudeTerminalTurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/**
 * Accumulate token usage from a raw Claude transcript assistant event.
 * Output and cache-creation tokens add up across API calls; input and
 * cache-read tokens reflect the final context, so the latest value wins.
 */
export function accumulateClaudeTerminalTurnUsage(
  usage: ClaudeTerminalTurnUsage,
  event: unknown,
): void {
  if (!isUnknownRecord(event) || event.type !== 'assistant') {
    return;
  }
  const message = event.message;
  const messageUsage = isUnknownRecord(message) ? message.usage : undefined;
  if (!isUnknownRecord(messageUsage)) {
    return;
  }
  usage.outputTokens += readNumberField(messageUsage, 'output_tokens') ?? 0;
  usage.cacheCreationInputTokens +=
    readNumberField(messageUsage, 'cache_creation_input_tokens') ?? 0;
  const inputTokens = readNumberField(messageUsage, 'input_tokens');
  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  const cacheRead = readNumberField(messageUsage, 'cache_read_input_tokens');
  if (cacheRead !== undefined) {
    usage.cacheReadInputTokens = cacheRead;
  }
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!isUnknownRecord(value)) {
    return undefined;
  }
  const fieldValue = value[field];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function transcriptEventId(event: unknown): string | undefined {
  return (
    readStringField(event, 'uuid') ??
    readStringField(event, 'id') ??
    readStringField(event, 'message_id')
  );
}

/**
 * Accumulate usage from the events a single transcript sync imported, guarding
 * against replay double-counting.
 *
 * A transcript sync re-reads the file from byte 0 whenever its cursor is lost
 * (`replayedFromStart`), which re-emits the session's entire history. Because
 * `accumulateClaudeTerminalTurnUsage` *adds* output and cache-creation tokens
 * across API calls, blindly folding a replay's events inflates those sums by a
 * multiple of the real total. On a replay we therefore count only the events
 * whose id matches a genuinely-new imported message, mirroring the interactive
 * terminal path (`claude-terminal-session-service.feedAuditTranscriptEvents`)
 * so both paths stay consistent. Non-replay (incremental) syncs already carry
 * only new events, so they are folded as-is.
 */
export function accumulateImportedTranscriptUsage(
  usage: ClaudeTerminalTurnUsage,
  params: {
    importedEvents: unknown[];
    importedMessageIds: string[];
    replayedFromStart: boolean;
  },
): void {
  let events = params.importedEvents;
  if (params.replayedFromStart) {
    const newMessageIds = new Set(params.importedMessageIds);
    events = events.filter((event) => {
      const eventId = transcriptEventId(event);
      return eventId !== undefined && newMessageIds.has(eventId);
    });
  }
  for (const event of events) {
    accumulateClaudeTerminalTurnUsage(usage, event);
  }
}
