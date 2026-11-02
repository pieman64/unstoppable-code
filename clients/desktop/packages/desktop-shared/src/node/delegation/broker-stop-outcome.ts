import type {
  DelegationTranscriptPort,
  DelegationTranscriptPortError,
  DelegationTranscriptPortErrorCode,
  DelegationTranscriptPortResult,
  DelegationTranscriptReceiptEntry,
} from './transcript-port';
import type {
  V3ReceiptState,
  V3StopOutcomeEntry,
  V3StopReceiptEntry,
} from './record-v3';

export interface V3StopOutcomeIdentity {
  readonly chatId: string;
  readonly delegationId: string;
}

export type V3StopOutcomeResolution =
  | {
      readonly kind: 'active';
      readonly status: 'accepted' | 'completed' | 'failed';
    }
  | { readonly kind: 'outcome'; readonly outcome: V3StopOutcomeEntry };

export interface V3StopOutcomeHandoffValue {
  readonly cleared: boolean;
}

export interface V3StopOutcomeDependencies {
  read(): V3ReceiptState | Promise<V3ReceiptState>;
  commit(
    change: (receipts: V3ReceiptState) => V3ReceiptState,
  ): void | Promise<void>;
  readonly port: Pick<DelegationTranscriptPort, 'appendReceipt' | 'receipt'>;
}

class StopOutcomeIdentityConflict extends Error {}

function failure<T>(
  code: DelegationTranscriptPortErrorCode,
  message: string,
  retryable = false,
): DelegationTranscriptPortResult<T> {
  return { ok: false, error: { code, message, retryable } };
}

function errorResult<T>(
  error: DelegationTranscriptPortError,
): DelegationTranscriptPortResult<T> {
  return { ok: false, error };
}

function failureFromException<T>(
  error: unknown,
  message: string,
): DelegationTranscriptPortResult<T> {
  return error instanceof StopOutcomeIdentityConflict
    ? failure('conflict', error.message)
    : failure('storage_failure', message, true);
}

function matchesAliasIdentity(
  identity: V3StopOutcomeIdentity,
  alias: V3StopReceiptEntry,
): boolean {
  return (
    alias.chatId === identity.chatId &&
    alias.delegationId === identity.delegationId &&
    alias.receiptKind === 'stop' &&
    alias.operation === 'stop' &&
    alias.reply.kind === 'stop' &&
    alias.reply.runGeneration === alias.runGeneration
  );
}

function matchesOutcomeIdentity(
  identity: V3StopOutcomeIdentity,
  operationId: string,
  runGeneration: number | null,
  entry: DelegationTranscriptReceiptEntry,
): entry is V3StopOutcomeEntry {
  return (
    entry.receiptKind === 'stop_outcome' &&
    entry.chatId === identity.chatId &&
    entry.delegationId === identity.delegationId &&
    entry.key === operationId &&
    entry.operationId === operationId &&
    entry.runGeneration === runGeneration &&
    entry.requestHash === null &&
    entry.operation === 'stop' &&
    entry.reply.kind === 'stop_outcome' &&
    entry.reply.runGeneration === runGeneration
  );
}

function sameOutcome(
  left: V3StopOutcomeEntry,
  right: V3StopOutcomeEntry,
): boolean {
  const leftError = left.reply.error;
  const rightError = right.reply.error;
  return (
    left.version === right.version &&
    left.kind === right.kind &&
    left.chatId === right.chatId &&
    left.receiptKind === right.receiptKind &&
    left.key === right.key &&
    left.delegationId === right.delegationId &&
    left.runGeneration === right.runGeneration &&
    left.operationId === right.operationId &&
    left.requestHash === right.requestHash &&
    left.operation === right.operation &&
    left.admittedAt === right.admittedAt &&
    left.reply.kind === right.reply.kind &&
    left.reply.status === right.reply.status &&
    left.reply.finishedAt === right.reply.finishedAt &&
    left.reply.runGeneration === right.reply.runGeneration &&
    (leftError === undefined
      ? rightError === undefined
      : rightError !== undefined &&
        leftError.code === rightError.code &&
        leftError.message === rightError.message &&
        leftError.retryable === rightError.retryable &&
        leftError.apply?.issueCount === rightError.apply?.issueCount)
  );
}

function sameActiveIdentity(
  receipts: V3ReceiptState,
  operationId: string,
  runGeneration: number | null,
): boolean {
  return (
    receipts.activeStop?.operationId === operationId &&
    receipts.activeStop.runGeneration === runGeneration
  );
}

function isOutcomeForHandoff(
  identity: V3StopOutcomeIdentity,
  outcome: V3StopOutcomeEntry,
): boolean {
  return (
    outcome.chatId === identity.chatId &&
    outcome.delegationId === identity.delegationId &&
    outcome.receiptKind === 'stop_outcome' &&
    outcome.key === outcome.operationId &&
    outcome.requestHash === null &&
    outcome.operation === 'stop' &&
    outcome.reply.kind === 'stop_outcome' &&
    outcome.reply.runGeneration === outcome.runGeneration
  );
}

function stopOutcomeReceiptIdentity(
  identity: V3StopOutcomeIdentity,
  operationId: string,
): {
  readonly chatId: string;
  readonly receiptKind: 'stop_outcome';
  readonly key: string;
} {
  return {
    chatId: identity.chatId,
    receiptKind: 'stop_outcome',
    key: operationId,
  };
}

function preserveFenceWithoutActiveStop(
  receipts: V3ReceiptState,
): V3ReceiptState {
  return {
    commandReceipts: receipts.commandReceipts,
    stopReceipts: receipts.stopReceipts,
    ...(receipts.stopFence === undefined
      ? {}
      : { stopFence: receipts.stopFence }),
  };
}

/**
 * Persist a stop's terminal outcome before publishing its immutable receipt;
 * only then may the matching active slot be cleared.
 */
export async function handoffV3StopOutcome(
  identity: V3StopOutcomeIdentity,
  outcome: V3StopOutcomeEntry,
  dependencies: V3StopOutcomeDependencies,
): Promise<DelegationTranscriptPortResult<V3StopOutcomeHandoffValue>> {
  if (!isOutcomeForHandoff(identity, outcome))
    return failure(
      'conflict',
      'The stop outcome identity does not match.',
      false,
    );

  let receipts: V3ReceiptState;
  try {
    receipts = await dependencies.read();
  } catch (error: unknown) {
    return failureFromException(
      error,
      'Unable to read the stop outcome state.',
    );
  }

  const operationId = outcome.operationId;
  const runGeneration = outcome.runGeneration;
  if (!sameActiveIdentity(receipts, operationId, runGeneration)) {
    if (receipts.activeStop !== undefined)
      return failure(
        'conflict',
        'A different stop operation owns the active slot.',
        false,
      );

    let durableOutcome: Awaited<
      ReturnType<DelegationTranscriptPort['receipt']>
    >;
    try {
      durableOutcome = await dependencies.port.receipt(
        stopOutcomeReceiptIdentity(identity, operationId),
      );
    } catch (error: unknown) {
      return failureFromException(
        error,
        'Unable to read the durable stop outcome.',
      );
    }
    if (!durableOutcome.ok) {
      return durableOutcome.error.code === 'not_found'
        ? failure(
            'corruption',
            'The cleared stop has no durable outcome receipt.',
            false,
          )
        : errorResult(durableOutcome.error);
    }
    if (
      !matchesOutcomeIdentity(
        identity,
        operationId,
        runGeneration,
        durableOutcome.value,
      ) ||
      !sameOutcome(durableOutcome.value, outcome)
    )
      return failure(
        'conflict',
        'The durable stop outcome has a different identity or value.',
        false,
      );
    return { ok: true, value: { cleared: false } };
  }

  const active = receipts.activeStop;
  if (active === undefined)
    return failure('conflict', 'The active stop slot changed.', false);
  const pending = active.pendingTerminalOutcome;
  if (pending !== undefined && !sameOutcome(pending, outcome))
    return failure(
      'conflict',
      'A different terminal outcome is already pending for this stop.',
      false,
    );

  try {
    await dependencies.commit((current) => {
      if (!sameActiveIdentity(current, operationId, runGeneration))
        throw new StopOutcomeIdentityConflict(
          'The active stop identity changed before its outcome was committed.',
        );
      const currentActive = current.activeStop;
      if (currentActive === undefined)
        throw new StopOutcomeIdentityConflict(
          'The active stop slot was cleared before its outcome was committed.',
        );
      const currentPending = currentActive.pendingTerminalOutcome;
      if (currentPending !== undefined && !sameOutcome(currentPending, outcome))
        throw new StopOutcomeIdentityConflict(
          'A different stop outcome is already pending.',
        );
      const currentFence = current.stopFence;
      if (
        currentFence === undefined ||
        currentFence.operationId !== operationId
      )
        throw new StopOutcomeIdentityConflict(
          'The stop fence no longer identifies this operation.',
        );
      return {
        ...current,
        activeStop:
          currentPending === undefined
            ? { ...currentActive, pendingTerminalOutcome: outcome }
            : currentActive,
        stopFence: {
          operationId,
          status: outcome.reply.status,
        },
      };
    });
  } catch (error: unknown) {
    return failureFromException(
      error,
      'Unable to commit the pending stop outcome.',
    );
  }

  let appended: Awaited<ReturnType<DelegationTranscriptPort['appendReceipt']>>;
  try {
    appended = await dependencies.port.appendReceipt(outcome);
  } catch (error: unknown) {
    return failureFromException(error, 'Unable to append the stop outcome.');
  }
  if (!appended.ok) return errorResult(appended.error);
  if (
    !matchesOutcomeIdentity(
      identity,
      operationId,
      runGeneration,
      appended.value.entry,
    ) ||
    !sameOutcome(appended.value.entry, outcome)
  )
    return failure(
      'conflict',
      'The appended stop outcome has a different identity or value.',
      false,
    );

  try {
    await dependencies.commit((current) => {
      if (!sameActiveIdentity(current, operationId, runGeneration))
        throw new StopOutcomeIdentityConflict(
          'The active stop identity changed before its slot was cleared.',
        );
      const currentActive = current.activeStop;
      if (currentActive === undefined)
        throw new StopOutcomeIdentityConflict(
          'The active stop slot was already cleared.',
        );
      if (
        currentActive.pendingTerminalOutcome === undefined ||
        !sameOutcome(currentActive.pendingTerminalOutcome, outcome)
      )
        throw new StopOutcomeIdentityConflict(
          'The pending stop outcome changed before its slot was cleared.',
        );
      if (
        current.stopFence?.operationId !== operationId ||
        current.stopFence.status !== outcome.reply.status
      )
        throw new StopOutcomeIdentityConflict(
          'The stop fence changed before its slot was cleared.',
        );
      return preserveFenceWithoutActiveStop(current);
    });
  } catch (error: unknown) {
    return failureFromException(error, 'Unable to clear the active stop slot.');
  }

  return { ok: true, value: { cleared: true } };
}

/** Resolve a stop alias from the active record first, then its durable receipt. */
export async function readV3StopOutcome(
  identity: V3StopOutcomeIdentity,
  alias: V3StopReceiptEntry,
  dependencies: V3StopOutcomeDependencies,
): Promise<DelegationTranscriptPortResult<V3StopOutcomeResolution>> {
  if (!matchesAliasIdentity(identity, alias))
    return failure(
      'conflict',
      'The stop alias identity does not match.',
      false,
    );

  let receipts: V3ReceiptState;
  try {
    receipts = await dependencies.read();
  } catch (error: unknown) {
    return failureFromException(
      error,
      'Unable to read the stop outcome state.',
    );
  }

  const active = receipts.activeStop;
  if (
    active !== undefined &&
    active.operationId === alias.operationId &&
    active.runGeneration === alias.runGeneration
  ) {
    const fence = receipts.stopFence;
    if (fence === undefined)
      return failure(
        'corruption',
        'The active stop has no matching stop fence.',
        false,
      );
    if (fence.operationId !== alias.operationId)
      return failure(
        'conflict',
        'The active stop fence identifies a different operation.',
        false,
      );
    const pending = active.pendingTerminalOutcome;
    if (pending === undefined) {
      if (fence.status !== 'accepted')
        return failure(
          'corruption',
          'A terminal stop status has no pending outcome.',
          false,
        );
      return { ok: true, value: { kind: 'active', status: fence.status } };
    }
    if (
      !matchesOutcomeIdentity(
        identity,
        alias.operationId,
        alias.runGeneration,
        pending,
      )
    )
      return failure(
        'conflict',
        'The pending outcome has a different stop identity.',
        false,
      );
    // The pending outcome is committed before its fence advances. A crash in
    // that interval leaves a valid accepted fence; only a conflicting
    // terminal fence indicates corrupt state. Validate the pending identity
    // above before trusting its status here.
    if (fence.status !== 'accepted' && fence.status !== pending.reply.status)
      return failure(
        'corruption',
        'The active stop fence disagrees with its pending outcome.',
        false,
      );
    return {
      ok: true,
      value: { kind: 'active', status: pending.reply.status },
    };
  }

  let durableOutcome: Awaited<ReturnType<DelegationTranscriptPort['receipt']>>;
  try {
    durableOutcome = await dependencies.port.receipt(
      stopOutcomeReceiptIdentity(identity, alias.operationId),
    );
  } catch (error: unknown) {
    return failureFromException(
      error,
      'Unable to read the durable stop outcome.',
    );
  }
  if (!durableOutcome.ok) {
    return durableOutcome.error.code === 'not_found'
      ? failure(
          'corruption',
          'A non-active stop has no durable outcome receipt.',
          false,
        )
      : errorResult(durableOutcome.error);
  }
  if (
    !matchesOutcomeIdentity(
      identity,
      alias.operationId,
      alias.runGeneration,
      durableOutcome.value,
    )
  )
    return failure(
      'conflict',
      'The durable outcome identifies a different stop operation.',
      false,
    );
  return {
    ok: true,
    value: { kind: 'outcome', outcome: durableOutcome.value },
  };
}
