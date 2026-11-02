import { isRecord } from './type-guards';
import type { AgentProviderType } from '@canopy/desktop-shared/types';

// SDK `TerminalReason` values that represent a user-initiated abort rather than
// a real error. The Claude SDK can end a streaming turn by gracefully yielding a
// `result` message with `is_error: true` and one of these terminal reasons (e.g.
// the user hit Stop mid-stream); that must be classified as a user interrupt, not
// a failure. See node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts (TerminalReason).
// NOTE: keep this list in sync with the duplicate in the renderer's chatStore
// (`USER_ABORT_TERMINAL_REASONS` in stores/chatStore.ts). They live in separate
// process bundles (main vs renderer) so a shared import isn't appropriate here.
const USER_ABORT_TERMINAL_REASONS = ['aborted_streaming', 'aborted_tools'];

/**
 * Whether a result ends its turn by a user-initiated abort. Abort reasons only
 * ever arrive on `result` events; guard on the type so a future non-result
 * event carrying a matching string can't be misclassified.
 */
export function isUserAbortResult(eventData: Record<string, unknown>): boolean {
  return (
    eventData.type === 'result' &&
    typeof eventData.terminal_reason === 'string' &&
    USER_ABORT_TERMINAL_REASONS.includes(eventData.terminal_reason)
  );
}

/**
 * Whether a result ends a Claude turn whose plan went to Canopy's review: the
 * session interrupts the turn on purpose and marks its result, which the SDK
 * reports as an aborted tool call.
 */
export function isPlanHandoffResult(
  eventData: Record<string, unknown>,
): boolean {
  return eventData.type === 'result' && eventData.canopy_plan_handoff === true;
}

export function getChatTurnAuditStatus(
  eventData: Record<string, unknown>,
): 'success' | 'failure' | 'cancelled' | 'interrupted' {
  if (isPlanHandoffResult(eventData)) return 'success';
  // A user-initiated abort can surface as a gracefully-yielded result with
  // `is_error: true`, so check `terminal_reason` before the error branch below.
  if (isUserAbortResult(eventData)) return 'interrupted';

  if (
    eventData.type === 'error' ||
    eventData.is_error === true ||
    (eventData.type === 'codex' &&
      isRecord(eventData.event) &&
      (eventData.event.type === 'error' ||
        eventData.event.type === 'turn.failed'))
  ) {
    return 'failure';
  }

  const resultText =
    typeof eventData.result === 'string'
      ? eventData.result.trim().toLowerCase()
      : '';

  if (resultText === 'turn cancelled') {
    return 'cancelled';
  }

  if (resultText === 'session aborted' || resultText === 'session ended') {
    return 'interrupted';
  }

  return 'success';
}

export function isTerminalChatEventData(data: unknown): boolean {
  if (!isRecord(data)) {
    return false;
  }

  if (data.type === 'error') {
    return true;
  }

  if (data.type === 'codex' && isRecord(data.event)) {
    return (
      data.event.type === 'turn.completed' || data.event.type === 'turn.failed'
    );
  }

  return data.type === 'result' && data.canopy_session_continues !== true;
}

export function readCodexRootThreadId(data: unknown): string | undefined {
  if (
    !isRecord(data) ||
    data.type !== 'system' ||
    data.subtype !== 'init' ||
    typeof data.session_id !== 'string'
  ) {
    return undefined;
  }
  return data.session_id;
}

export function readCodexRootTurnId(
  data: unknown,
  rootThreadId: string | undefined,
): string | undefined {
  if (
    !rootThreadId ||
    !isRecord(data) ||
    data.type !== 'codex' ||
    !isRecord(data.event) ||
    data.event.type !== 'turn.started' ||
    data.event.thread_id !== rootThreadId ||
    typeof data.event.turn_id !== 'string'
  ) {
    return undefined;
  }
  return data.event.turn_id;
}

export function isStaleCodexRootErrorEvent(
  data: unknown,
  rootThreadId: string | undefined,
  rootTurnId: string | undefined,
): boolean {
  return Boolean(
    rootThreadId &&
    rootTurnId &&
    isRecord(data) &&
    data.type === 'codex' &&
    isRecord(data.event) &&
    data.event.type === 'error' &&
    data.event.thread_id === rootThreadId &&
    typeof data.event.turn_id === 'string' &&
    data.event.turn_id !== rootTurnId,
  );
}

export function isCodexSubagentTerminalEvent(
  data: unknown,
  rootThreadId: string | undefined,
): boolean {
  if (!rootThreadId || !isRecord(data) || data.type !== 'codex') return false;
  const event = data.event;
  if (!isRecord(event)) return false;
  if (
    event.type !== 'error' &&
    event.type !== 'turn.failed' &&
    event.type !== 'turn.completed'
  ) {
    return false;
  }
  return (
    typeof event.thread_id === 'string' && event.thread_id !== rootThreadId
  );
}

/**
 * Late subagent lifecycle and hydration events may arrive after the root turn
 * settles. They update an existing child card and must not revive the root
 * runtime or admit unrelated late Codex output.
 */
export function isCodexSubagentFollowupEvent(
  data: unknown,
  rootThreadId: string | undefined,
): boolean {
  if (!rootThreadId || !isRecord(data) || data.type !== 'codex') return false;
  const event = data.event;
  if (!isRecord(event)) return false;
  if (isCodexSubagentTerminalEvent(data, rootThreadId)) return true;
  if (event.type === 'thread.started') {
    return (
      typeof event.thread_id === 'string' && event.thread_id !== rootThreadId
    );
  }
  if (
    event.type !== 'item.started' &&
    event.type !== 'item.updated' &&
    event.type !== 'item.completed'
  ) {
    return false;
  }
  if (typeof event.thread_id === 'string' && event.thread_id !== rootThreadId) {
    return true;
  }
  const item = event.item;
  if (!isRecord(item)) return false;
  const itemType = item.type;
  const kind = item.kind;
  const agentThreadId =
    typeof item.agent_thread_id === 'string'
      ? item.agent_thread_id
      : typeof item.agentThreadId === 'string'
        ? item.agentThreadId
        : undefined;
  return (
    (itemType === 'sub_agent_activity' || itemType === 'subagent_activity') &&
    (kind === 'started' || kind === 'completed' || kind === 'interrupted') &&
    typeof agentThreadId === 'string' &&
    agentThreadId !== rootThreadId
  );
}

export function isRootTerminalChatEventData(
  data: unknown,
  codexRootThreadId: string | undefined,
  codexRootTurnId?: string,
): boolean {
  if (isStaleCodexRootErrorEvent(data, codexRootThreadId, codexRootTurnId)) {
    return false;
  }
  if (
    codexRootThreadId &&
    isRecord(data) &&
    data.type === 'codex' &&
    isRecord(data.event) &&
    data.event.type === 'error' &&
    data.event.thread_id === codexRootThreadId
  ) {
    return true;
  }
  return (
    isTerminalChatEventData(data) &&
    !isCodexSubagentTerminalEvent(data, codexRootThreadId)
  );
}

export function isAgentContinuationEvent(data: unknown): boolean {
  if (!isRecord(data)) return false;
  if (data.type === 'assistant' || data.type === 'user') return true;
  if (data.type !== 'codex' || !isRecord(data.event)) return false;
  return (
    data.event.type === 'turn.started' ||
    data.event.type === 'item.started' ||
    data.event.type === 'item.updated' ||
    data.event.type === 'item.completed' ||
    data.event.type === 'item.plan.delta'
  );
}

/** A Claude stream-json assistant/user frame owned by a child tool use. */
export function isClaudeChildFrame(data: unknown): boolean {
  return (
    isRecord(data) &&
    (data.type === 'assistant' || data.type === 'user') &&
    typeof data.parent_tool_use_id === 'string'
  );
}

/** Continuations that may revive the root turn, excluding Claude child frames. */
export function isRootAgentContinuationEvent(data: unknown): boolean {
  return isAgentContinuationEvent(data) && !isClaudeChildFrame(data);
}

function readDiagnosticProviderType(
  value: unknown,
): AgentProviderType | undefined {
  return value === 'claude' || value === 'codex' || value === 'ollama'
    ? value
    : undefined;
}

export function getDiagnosticEventMetadata(data: unknown): {
  providerType?: AgentProviderType;
  model?: string;
} {
  const eventRecord = isRecord(data) ? data : null;
  const providerType = readDiagnosticProviderType(
    eventRecord?.['providerType'],
  );
  const model =
    eventRecord && typeof eventRecord['model'] === 'string'
      ? eventRecord['model']
      : undefined;
  return {
    providerType,
    model,
  };
}

export { isRecord };
