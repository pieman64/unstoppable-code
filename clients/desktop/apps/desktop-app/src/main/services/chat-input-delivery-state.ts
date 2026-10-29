import type {
  ChatInputAttempt,
  ChatInputDeliveryEvent,
  ChatInputDeliveryLedger,
  ChatInputDeliveryRow,
} from '@canopy/protocol/portal';
import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';

export type InputLedger = ChatInputDeliveryLedger<ChatSendMessageRequest>;
export type InputRow = ChatInputDeliveryRow<ChatSendMessageRequest>;

export {
  inputSettingsKey,
  isInputLedger,
} from '@canopy/desktop-shared/chat-input-delivery';

const SUPERSEDED_PICKUP_REASON =
  'A superseded delivery attempt was picked up. Review the provider transcript before retrying this message.';

export function observeInputDelivery(
  ledger: InputLedger,
  event: ChatInputDeliveryEvent,
  now: number,
): InputLedger {
  let changed = false;
  const rows = ledger.rows.map((row): InputRow => {
    const index = row.attempts.findIndex(
      (attempt) =>
        attempt.id === event.attemptId &&
        attempt.generation === event.generation &&
        attempt.provider === event.provider,
    );
    if (index < 0) return row;
    const old = row.attempts[index];
    const fields = {
      accepted: 'admittedAt',
      'picked-up': 'pickedUpAt',
      withdrawn: 'withdrawnAt',
      completed: 'completedAt',
      unknown: 'uncertainAt',
    } as const;
    const field = fields[event.phase];
    if (old[field] !== undefined) return row;
    changed = true;
    const attempt = {
      ...old,
      [field]: now,
      ...(event.phase === 'picked-up' &&
      event.startsTurn &&
      event.turnRootAccepted !== false
        ? { rootUserMessageId: row.id }
        : {}),
      ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
      ...(event.itemId ? { itemId: event.itemId } : {}),
    };
    const attempts = [...row.attempts];
    attempts[index] = attempt;
    if (row.currentAttemptId !== event.attemptId) {
      return {
        ...row,
        revision: row.revision + 1,
        attempts,
        ...(event.phase === 'picked-up'
          ? {
              state: 'uncertain' as const,
              reason: SUPERSEDED_PICKUP_REASON,
            }
          : {}),
      };
    }
    if (
      attempts.some(
        (candidate) =>
          candidate.id !== row.currentAttemptId &&
          candidate.pickedUpAt !== undefined,
      )
    ) {
      return {
        ...row,
        revision: row.revision + 1,
        attempts,
        state: 'uncertain',
        reason: SUPERSEDED_PICKUP_REASON,
      };
    }
    // Preserve evidence of pickup even if the root later stops. A conflicting
    // withdrawal is uncertainty, never permission to replay the input.
    const conflict =
      attempt.pickedUpAt !== undefined && attempt.withdrawnAt !== undefined;
    const state = conflict
      ? 'uncertain'
      : attempt.pickedUpAt !== undefined
        ? 'picked-up'
        : attempt.uncertainAt !== undefined
          ? 'uncertain'
          : attempt.withdrawnAt !== undefined
            ? ['editing', 'queued', 'cancelled'].includes(row.state)
              ? row.state
              : 'cancelled'
            : row.state === 'cancelling'
              ? 'cancelling'
              : attempt.admittedAt !== undefined
                ? 'pending'
                : row.state;
    return { ...row, revision: row.revision + 1, attempts, state };
  });
  return changed ? { ...ledger, rows } : ledger;
}

export function restoreInputLedger(
  ledger: InputLedger,
  liveGeneration?: string,
): InputLedger {
  let changed = false;
  const rows = ledger.rows.map((row): InputRow => {
    const attempt = row.attempts.find((a) => a.id === row.currentAttemptId);
    if (
      !attempt ||
      attempt.generation === liveGeneration ||
      !['sending', 'pending', 'cancelling'].includes(row.state)
    )
      return row;
    changed = true;
    if (row.state === 'cancelling' && row.queueIntent) {
      return {
        ...row,
        revision: row.revision + 1,
        state: 'cancelled',
        reason:
          'Move to queued was interrupted after the provider session ended. Retry Queue to finish the requested move.',
      };
    }
    return {
      ...row,
      revision: row.revision + 1,
      state: 'uncertain',
      reason:
        'The provider session ended before delivery was confirmed. This message will not be resent automatically.',
    };
  });
  return changed ? { ...ledger, rows } : ledger;
}

export function settleInputExecution(
  ledger: InputLedger,
  rootUserMessageId: string | undefined,
  status: string,
  now: number,
): InputLedger {
  if (!rootUserMessageId) return ledger;
  let turnOutcome: NonNullable<ChatInputAttempt['turnOutcome']>;
  switch (status) {
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      turnOutcome = status;
      break;
    default:
      return ledger;
  }
  let changed = false;
  const rows = ledger.rows.map((row) => {
    let rowChanged = false;
    const attempts = row.attempts.map((attempt) => {
      if (
        attempt.rootUserMessageId !== rootUserMessageId ||
        attempt.pickedUpAt === undefined ||
        attempt.turnOutcome === turnOutcome
      )
        return attempt;
      changed = rowChanged = true;
      return {
        ...attempt,
        turnOutcome,
        turnSettledAt: now,
      };
    });
    return rowChanged ? { ...row, revision: row.revision + 1, attempts } : row;
  });
  return changed ? { ...ledger, rows } : ledger;
}
