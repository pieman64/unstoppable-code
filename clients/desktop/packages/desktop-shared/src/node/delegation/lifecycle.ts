import { isAgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import type {
  AgentDelegationTranscriptItem,
  AgentDelegationError,
  AgentDelegationEvent,
  AgentDelegationStatus,
  AgentDelegationUsage,
  DelegationStopReason,
  DelegationStoppedBy,
} from '@canopy/protocol/delegation';

export interface DelegationRunState {
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly sequence: number;
  readonly status: AgentDelegationStatus;
  readonly nativeSessionId?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly partialText?: string;
  readonly transcript?: readonly AgentDelegationTranscriptItem[];
  readonly finalText?: string;
  readonly approvalPending?: boolean;
  readonly error?: AgentDelegationError;
  readonly usage?: AgentDelegationUsage;
  readonly outputTruncated: boolean;
  readonly stopReason?: DelegationStopReason;
  readonly cancelledByUser?: boolean;
  readonly stoppedBy?: DelegationStoppedBy;
}

export function createDelegationRunState(
  delegationId: string,
  runGeneration: number,
): DelegationRunState {
  if (
    !delegationId ||
    !Number.isSafeInteger(runGeneration) ||
    runGeneration < 1
  )
    throw new Error('Invalid delegation identity');
  return {
    delegationId,
    runGeneration,
    sequence: 0,
    status: 'pending',
    outputTruncated: false,
  };
}

function projectUsage(usage: AgentDelegationUsage): AgentDelegationUsage {
  const result: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUsd?: number;
  } = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheCreationInputTokens',
    'costUsd',
  ] as const) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      result[key] = value;
  }
  return result;
}

export function isDelegationTerminal(status: AgentDelegationStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'deadline_exceeded' ||
    status === 'interrupted'
  );
}

/** Child-local reducer. Provider-native events must be normalized before entry. */
export function reduceDelegationEvent(
  state: DelegationRunState,
  envelope: AgentDelegationEvent,
): DelegationRunState {
  if (
    envelope.delegationId !== state.delegationId ||
    envelope.runGeneration !== state.runGeneration ||
    !Number.isSafeInteger(envelope.sequence) ||
    envelope.sequence <= state.sequence ||
    !Number.isFinite(envelope.occurredAt) ||
    envelope.occurredAt < 0 ||
    isDelegationTerminal(state.status)
  )
    return state;
  const event = envelope.event;
  // A receipt changes no run state, so the broker writes nothing for it.
  if (event.type === 'transcript_receipt') return state;
  if (event.type === 'started' && state.status === 'running') {
    // A mid-run capability reload may move the run to a new native session
    // (a Codex child is re-seeded on a fresh thread). Only the identity moves.
    if (
      !event.nativeSessionId ||
      event.nativeSessionId === state.nativeSessionId
    )
      return state;
    return {
      ...state,
      sequence: envelope.sequence,
      nativeSessionId: event.nativeSessionId,
    };
  }
  if (event.type === 'started' && state.status !== 'pending') return state;
  if (
    (event.type === 'progress' ||
      event.type === 'usage' ||
      event.type === 'transcript') &&
    state.status !== 'running'
  )
    return state;
  const next = { ...state, sequence: envelope.sequence };
  switch (event.type) {
    case 'approval':
      return { ...next, approvalPending: event.pending };
    case 'started':
      return {
        ...next,
        status: 'running',
        startedAt: envelope.occurredAt,
        ...(event.nativeSessionId
          ? { nativeSessionId: event.nativeSessionId }
          : {}),
      };
    case 'progress':
      return {
        ...next,
        partialText: event.text,
        outputTruncated: state.outputTruncated || event.truncated === true,
      };
    case 'transcript': {
      if (
        !Array.isArray(event.items) ||
        !event.items.every(isAgentDelegationTranscriptItem) ||
        new Set(event.items.map((item) => item.id)).size !== event.items.length
      )
        return state;
      const transcript = event.items.map((item) => ({
        id: item.id,
        sequence: item.sequence,
        occurredAt: item.occurredAt,
        ...(item.type === 'tool'
          ? {
              type: item.type,
              toolName: item.toolName,
              input: item.input,
              ...(item.output !== undefined
                ? { output: item.output, isError: item.isError === true }
                : {}),
            }
          : { type: item.type, text: item.text }),
      }));
      return {
        ...next,
        transcript,
        outputTruncated: state.outputTruncated || event.truncated === true,
      };
    }
    case 'usage':
      return { ...next, usage: projectUsage(event.usage) };
    case 'terminal':
      return {
        ...next,
        status: event.status,
        approvalPending: false,
        finishedAt: envelope.occurredAt,
        outputTruncated: state.outputTruncated,
        ...(event.finalText !== undefined
          ? { finalText: event.finalText }
          : {}),
        ...(event.error
          ? {
              error: {
                code: event.error.code,
                message: event.error.message,
                retryable: event.error.retryable,
              },
            }
          : {}),
        ...(event.usage ? { usage: projectUsage(event.usage) } : {}),
      };
  }
}
