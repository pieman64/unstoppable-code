import type { ChatCancelRequest } from '@canopy/desktop-shared/types';

export interface PendingChatTurnPreparation {
  cancelled: boolean;
  /** The send this preparation owns; links the queue hand-off to its turn. */
  readonly userMessageId?: string;
  finish: () => void;
}

interface RegisteredPreparation extends PendingChatTurnPreparation {
  readonly onCancel?: () => Promise<void>;
}

const pendingPreparations = new Map<string, Set<RegisteredPreparation>>();
function preparationKey(target: ChatCancelRequest): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

/** Own cancellation from host dispatch until the provider accepts the message. */
export function beginChatTurnPreparation(
  target: ChatCancelRequest & {
    readonly userMessageId?: string;
    readonly onCancel?: () => Promise<void>;
  },
): PendingChatTurnPreparation {
  const key = preparationKey(target);
  const pending =
    pendingPreparations.get(key) ?? new Set<RegisteredPreparation>();
  const { userMessageId, onCancel } = target;
  const preparation: RegisteredPreparation = {
    // The host queue owns a send from acceptance until its provider hand-off
    // returns. A Stop that reached that hand-off before this turn's own
    // preparation began still applies — but only to the same send, never to
    // an independent newer one.
    cancelled:
      userMessageId !== undefined &&
      Array.from(pending).some(
        (existing) =>
          existing.cancelled && existing.userMessageId === userMessageId,
      ),
    ...(userMessageId !== undefined ? { userMessageId } : {}),
    ...(onCancel ? { onCancel } : {}),
    finish: (): void => {
      pending.delete(preparation);
      if (pending.size === 0 && pendingPreparations.get(key) === pending)
        pendingPreparations.delete(key);
    },
  };
  pending.add(preparation);
  pendingPreparations.set(key, pending);
  return preparation;
}

export async function cancelChatTurnPreparations(
  target: ChatCancelRequest,
): Promise<void> {
  const settlements: Promise<void>[] = [];
  for (const preparation of Array.from(
    pendingPreparations.get(preparationKey(target)) ?? [],
  )) {
    const firstCancel = !preparation.cancelled;
    preparation.cancelled = true;
    if (firstCancel && preparation.onCancel)
      settlements.push(preparation.onCancel());
  }
  await Promise.allSettled(settlements);
}
