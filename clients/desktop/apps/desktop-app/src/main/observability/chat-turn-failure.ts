import { BRAND } from '@canopy/brand/current';
import {
  classifyAgentFailure,
  hasDefinitiveTerminalFailureSignal,
} from '@canopy/desktop-shared/agent-failures';
import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE,
  AI_CREDITS_USAGE_LIMIT_EVENT_TYPE,
  buildAiCreditsRequiredError,
  NO_BILLING_SOURCE_ERROR_CODE,
  OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE,
  type AgentProviderType,
} from '@canopy/desktop-shared/types';
import {
  AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG,
  AI_CREDITS_PROXY_ERROR_MARKER,
  parseCanopyProxyError,
  type CanopyProxyError,
} from '@canopy/protocol/llm-gateway';
import {
  CANOPY_AUTH_FAILURE_EVENT_TYPE,
  isCanopyAuthFailureEventData,
} from '@canopy/protocol/auth-recovery';
import { isTerminalChatEventData } from '../lib/chat-turn-audit';
import { readFailureSourceScope } from '../agents/failure-source-scope';

/**
 * Why a chat turn failed, as sent on `chat:turn_end` (CAN-4629). Values are a
 * closed list so PostHog can break failures down without ever receiving
 * provider error text.
 */
export const CHAT_TURN_FAILURE_CATEGORIES = [
  'no_credits',
  'credits_budget_exhausted',
  'provider_quota',
  'provider_auth',
  'model_locked',
  'organization_access',
  'upstream_unavailable',
  'network',
  'setup',
  'other',
] as const;

export type ChatTurnFailureCategory =
  (typeof CHAT_TURN_FAILURE_CATEGORIES)[number];

/** Refines `no_credits` and `model_locked` only. */
export const CHAT_TURN_FAILURE_DETAILS = [
  'personal_wallet_empty',
  'organization_pool_unavailable',
  'no_sign_in_or_credits',
  'credits_only_model',
  'organization_policy',
  'guest_not_allowed',
  'library_locked',
] as const;

export type ChatTurnFailureDetail = (typeof CHAT_TURN_FAILURE_DETAILS)[number];

export interface ChatTurnFailure {
  category: ChatTurnFailureCategory;
  detail?: ChatTurnFailureDetail;
}

const MODEL_POLICY_BLOCKED_ERROR_CODE = 'model_policy_blocked';
const MAX_FAILURE_EVIDENCE = 8;
const MAX_STRING_SCAN_DEPTH = 6;
const MAX_SCANNED_STRINGS = 200;
const CREDITS_REQUIRED_MESSAGE = buildAiCreditsRequiredError(BRAND.displayName);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codexEvent(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return data.type === 'codex' && isRecord(data.event) ? data.event : undefined;
}

/**
 * Events worth keeping while a turn runs because they can explain how it
 * ended. Ordinary output is never retained.
 */
export function isChatTurnFailureEvidence(
  data: Record<string, unknown>,
): boolean {
  if (
    data.type === 'error' ||
    data.type === CANOPY_AUTH_FAILURE_EVENT_TYPE ||
    data.type === AI_CREDITS_USAGE_LIMIT_EVENT_TYPE ||
    data.type === AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE
  ) {
    return true;
  }
  if (data.type === 'result') return data.is_error === true;
  if (data.type === 'assistant') return typeof data.error === 'string';
  const event = codexEvent(data);
  return (
    event !== undefined &&
    (event.type === 'turn.failed' ||
      event.type === 'error' ||
      event.type === 'rate_limit.reached')
  );
}

function collectStrings(value: unknown, into: string[], depth: number): void {
  if (depth > MAX_STRING_SCAN_DEPTH || into.length >= MAX_SCANNED_STRINGS) {
    return;
  }
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectStrings(entry, into, depth + 1);
    }
  }
}

function stringsOf(value: unknown): string[] {
  const strings: string[] = [];
  collectStrings(value, strings, 0);
  return strings;
}

function readProxyError(value: unknown): CanopyProxyError | null {
  for (const text of stringsOf(value)) {
    if (!text.includes(AI_CREDITS_PROXY_ERROR_MARKER)) continue;
    const parsed = parseCanopyProxyError(text);
    if (parsed) return parsed;
  }
  return null;
}

function categorizeProxyError(error: CanopyProxyError): ChatTurnFailure {
  switch (error.code) {
    case 'no_billing_source':
      return error.reason === undefined
        ? { category: 'no_credits' }
        : { category: 'no_credits', detail: error.reason };
    case 'session_budget_exhausted':
      return { category: 'credits_budget_exhausted' };
    case 'model_locked':
      return { category: 'model_locked', detail: 'library_locked' };
    case 'guest_model_not_allowed':
      return { category: 'model_locked', detail: 'guest_not_allowed' };
    case 'credentials_unavailable':
      return { category: 'provider_auth' };
    case 'work_owner_not_member':
      return { category: 'organization_access' };
    case 'upstream_unavailable':
      return { category: 'upstream_unavailable' };
    case 'invalid_request':
    case 'proxy_internal_error':
      return { category: 'other' };
  }
}

/** The app's own failure signals, which name their cause exactly. */
function categorizeCanopySignal(
  data: Record<string, unknown>,
): ChatTurnFailure | null {
  const target = codexEvent(data) ?? data;
  if (
    stringsOf(target).some((text) => text.includes(CREDITS_REQUIRED_MESSAGE))
  ) {
    return { category: 'no_credits', detail: 'credits_only_model' };
  }
  if (target.error_code === MODEL_POLICY_BLOCKED_ERROR_CODE) {
    return { category: 'model_locked', detail: 'organization_policy' };
  }
  if (target.error_code === NO_BILLING_SOURCE_ERROR_CODE) {
    return { category: 'no_credits', detail: 'no_sign_in_or_credits' };
  }
  if (target.error_code === OLLAMA_SERVER_UNAVAILABLE_ERROR_CODE) {
    return { category: 'upstream_unavailable' };
  }
  if (data.type === AI_CREDITS_USAGE_LIMIT_EVENT_TYPE) {
    return { category: 'provider_quota' };
  }
  if (isCanopyAuthFailureEventData(data)) {
    const failure =
      data.failures?.find(
        (candidate) => candidate.dependencyClass === 'provider',
      ) ?? (data.failure.dependencyClass === 'provider' ? data.failure : null);
    if (!failure) return null;
    switch (failure.failureClass) {
      case 'quota_exceeded':
        return { category: 'provider_quota' };
      case 'provider_outage':
        return { category: 'upstream_unavailable' };
      case 'network_error':
        return { category: 'network' };
      case 'misconfigured':
      case 'unsupported_auth_method':
        return { category: 'setup' };
      case 'unauthenticated':
      case 'expired':
      case 'revoked':
      case 'reauthorization_required':
      case 'insufficient_scope':
        return { category: 'provider_auth' };
    }
  }
  return null;
}

function categorizeNoBillingSourceSignal(
  data: Record<string, unknown>,
): ChatTurnFailure | null {
  const target = codexEvent(data) ?? data;
  return data.type === AI_CREDITS_NO_BILLING_SOURCE_EVENT_TYPE ||
    target[AI_CREDITS_NO_BILLING_SOURCE_EVENT_FLAG] === true
    ? { category: 'no_credits' }
    : null;
}

interface ChatTurnFailureInput {
  provider: AgentProviderType;
  evidence?: readonly unknown[];
  /** The event that ended the turn, when it is among the evidence. */
  terminalEvent?: Record<string, unknown>;
  error?: string;
}

/**
 * Explain how a turn ended. The terminal event and error decide whenever they
 * carry any signal: a recognized cause, or a definitive status or proxy code,
 * which reports `other` when it has no category. Earlier evidence is read only
 * when the terminal carries no signal at all, because a notice the turn
 * recovered from cannot explain how it ended. Only fixed category and detail
 * values leave this function.
 */
export function classifyChatTurnFailure(
  input: ChatTurnFailureInput,
): ChatTurnFailure | null {
  const fromTerminal = classifyFailureEvidence({
    provider: input.provider,
    terminalEvent: input.terminalEvent,
    error: input.error,
  });
  if (fromTerminal) return fromTerminal;
  // The shared classifier's rule: a terminal status or proxy code accounts for
  // the failure even when it has no category, so earlier evidence must not.
  if (
    hasDefinitiveTerminalFailureSignal({
      provider: input.provider,
      error: input.terminalEvent ?? input.error,
    })
  ) {
    return { category: 'other' };
  }
  return classifyFailureEvidence({
    provider: input.provider,
    evidence: (input.evidence ?? []).filter(
      (data) => data !== input.terminalEvent,
    ),
  });
}

/** Prefer app signals, proxy codes, then the shared provider classifier. */
function classifyFailureEvidence(
  input: ChatTurnFailureInput,
): ChatTurnFailure | null {
  const { terminalEvent } = input;
  const earlier = (input.evidence ?? []).filter(isRecord);
  const terminalFirst = [
    ...(terminalEvent ? [terminalEvent] : []),
    ...[...earlier].reverse(),
  ];

  if (input.error?.includes(CREDITS_REQUIRED_MESSAGE)) {
    return { category: 'no_credits', detail: 'credits_only_model' };
  }
  for (const data of terminalFirst) {
    const signal = categorizeCanopySignal(data);
    if (signal) return signal;
  }

  const proxyError =
    readProxyError(input.error) ??
    terminalFirst.reduce<CanopyProxyError | null>(
      (found, data) => found ?? readProxyError(data),
      null,
    );
  if (proxyError) return categorizeProxyError(proxyError);

  for (const data of terminalFirst) {
    const signal = categorizeNoBillingSourceSignal(data);
    if (signal) return signal;
  }

  // The shared classifier decides from its terminal error alone whenever that
  // is recognizable, and only then falls back to the buffered events.
  const terminal = terminalEvent ?? input.error;
  const classification = classifyAgentFailure({
    provider: input.provider,
    accountScope: 'native',
    events: earlier,
    ...(terminal === undefined ? {} : { error: terminal }),
  });
  if (!classification) return null;
  switch (classification.kind) {
    case 'provider_authentication_required':
      return { category: 'provider_auth' };
    case 'provider_usage_limit':
      return { category: 'provider_quota' };
    case 'provider_temporarily_unavailable':
      return classification.code === 'connection_failed' ||
        classification.code === 'stream_disconnected' ||
        classification.code === 'provider_timeout'
        ? { category: 'network' }
        : { category: 'upstream_unavailable' };
  }
}

/**
 * A failure owned by a child tool use, or by a Codex thread other than the
 * root one, including any notice a session derived from such a failure (it
 * carries the same scope). Without a known root thread a Codex event stays
 * root evidence.
 */
function isSubAgentFailureEvidence(
  data: Record<string, unknown>,
  rootCodexThreadId: string | undefined,
): boolean {
  const scope = readFailureSourceScope(data);
  if (scope.parent_tool_use_id !== undefined) return true;
  return (
    rootCodexThreadId !== undefined &&
    scope.thread_id !== undefined &&
    scope.thread_id !== rootCodexThreadId
  );
}

function pushBounded(
  evidence: Record<string, unknown>[],
  data: Record<string, unknown>,
): void {
  evidence.push(data);
  if (evidence.length > MAX_FAILURE_EVIDENCE) evidence.shift();
}

/**
 * The failure evidence one chat turn collects while it runs: the latest root
 * events, the root event that ended it, and the latest sub-agent events. Kept
 * in memory only, and never sent anywhere.
 */
export class ChatTurnFailureEvidence {
  private readonly root: Record<string, unknown>[] = [];
  private readonly subAgent: Record<string, unknown>[] = [];
  private terminalEvent: Record<string, unknown> | undefined;

  observe(
    data: Record<string, unknown>,
    rootCodexThreadId: string | undefined,
  ): void {
    if (!isChatTurnFailureEvidence(data)) return;
    if (isSubAgentFailureEvidence(data, rootCodexThreadId)) {
      pushBounded(this.subAgent, data);
      return;
    }
    pushBounded(this.root, data);
    if (isTerminalChatEventData(data)) this.terminalEvent = data;
  }

  /**
   * Why the root turn and its sub-agents failed, when anything seen explains
   * it. `null` means nothing recognizable did.
   */
  classify(input: { provider: AgentProviderType; error?: string }): {
    failure: ChatTurnFailure | null;
    subAgentFailure: ChatTurnFailure | null;
  } {
    const latestSubAgentEvent = this.subAgent[this.subAgent.length - 1];
    return {
      failure: classifyChatTurnFailure({
        provider: input.provider,
        evidence: this.root,
        ...(this.terminalEvent ? { terminalEvent: this.terminalEvent } : {}),
        ...(input.error === undefined ? {} : { error: input.error }),
      }),
      subAgentFailure: latestSubAgentEvent
        ? classifyChatTurnFailure({
            provider: input.provider,
            evidence: this.subAgent,
            terminalEvent: latestSubAgentEvent,
          })
        : null,
    };
  }
}
