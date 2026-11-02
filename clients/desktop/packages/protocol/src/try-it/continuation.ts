import {
  buildTryItCapabilityKey,
  isTryItCapability,
  CURATED_MCP_TRY_IT_SOURCE_ID,
  ACCOUNT_MCP_TRY_IT_SOURCE_ID,
  type TryItCapability,
} from './index';

/** Resolve only one unambiguous, enabled account connection for this launch. */
export function tryItAccountMcpSelection(
  capability: TryItCapability,
  connections: readonly {
    kind: 'CURATED' | 'CUSTOM';
    serverKey: string;
    configId: string;
    status: 'PENDING' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'DISCONNECTED';
    enabled?: boolean;
  }[],
): { serverId: string; configId: string } | null {
  const kind =
    capability.sourceId === CURATED_MCP_TRY_IT_SOURCE_ID
      ? 'CURATED'
      : capability.sourceId === ACCOUNT_MCP_TRY_IT_SOURCE_ID
        ? 'CUSTOM'
        : null;
  if (capability.kind !== 'mcp' || kind === null) return null;
  const matching = connections.filter(
    (connection) =>
      connection.kind === kind && connection.serverKey === capability.catalogId,
  );
  if (matching.length !== 1) return null;
  const connection = matching[0];
  return connection.status === 'CONNECTED' &&
    connection.enabled !== false &&
    isIdentifier(connection.serverKey) &&
    isIdentifier(connection.configId)
    ? { serverId: connection.serverKey, configId: connection.configId }
    : null;
}

export const TRY_IT_CONTINUATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TRY_IT_AUTH_INTENT_TTL_MS = 30 * 60 * 1000;

export type TryItContinuationStatus =
  | 'pending'
  | 'sending'
  | 'setup-required'
  | 'failed'
  | 'completed';

export type TryItContinuationFailure =
  | 'authentication-cancelled'
  | 'authentication-failed'
  | 'handoff-blocked'
  | 'send-failed'
  | 'acceptance-uncertain'
  | 'capability-unavailable';

/** An authoritative acceptance, scoped to the actual destination and owner. */
export interface TryItContinuationReceipt {
  accountKey: string;
  chatId: string;
  requestId: string;
}

/**
 * Recovery metadata, never an authorization grant. Hosts verify ownership and
 * an actual guest-to-authenticated transition before binding a destination.
 * Host extensions contain only that host's validated recovery data.
 */
export interface TryItContinuation<Host = never> {
  version: 1;
  /** New draft continuations resolve only capability selections. */
  intent?: 'select-capability';
  sourceChatId: string;
  sourceSessionId: string;
  sourceAccountKey: string;
  capability: TryItCapability;
  /** Distinct from the initial, already attempted guest turn. */
  sourceRequestId: string;
  requestId: string;
  prompt: string;
  createdAtMs: number;
  status: TryItContinuationStatus;
  destinationAccountKey?: string;
  /** Absent means the retained source chat, not an arbitrary new chat. */
  destinationChatId?: string;
  failure?: TryItContinuationFailure;
  receipt?: TryItContinuationReceipt;
  /** Capability selection accepted; this is not a turn/send receipt. */
  selectionResolution?: TryItContinuationReceipt;
  host?: Host;
}

/** Requeue setup only; send acceptance and retry semantics stay authoritative. */
export function resumeTryItContinuationAfterSetup<Host>(
  record: TryItContinuation<Host>,
): TryItContinuation<Host> {
  if (record.status !== 'setup-required') return record;
  const resumed: TryItContinuation<Host> = { ...record, status: 'pending' };
  delete resumed.failure;
  return resumed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    value
      .split('')
      .every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      )
  );
}

function isStatus(value: unknown): value is TryItContinuationStatus {
  return (
    value === 'pending' ||
    value === 'sending' ||
    value === 'setup-required' ||
    value === 'failed' ||
    value === 'completed'
  );
}

function isFailure(value: unknown): value is TryItContinuationFailure {
  return (
    value === 'authentication-cancelled' ||
    value === 'authentication-failed' ||
    value === 'handoff-blocked' ||
    value === 'send-failed' ||
    value === 'acceptance-uncertain' ||
    value === 'capability-unavailable'
  );
}

function isReceipt(value: unknown): value is TryItContinuationReceipt {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['accountKey', 'chatId', 'requestId'].includes(key),
    ) &&
    isIdentifier(value.accountKey) &&
    isIdentifier(value.chatId) &&
    isIdentifier(value.requestId)
  );
}

/** Reject unparsed host data; a host must supply its own narrowing predicate. */
export function isTryItContinuation<Host = never>(
  value: unknown,
  options: {
    nowMs?: number;
    isHost?: (value: unknown) => value is Host;
  } = {},
): value is TryItContinuation<Host> {
  if (!isRecord(value)) return false;
  const nowMs = options.nowMs ?? Date.now();
  if (
    !Object.keys(value).every((key) =>
      [
        'version',
        'intent',
        'sourceChatId',
        'sourceSessionId',
        'sourceAccountKey',
        'capability',
        'sourceRequestId',
        'requestId',
        'prompt',
        'createdAtMs',
        'status',
        'destinationAccountKey',
        'destinationChatId',
        'failure',
        'receipt',
        'selectionResolution',
        'host',
      ].includes(key),
    ) ||
    value.version !== 1 ||
    (value.intent !== undefined && value.intent !== 'select-capability') ||
    !isIdentifier(value.sourceChatId) ||
    !isIdentifier(value.sourceSessionId) ||
    !isIdentifier(value.sourceAccountKey) ||
    !isIdentifier(value.sourceRequestId) ||
    !isIdentifier(value.requestId) ||
    value.requestId === value.sourceRequestId ||
    !isTryItCapability(value.capability) ||
    typeof value.prompt !== 'string' ||
    value.prompt.trim().length === 0 ||
    typeof value.createdAtMs !== 'number' ||
    !Number.isFinite(value.createdAtMs) ||
    !Number.isFinite(nowMs) ||
    value.createdAtMs < 0 ||
    value.createdAtMs > nowMs ||
    nowMs - value.createdAtMs >= TRY_IT_CONTINUATION_TTL_MS ||
    !isStatus(value.status) ||
    (value.destinationAccountKey !== undefined &&
      !isIdentifier(value.destinationAccountKey)) ||
    (value.destinationChatId !== undefined &&
      !isIdentifier(value.destinationChatId)) ||
    (value.failure !== undefined && !isFailure(value.failure)) ||
    (value.status === 'failed' && value.failure === undefined) ||
    (value.status !== 'failed' && value.failure !== undefined)
  )
    return false;
  if (value.host !== undefined) {
    try {
      if (!options.isHost?.(value.host)) return false;
    } catch {
      return false;
    }
  }
  if (
    (value.status === 'sending' ||
      value.status === 'setup-required' ||
      value.status === 'completed' ||
      value.destinationChatId !== undefined) &&
    value.destinationAccountKey === undefined
  )
    return false;
  if (value.receipt !== undefined) {
    if (
      !isReceipt(value.receipt) ||
      value.receipt.requestId !== value.requestId ||
      value.receipt.accountKey !== value.destinationAccountKey ||
      value.receipt.chatId !== (value.destinationChatId ?? value.sourceChatId)
    )
      return false;
  }
  if (value.selectionResolution !== undefined) {
    if (
      value.status !== 'completed' ||
      value.receipt !== undefined ||
      !isReceipt(value.selectionResolution) ||
      value.selectionResolution.requestId !== value.requestId ||
      value.selectionResolution.accountKey !== value.destinationAccountKey ||
      value.selectionResolution.chatId !==
        (value.destinationChatId ?? value.sourceChatId)
    )
      return false;
  }
  return (
    value.status !== 'completed' ||
    value.receipt !== undefined ||
    value.selectionResolution !== undefined
  );
}

export function sameTryItCapability(
  left: TryItCapability,
  right: TryItCapability,
): boolean {
  return (
    buildTryItCapabilityKey('', left) === buildTryItCapabilityKey('', right)
  );
}

export type TryItCapabilityReadiness =
  | 'resolved'
  | 'unresolved'
  | 'needs-account'
  | 'unavailable-other'
  | 'unknown';

/** Hosts project their runtime references onto catalog identities explicitly. */
export interface TryItCapabilitySnapshot {
  /** False for loading, failed reads, stale selections or a previous account. */
  authoritative: boolean;
  unresolved?: readonly TryItCapability[];
  unavailable?: readonly {
    capability: TryItCapability;
    reason: 'needs-account' | 'other';
  }[];
  selected?: readonly {
    capability: TryItCapability;
    usable: boolean;
  }[];
}

export function tryItCapabilityReadiness(
  target: TryItCapability,
  snapshot: TryItCapabilitySnapshot,
): TryItCapabilityReadiness {
  if (!snapshot.authoritative) return 'unknown';
  const unavailable = snapshot.unavailable?.filter((entry) =>
    sameTryItCapability(target, entry.capability),
  );
  if (unavailable?.some((entry) => entry.reason === 'needs-account'))
    return 'needs-account';
  if (unavailable?.length) return 'unavailable-other';
  if (snapshot.unresolved?.some((entry) => sameTryItCapability(target, entry)))
    return 'unresolved';
  const selected = snapshot.selected?.filter((entry) =>
    sameTryItCapability(target, entry.capability),
  );
  // Contradictory or missing runtime data cannot authorize a continuation.
  if (selected?.some((entry) => !entry.usable)) return 'unavailable-other';
  return selected?.length ? 'resolved' : 'unknown';
}

export type TryItSignInGateState =
  | 'hidden'
  | 'sign-in'
  | 'signing-in'
  | 'authorizing'
  | 'retry'
  | 'continuing'
  | 'setup-required';

/** Pure policy shared by both hosts; it does not authorize or dispatch sends. */
export function resolveTryItSignInGate(input: {
  account: 'loading' | 'guest' | 'signed-in';
  accountKey?: string;
  chatId: string;
  capability: TryItCapability | null;
  transcriptLoading: boolean;
  initialAttemptSettled: boolean;
  hasUserTurn: boolean;
  /**
   * The capability was staged, unsent, in this chat's composer (CAN-5218).
   * Stands in for `hasUserTurn`: a staged draft has no turn yet.
   */
  staged?: boolean;
  readiness: TryItCapabilityReadiness;
  authentication: 'idle' | 'active' | 'cancelled' | 'failed';
  setup?: 'idle' | 'active' | 'cancelled' | 'failed';
  /** Validate persisted data, including its host extension, before passing it. */
  continuation?: TryItContinuation<unknown> | null;
  reconciling?: boolean;
}): TryItSignInGateState {
  if (
    input.account === 'loading' ||
    input.transcriptLoading ||
    !input.initialAttemptSettled ||
    !(input.hasUserTurn || input.staged === true) ||
    input.capability === null
  )
    return 'hidden';
  const record = input.continuation;
  if (
    record &&
    (!sameTryItCapability(record.capability, input.capability) ||
      (record.sourceChatId !== input.chatId &&
        record.destinationChatId !== input.chatId) ||
      record.status === 'completed')
  )
    return 'hidden';
  if (input.account === 'guest') {
    if (record && record.sourceAccountKey !== input.accountKey) return 'hidden';
    if (input.readiness !== 'unresolved' && input.readiness !== 'needs-account')
      return 'hidden';
    if (input.authentication === 'active') return 'signing-in';
    if (
      input.authentication === 'failed' ||
      input.authentication === 'cancelled' ||
      record?.status === 'failed'
    )
      return 'retry';
    return 'sign-in';
  }
  if (!record) return 'hidden';
  if (
    record.destinationAccountKey !== undefined &&
    record.destinationAccountKey !== input.accountKey
  )
    return 'hidden';
  if (record.status === 'failed') return 'retry';
  if (!input.accountKey || record.destinationAccountKey === undefined)
    return 'retry';
  if (input.reconciling || record.status === 'sending') return 'continuing';
  if (
    record.status === 'setup-required' ||
    input.readiness === 'unresolved' ||
    input.readiness === 'needs-account'
  ) {
    if (input.setup === 'active') return 'authorizing';
    if (input.setup === 'cancelled' || input.setup === 'failed') return 'retry';
    return 'setup-required';
  }
  return input.readiness === 'resolved' ? 'continuing' : 'retry';
}
