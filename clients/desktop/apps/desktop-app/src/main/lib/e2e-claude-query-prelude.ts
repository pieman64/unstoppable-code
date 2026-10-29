import type {
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export interface E2eClaudeQueryPreludeScope {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface E2eClaudeQueryPreludeState {
  armed: boolean;
  armCount: number;
  consumedArmCount: number;
  preludeEmittedCount: number;
  promptNextRequestedCount: number;
  promptConsumedCount: number;
  promptGateReleaseCount: number;
  cleanupCount: number;
}

type MutablePreludeState = E2eClaudeQueryPreludeState;

const states = new Map<string, MutablePreludeState>();

// This deliberately models the raw zero-turn result observed from resumed
// sessions. Its task-notification origin predates the SDK's published
// SDKMessage union, so keep it unknown at the E2E seam instead of forcing it
// through that contract.
const RAW_TASK_NOTIFICATION_PRELUDE: Record<string, unknown> = {
  type: 'result',
  is_error: false,
  num_turns: 0,
  result: '',
  duration_ms: 38,
  origin: { kind: 'task-notification' },
};

function scopeKey(scope: E2eClaudeQueryPreludeScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

function emptyState(): MutablePreludeState {
  return {
    armed: false,
    armCount: 0,
    consumedArmCount: 0,
    preludeEmittedCount: 0,
    promptNextRequestedCount: 0,
    promptConsumedCount: 0,
    promptGateReleaseCount: 0,
    cleanupCount: 0,
  };
}

function stateFor(scope: E2eClaudeQueryPreludeScope): MutablePreludeState {
  const key = scopeKey(scope);
  const existing = states.get(key);
  if (existing) return existing;
  const state = emptyState();
  states.set(key, state);
  return state;
}

/** Arm one exact chat scope for the next Claude SDK query only. */
export function armE2eClaudeQueryPrelude(
  scope: E2eClaudeQueryPreludeScope,
): E2eClaudeQueryPreludeState {
  const state = stateFor(scope);
  state.armed = true;
  state.armCount += 1;
  return { ...state };
}

export function readE2eClaudeQueryPreludeState(
  scope: E2eClaudeQueryPreludeScope,
): E2eClaudeQueryPreludeState {
  return { ...(states.get(scopeKey(scope)) ?? emptyState()) };
}

export function resetE2eClaudeQueryPreludes(): void {
  states.clear();
}

function consumeArm(
  scope: E2eClaudeQueryPreludeScope,
): MutablePreludeState | null {
  const state = states.get(scopeKey(scope));
  if (!state?.armed) return null;
  state.armed = false;
  state.consumedArmCount += 1;
  return state;
}

/**
 * E2E-only SDK seam used by the Electron regression. The prompt iterator is
 * held until the raw task-notification prelude has passed through the normal
 * Claude `_runQuery` event loop. All Query methods remain bound to the real
 * SDK query, and iterator teardown always releases the prompt gate.
 */
export function createE2eClaudeQueryWithPrelude<
  TQuery extends AsyncGenerator<SDKMessage, void>,
>(input: {
  scope: E2eClaudeQueryPreludeScope;
  prompt: AsyncIterable<SDKUserMessage>;
  createQuery: (prompt: AsyncIterable<SDKUserMessage>) => TQuery;
}): TQuery {
  const state = consumeArm(input.scope);
  if (!state) return input.createQuery(input.prompt);

  let releasePrompt = (): void => undefined;
  let released = false;
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = (): void => {
      if (released) return;
      released = true;
      state.promptGateReleaseCount += 1;
      resolve();
    };
  });
  const sourcePrompt = input.prompt[Symbol.asyncIterator]();
  const heldPrompt = (async function* (): AsyncGenerator<SDKUserMessage, void> {
    try {
      while (true) {
        state.promptNextRequestedCount += 1;
        await promptGate;
        const next = await sourcePrompt.next();
        if (next.done) return;
        state.promptConsumedCount += 1;
        yield next.value;
      }
    } finally {
      releasePrompt();
      await sourcePrompt.return?.();
    }
  })();

  const realQuery = input.createQuery(heldPrompt);
  const sourceQuery = realQuery[Symbol.asyncIterator]();
  const wrappedIterator = (async function* (): AsyncGenerator<unknown, void> {
    try {
      state.preludeEmittedCount += 1;
      yield structuredClone(RAW_TASK_NOTIFICATION_PRELUDE);
      releasePrompt();
      while (true) {
        const next = await sourceQuery.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      releasePrompt();
      state.cleanupCount += 1;
      await sourceQuery.return?.();
    }
  })();

  return new Proxy(realQuery, {
    get(target, property): unknown {
      if (property === Symbol.asyncIterator) {
        return (): AsyncGenerator<unknown, void> => wrappedIterator;
      }
      if (
        property === 'next' ||
        property === 'return' ||
        property === 'throw'
      ) {
        const iteratorMethod: unknown = Reflect.get(wrappedIterator, property);
        return typeof iteratorMethod === 'function'
          ? (...args: unknown[]): unknown =>
              Reflect.apply(iteratorMethod, wrappedIterator, args)
          : undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
}
