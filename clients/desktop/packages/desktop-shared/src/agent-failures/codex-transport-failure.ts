import type {
  AgentFailureClassification,
  AgentFailureClassificationContext,
} from '../types/agent-failures';

/**
 * Marker the desktop puts on a terminal Codex chat event when the turn ended
 * because of the local app-server transport rather than the provider or the
 * model. It is structured so that retry policy never matches message text.
 *
 * This is deliberately not part of `classifyAgentFailure`: that classifier
 * also drives pipeline and background-helper retries, which resume
 * differently. Only interactive chats act on this marker.
 */
export type CodexTransportErrorCode =
  /** The shared app-server was stopped for another chat's turn. */
  | 'app_server_shared_restart'
  /** The app-server did not answer a request within its deadline. */
  | 'app_server_request_timeout'
  /** `thread/resume` was refused because the thread was still closing. */
  | 'thread_closing';

export interface CodexTransportErrorDetail {
  codex_error_code: CodexTransportErrorCode;
  /** `app_server_request_timeout` only: the JSON-RPC method left unanswered. */
  codex_error_method?: string;
}

// Thread start and resume both precede `turn/start`, so the user's input was
// never sent. An unanswered `turn/start` is different: the turn may already
// be running, and resending it could run the request twice.
const RETRYABLE_UNANSWERED_METHODS = new Set(['thread/start', 'thread/resume']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryableCodexTransportDetail(
  code: unknown,
  method: unknown,
): boolean {
  switch (code) {
    case 'app_server_shared_restart':
    case 'thread_closing':
      return true;
    case 'app_server_request_timeout':
      return (
        typeof method === 'string' && RETRYABLE_UNANSWERED_METHODS.has(method)
      );
    default:
      return false;
  }
}

/**
 * Classifies a retryable transport failure as a temporary outage, so a
 * pipeline step pauses with a recoverable reason and resumes like a provider
 * outage. Resume continues the session when the agent already did work and
 * reruns the step only when it did none. Returns null for anything else,
 * including an unanswered `turn/start`.
 */
export function classifyRetryableCodexTransportFailure(
  detail: CodexTransportErrorDetail | null,
  context: Pick<
    AgentFailureClassificationContext,
    'provider' | 'accountScope' | 'model'
  >,
  diagnosticMessage: string,
): AgentFailureClassification | null {
  if (
    !detail ||
    !isRetryableCodexTransportDetail(
      detail.codex_error_code,
      detail.codex_error_method,
    )
  ) {
    return null;
  }
  return {
    kind: 'provider_temporarily_unavailable',
    code: 'provider_timeout',
    provider: context.provider,
    account_scope: context.accountScope,
    ...(context.model ? { model: context.model } : {}),
    diagnostic_message: diagnosticMessage,
  };
}

/**
 * Whether a terminal Codex chat event carries a transport failure that an
 * interactive chat may retry automatically.
 */
export function isRetryableCodexTransportFailureEvent(
  eventData: unknown,
): boolean {
  if (
    !isRecord(eventData) ||
    eventData.type !== 'result' ||
    eventData.is_error !== true ||
    eventData.subtype !== 'codex_error'
  ) {
    return false;
  }
  return isRetryableCodexTransportDetail(
    eventData.codex_error_code,
    eventData.codex_error_method,
  );
}
