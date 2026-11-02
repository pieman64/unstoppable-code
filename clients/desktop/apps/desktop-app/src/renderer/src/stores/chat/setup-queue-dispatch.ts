import type {
  ChatRuntimeState,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';

/**
 * Renderer-local signal that setup-queued inputs were accepted by the provider
 * or consumed by the terminal after setup. The chat view announces
 * "Sending your message." from this, not from the setup flag falling: setup
 * can finish while another blocker holds the queue, a send can be refused,
 * or the user can delete the last message in the same update.
 */
export interface SetupQueueDispatch {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  /** Messages this flush dispatched for the chat. */
  readonly count: number;
}

type SetupQueueDispatchListener = (dispatch: SetupQueueDispatch) => void;
type SetupQueueTarget = Omit<SetupQueueDispatch, 'count'>;

const listeners = new Set<SetupQueueDispatchListener>();
const targets = new Map<
  SetupQueueDispatchListener,
  SetupQueueTarget | undefined
>();
const pendingInputs = new Map<
  string,
  { target: SetupQueueTarget; started: () => void }
>();

function targetKey(target: SetupQueueTarget): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

function inputKey(target: SetupQueueTarget, userMessageId: string): string {
  return JSON.stringify([targetKey(target), userMessageId]);
}

function isObserved(target: SetupQueueTarget): boolean {
  return Array.from(targets.values()).some(
    (observed) =>
      observed === undefined || targetKey(observed) === targetKey(target),
  );
}

/** Keep only identities submitted by an observed setup wait, never hydration. */
export function observeSetupQueueInputDispatch(
  target: SetupQueueTarget,
  userMessageId: string,
  started: (() => void) | undefined,
): void {
  if (started && isObserved(target))
    pendingInputs.set(inputKey(target, userMessageId), { target, started });
}

export function forgetSetupQueueInputDispatch(
  target: SetupQueueTarget,
  userMessageId: string,
): void {
  pendingInputs.delete(inputKey(target, userMessageId));
}

/** A resync cannot replay an old live announcement into a hydrated view. */
export function clearSetupQueueScope(
  projectId: string,
  worktreeId: string,
): void {
  for (const [key, pending] of Array.from(pendingInputs)) {
    if (
      pending.target.projectId === projectId &&
      pending.target.worktreeId === worktreeId
    )
      pendingInputs.delete(key);
  }
}

/** The live provider-accepted event names the exact submitted input. */
export function confirmSetupQueueInputDispatch(
  target: SetupQueueTarget,
  userMessageId: string,
): void {
  const key = inputKey(target, userMessageId);
  const pending = pendingInputs.get(key);
  pendingInputs.delete(key);
  try {
    pending?.started();
  } catch {
    // Presentation observers must not interrupt the committed event path.
  }
}

/** Desktop human sends publish acceptance as a committed metadata patch. */
export function confirmSetupQueueCommittedDispatch(
  event: ChatStateChangedEvent,
  runtimeByChatId: Readonly<Record<string, ChatRuntimeState>>,
): void {
  if (pendingInputs.size === 0) return;
  const scope = { projectId: event.projectId, worktreeId: event.worktreeId };
  for (const change of event.changes) {
    if (change.type === 'message.removed')
      forgetSetupQueueInputDispatch(
        { ...scope, chatId: change.chatId },
        change.messageId,
      );
  }
  for (const change of event.changes) {
    if (
      change.type !== 'tab.metadata_patched' ||
      typeof change.patch.lastAcceptedUserMessageId !== 'string'
    )
      continue;
    const target = { ...scope, chatId: change.tabId };
    let status = runtimeByChatId[change.tabId]?.status;
    for (const candidate of event.changes) {
      if (
        candidate.type === 'runtime.patched' &&
        candidate.chatId === change.tabId
      )
        status = candidate.runtime.status;
    }
    if (
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'interrupted'
    ) {
      forgetSetupQueueInputDispatch(
        target,
        change.patch.lastAcceptedUserMessageId,
      );
    } else {
      confirmSetupQueueInputDispatch(
        target,
        change.patch.lastAcceptedUserMessageId,
      );
    }
  }
}

export function subscribeSetupQueueDispatch(
  listener: SetupQueueDispatchListener,
  target?: SetupQueueTarget,
): () => void {
  listeners.add(listener);
  targets.set(listener, target);
  return (): void => {
    listeners.delete(listener);
    targets.delete(listener);
    for (const [key, pending] of Array.from(pendingInputs)) {
      if (!isObserved(pending.target)) pendingInputs.delete(key);
    }
  };
}

export function emitSetupQueueDispatch(dispatch: SetupQueueDispatch): void {
  listeners.forEach((listener) => {
    try {
      listener(dispatch);
    } catch {
      // An announcement must never interrupt queue dispatch.
    }
  });
}
