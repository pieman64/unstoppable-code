import type {
  ChatQueueOrigin,
  ChatQueueTarget,
  ChatQueueUpdatedEvent,
  ChatSendMessageRequest,
  PersistedHostQueuedMessage,
} from '@canopy/desktop-shared/types';
import {
  ChatQueueService,
  type ChatQueuePersistenceMutation,
  type ChatQueueServiceDependencies,
} from '../../chat-queue-service';

export interface RecordedDispatch {
  request: ChatSendMessageRequest;
  origin: ChatQueueOrigin;
  fromQueue: boolean;
}
export interface RecordedPersistence {
  target: ChatQueueTarget;
  queuedMessageIds: readonly string[];
  mutation?: ChatQueuePersistenceMutation;
  queuedMessages?: readonly PersistedHostQueuedMessage[];
  inFlight?: PersistedHostQueuedMessage;
}
export interface QueueHarness {
  service: ChatQueueService;
  dispatches: RecordedDispatch[];
  persisted: RecordedPersistence[];
  broadcasts: ChatQueueUpdatedEvent[];
  cancels: ChatQueueTarget[];
  /** `dispatch:<userMessageId>` and `cancel:<chatId>`, in call order. */
  events: string[];
  /** Run every callback the service scheduled, repeatedly, until none is left (max 50 rounds). */
  flush(): Promise<void>;
  /** Hold the next `dispatch` call open until `release()` is called. */
  holdNextDispatch(): { release(): void };
  /** Make the next `persistRuntime` call reject once with this error. */
  failNextPersistence(error: Error): void;
  /** Report the dispatched turn as finished, as a root terminal does. */
  finishTurn(target: ChatQueueTarget): void;
  /** Mark a provider turn as running for `hasActiveProviderTurn`. */
  setProviderTurnActive(target: ChatQueueTarget, active: boolean): void;
}

const targetKey = (target: ChatQueueTarget): string =>
  `${target.projectId}/${target.worktreeId}/${target.chatId}`;

/** A real, already-cleared timer handle, so `clearTimeout` stays a no-op. */
function inertTimer(): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => undefined, 0);
  clearTimeout(timer);
  return timer;
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

export function createQueueHarness(
  overrides?: Partial<ChatQueueServiceDependencies>,
): QueueHarness {
  const dispatches: RecordedDispatch[] = [];
  const persisted: RecordedPersistence[] = [];
  const broadcasts: ChatQueueUpdatedEvent[] = [];
  const cancels: ChatQueueTarget[] = [];
  const events: string[] = [];
  const scheduled: Array<{ callback: () => void }> = [];
  const activeTurns = new Set<string>();
  let nextDispatchHold: Promise<void> | undefined;
  let persistenceFailure: Error | undefined;
  let nextId = 0;
  let clock = 1_000;

  const dependencies: ChatQueueServiceDependencies = {
    dispatch: async (request, origin, fromQueue) => {
      dispatches.push({ request, origin, fromQueue });
      events.push(`dispatch:${request.userMessageId}`);
      const hold = nextDispatchHold;
      nextDispatchHold = undefined;
      if (hold) await hold;
    },
    cancel: (target) => {
      cancels.push(target);
      events.push(`cancel:${target.chatId}`);
      // A cancelled provider turn is no longer running.
      activeTurns.delete(targetKey(target));
      return Promise.resolve();
    },
    settleCancelledTurn: () => Promise.resolve(),
    hasActiveProviderTurn: (target) => activeTurns.has(targetKey(target)),
    hasPendingProviderContinuation: () => false,
    persistRuntime: (
      target,
      queuedMessageIds,
      _turnActive,
      mutation,
      queuedMessages,
      _activeTurnUserMessageId,
      inFlight,
    ) => {
      if (persistenceFailure) {
        const error = persistenceFailure;
        persistenceFailure = undefined;
        return Promise.reject(error);
      }
      persisted.push({
        target,
        queuedMessageIds: [...queuedMessageIds],
        ...(mutation ? { mutation } : {}),
        ...(queuedMessages ? { queuedMessages: [...queuedMessages] } : {}),
        ...(inFlight ? { inFlight } : {}),
      });
      return Promise.resolve();
    },
    broadcast: (event) => {
      broadcasts.push(event);
    },
    createId: () => {
      nextId += 1;
      return `entry-${nextId}`;
    },
    now: () => {
      const value = clock;
      clock += 1;
      return value;
    },
    schedule: (callback) => {
      const task = { callback };
      scheduled.push(task);
      return Object.assign(inertTimer(), {
        cancel(): void {
          const index = scheduled.indexOf(task);
          if (index >= 0) scheduled.splice(index, 1);
        },
      });
    },
    ...overrides,
  };
  const service = new ChatQueueService(dependencies);

  return {
    service,
    dispatches,
    persisted,
    broadcasts,
    cancels,
    events,
    async flush(): Promise<void> {
      for (let round = 0; round < 50; round += 1) {
        await settle();
        if (scheduled.length === 0) return;
        for (const task of scheduled.splice(0)) task.callback();
      }
      await settle();
    },
    holdNextDispatch(): { release(): void } {
      let release = (): void => undefined;
      nextDispatchHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release: () => release() };
    },
    failNextPersistence(error: Error): void {
      persistenceFailure = error;
    },
    finishTurn(target: ChatQueueTarget): void {
      service.onTurnTerminal(target, 'complete');
    },
    setProviderTurnActive(target: ChatQueueTarget, active: boolean): void {
      if (active) activeTurns.add(targetKey(target));
      else activeTurns.delete(targetKey(target));
    },
  };
}

export function queuedRequest(
  target: ChatQueueTarget,
  userMessageId: string,
  text?: string,
): ChatSendMessageRequest {
  return {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    chatId: target.chatId,
    userMessageId,
    text: text ?? `queued ${userMessageId}`,
  };
}
