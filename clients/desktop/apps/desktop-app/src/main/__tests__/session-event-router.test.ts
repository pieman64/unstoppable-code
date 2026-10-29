import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import type { AgentSession } from '../agents/types';
import { getOrCreateSession } from '../agents/session-manager';
import { EventPressureGate } from '../agents/event-pressure';
import {
  getOrCreateRoutedSession,
  drainCurrentSessionEvents,
  getRoutedSessionPressureSnapshot,
  sessionEventRouterTestExports,
} from '../agents/session-event-router';

jest.mock('../deferred-tools/reload-coordinator', () => ({
  deferredToolsReloadCoordinator: {
    hasActiveReload: jest.fn(() => false),
    shouldSuppressProviderTerminal: jest.fn(() => false),
  },
}));

jest.mock('../agents/session-manager', () => ({
  getOrCreateSession: jest.fn(),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
}));

const getSessionMock = jest.mocked(getOrCreateSession);
const options = {
  cwd: '/tmp',
  projectId: 'cowork',
  worktreeId: 'entry',
  chatId: 'chat',
};
function makeSession(): AgentSession {
  return {
    sendMessage: jest.fn(),
    cancel: jest.fn(),
    destroy: jest.fn(),
    setPlanMode: jest.fn(),
    setApprovalMode: jest.fn(),
    setThinkingLevel: jest.fn(),
    setModel: jest.fn(),
  };
}
const emptyDrain = async (): Promise<void> => {};

function delegationEvent(status: 'running' | 'cancelled'): unknown {
  return {
    type: 'canopy_delegation',
    canopy_turn_user_message_id: 'root',
    delegation: {
      delegationId: 'child',
      runGeneration: 1,
      sequence: status === 'running' ? 1 : 2,
      parentHarnessId: 'codex',
      parentTurnId: 'root',
      parentToolCallId: 'call',
      createdAt: 1,
      task: {
        description: 'Review',
        prompt: 'Review the source',
        executionMode: 'foreground',
      },
      snapshot: {
        delegationId: 'child',
        status,
        outputTruncated: false,
        routeSnapshot: {
          selectedModelId: 'sonnet',
          runtimeModelId: 'claude-sonnet-4-6',
          harnessId: 'claude',
        },
      },
      transcript: [],
    },
  };
}

it('delivers a terminal delegation transcript after provider route removal', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const handler = jest.fn();
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  void emit?.(delegationEvent('running'));
  getSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
  void emit?.(delegationEvent('cancelled'));

  expect(handler).toHaveBeenCalledTimes(2);
  expect(handler).toHaveBeenLastCalledWith(
    delegationEvent('cancelled'),
    expect.any(Function),
  );
});

it('routes Claude automatic pickup under its new root without accepting old-generation or old-root output', async () => {
  const session = makeSession();
  session.getSteeringCapabilities = (): ReturnType<
    NonNullable<AgentSession['getSteeringCapabilities']>
  > => ({
    provider: 'claude',
    generation: 'live',
    steer: true,
    withdraw: true,
    interrupt: true,
  });
  getSessionMock.mockResolvedValue(session);
  const handler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0][1];
  void emit({ type: 'result', canopy_turn_user_message_id: 'root' });
  void emit({
    type: 'canopy_input_delivery',
    provider: 'claude',
    generation: 'old',
    attemptId: 'wrong',
    phase: 'picked-up',
    startsTurn: true,
    userMessageId: 'wrong',
  });
  void emit({ type: 'assistant', canopy_turn_user_message_id: 'wrong' });
  expect(handler.mock.calls.map(([event]) => event)).not.toContainEqual(
    expect.objectContaining({ type: 'assistant' }),
  );
  void emit({
    type: 'canopy_input_delivery',
    provider: 'claude',
    generation: 'live',
    attemptId: 'input',
    phase: 'picked-up',
    startsTurn: true,
    userMessageId: 'steered',
  });
  void emit({
    type: 'assistant',
    canopy_turn_user_message_id: 'steered',
    message: 'new output',
  });
  void emit({ type: 'result', canopy_turn_user_message_id: 'steered' });
  expect(handler.mock.calls.map(([event]) => event)).toContainEqual(
    expect.objectContaining({ type: 'assistant', message: 'new output' }),
  );
  const before = handler.mock.calls.length;
  void emit({ type: 'result', canopy_turn_user_message_id: 'root' });
  expect(handler).toHaveBeenCalledTimes(before);
});

it('does not let a rejected autonomous pickup replace the routed root', async () => {
  const session = makeSession();
  session.getSteeringCapabilities = (): ReturnType<
    NonNullable<AgentSession['getSteeringCapabilities']>
  > => ({
    provider: 'claude',
    generation: 'live',
    steer: true,
    withdraw: true,
    interrupt: true,
  });
  getSessionMock.mockResolvedValue(session);
  const handler = jest.fn<void, [unknown]>();
  const acceptTurnRoot = jest.fn(() => false);
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'newer-root',
    acceptTurnRoot,
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0][1];
  void emit({
    type: 'canopy_input_delivery',
    provider: 'claude',
    generation: 'live',
    attemptId: 'stale-attempt',
    phase: 'picked-up',
    startsTurn: true,
    userMessageId: 'stale-root',
  });
  void emit({
    type: 'assistant',
    canopy_turn_user_message_id: 'stale-root',
    message: 'stale output',
  });
  void emit({
    type: 'assistant',
    canopy_turn_user_message_id: 'newer-root',
    message: 'current output',
  });

  expect(acceptTurnRoot).toHaveBeenCalledWith('stale-root');
  expect(handler.mock.calls.map(([event]) => event)).toContainEqual(
    expect.objectContaining({
      type: 'canopy_input_delivery',
      attemptId: 'stale-attempt',
      phase: 'picked-up',
      turnRootAccepted: false,
    }),
  );
  expect(handler.mock.calls.map(([event]) => event)).not.toContainEqual(
    expect.objectContaining({ message: 'stale output' }),
  );
  expect(handler.mock.calls.map(([event]) => event)).toContainEqual(
    expect.objectContaining({ message: 'current output' }),
  );
});

it('delivers asynchronously rejected pickup evidence without replacing the routed root', async () => {
  const session = makeSession();
  session.getSteeringCapabilities = (): ReturnType<
    NonNullable<AgentSession['getSteeringCapabilities']>
  > => ({
    provider: 'claude',
    generation: 'live',
    steer: true,
    withdraw: true,
    interrupt: true,
  });
  getSessionMock.mockResolvedValue(session);
  const handler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'newer-root',
    acceptTurnRoot: () => Promise.resolve(false),
    drainEventsBeforeRemoval: emptyDrain,
  });

  void getSessionMock.mock.calls[0][1]({
    type: 'canopy_input_delivery',
    provider: 'claude',
    generation: 'live',
    attemptId: 'stale-attempt',
    phase: 'picked-up',
    startsTurn: true,
    userMessageId: 'stale-root',
  });
  await drainCurrentSessionEvents(options);

  expect(handler.mock.calls.map(([event]) => event)).toContainEqual(
    expect.objectContaining({
      type: 'canopy_input_delivery',
      attemptId: 'stale-attempt',
    }),
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  sessionEventRouterTestExports.reset();
});

it('strips a preview screenshot for every entry point, across a re-dispatch of the same session', async () => {
  // Worktree, desktop Cowork, and Portal sends all route through here, so
  // this is where a PreviewVisual image must leave the event.
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const first = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(options, first, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  // The provider keeps the callback it was created with.
  const emit = getSessionMock.mock.calls[0][1];
  const screenshot = 'PREVIEWSCREENSHOT'.repeat(64);
  const other = 'BROWSERSCREENSHOT'.repeat(64);
  void emit({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu-preview',
          name: 'mcp__canopy__PreviewVisual',
          input: {},
        },
      ],
    },
  });
  // A steer installs a new route before the tool result arrives.
  const second = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(options, second, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  void emit({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu-preview',
          content: [
            { type: 'text', text: 'Preview rendered.' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: screenshot,
              },
            },
          ],
        },
        {
          type: 'tool_result',
          tool_use_id: 'toolu-browser',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: other },
            },
          ],
        },
      ],
    },
    // Claude repeats the result beside the message.
    tool_use_result: [
      { type: 'text', text: 'Preview rendered.' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: screenshot },
      },
    ],
  });
  void emit({
    type: 'codex',
    event: {
      type: 'item.completed',
      item: {
        id: 'call-1',
        type: 'dynamic_tool_call',
        tool: 'canopy_preview_visual',
        content_items: [
          { type: 'inputText', text: 'Preview rendered.' },
          {
            type: 'inputImage',
            imageUrl: `data:image/jpeg;base64,${screenshot}`,
          },
        ],
      },
    },
  });
  const seen = JSON.stringify([first.mock.calls, second.mock.calls]);
  expect(seen).toContain('Preview rendered.');
  expect(seen).toContain('not stored');
  expect(seen).not.toContain(screenshot);
  // Another tool's image is not this tool's to remove.
  expect(seen).toContain(other);
});

it.each([
  ['desktop', 'portal'],
  ['portal', 'desktop'],
])(
  'hands a retained callback from %s to %s without leaking old events',
  async () => {
    const session = makeSession();
    let retained: ((data: unknown) => void) | undefined;
    getSessionMock.mockImplementation((_options, onEvent) => {
      retained ??= onEvent;
      return Promise.resolve(session);
    });
    const first = jest.fn<void, [unknown]>();
    const second = jest.fn<void, [unknown]>();
    await getOrCreateRoutedSession(options, first, () => null, {
      turnUserMessageId: 'first',
      drainEventsBeforeRemoval: emptyDrain,
    });
    retained?.({ type: 'assistant', canopy_turn_user_message_id: 'first' });
    await getOrCreateRoutedSession(options, second, () => null, {
      turnUserMessageId: 'second',
      drainEventsBeforeRemoval: emptyDrain,
    });
    retained?.({ type: 'result', canopy_turn_user_message_id: 'first' });
    const output = {
      type: 'assistant',
      canopy_turn_user_message_id: 'second',
      message: {
        content: [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: {} }],
      },
    };
    retained?.(output);
    retained?.({ type: 'result', canopy_turn_user_message_id: 'second' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(second.mock.calls[0]?.[0]).toEqual(output);
    getSessionMock.mock.calls[
      getSessionMock.mock.calls.length - 1
    ]?.[3]?.onRemoved?.();
    retained?.({ type: 'assistant', canopy_turn_user_message_id: 'second' });
    expect(second).toHaveBeenCalledTimes(2);
    expect(sessionEventRouterTestExports.currentRouteCount()).toBe(0);
  },
);

it('keeps older pending commits reachable from the provider-bound drain after handoff', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    turnUserMessageId: 'first',
    drainEventsBeforeRemoval: () => first,
  });
  const providerDrain =
    getSessionMock.mock.calls[0]?.[3]?.drainEventsBeforeRemoval;
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    turnUserMessageId: 'second',
    drainEventsBeforeRemoval: () => second,
  });
  let drained = false;
  const pending = providerDrain?.().then(() => {
    drained = true;
  });
  releaseSecond?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(drained).toBe(false);
  releaseFirst?.();
  await pending;
  expect(drained).toBe(true);
});

it('rejects untagged output and delayed cleanup from a replaced provider', async () => {
  const oldSession = makeSession();
  const replacement = makeSession();
  getSessionMock
    .mockResolvedValueOnce(oldSession)
    .mockResolvedValueOnce(replacement);
  const oldHandler = jest.fn<void, [unknown]>();
  const currentHandler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(options, oldHandler, () => null, {
    turnUserMessageId: 'first',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const oldCallback = getSessionMock.mock.calls[0]?.[1];
  const oldRemoved = getSessionMock.mock.calls[0]?.[3]?.onRemoved;
  await getOrCreateRoutedSession(options, currentHandler, () => null, {
    turnUserMessageId: 'second',
    drainEventsBeforeRemoval: emptyDrain,
  });
  void oldCallback?.({ type: 'assistant' });
  oldRemoved?.();
  void getSessionMock.mock.calls[1]?.[1]({ type: 'assistant' });
  expect(oldHandler).not.toHaveBeenCalled();
  expect(currentHandler).toHaveBeenCalledTimes(1);
  expect(sessionEventRouterTestExports.currentRouteCount()).toBe(1);
});

it('routes synchronous creation output and removes a failed creation route', async () => {
  const handler = jest.fn<void, [unknown]>();
  getSessionMock.mockImplementationOnce((_options, callback) => {
    void callback({ type: 'system' });
    return Promise.reject(new Error('Provider could not start'));
  });
  await expect(
    getOrCreateRoutedSession(options, handler, () => null, {
      turnUserMessageId: 'first',
      drainEventsBeforeRemoval: emptyDrain,
    }),
  ).rejects.toThrow('Provider could not start');
  expect(handler.mock.calls[0]?.[0]).toEqual({ type: 'system' });
  expect(sessionEventRouterTestExports.currentRouteCount()).toBe(0);
});

it('keeps internal reload teardown out of the logical turn while retaining subagent events', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const handler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(
    { ...options, sdkSessionId: 'root' },
    handler,
    () => null,
    {
      turnUserMessageId: 'turn',
      drainEventsBeforeRemoval: emptyDrain,
    },
  );
  const emit = getSessionMock.mock.calls[0]?.[1];
  jest
    .mocked(deferredToolsReloadCoordinator)
    .hasActiveReload.mockReturnValue(true);
  jest
    .mocked(deferredToolsReloadCoordinator)
    .shouldSuppressProviderTerminal.mockReturnValue(true);
  void emit?.({ type: 'result', is_error: false, result: 'Session ended' });
  void emit?.({
    type: 'codex',
    event: { type: 'turn.completed', thread_id: 'root' },
  });
  expect(handler).not.toHaveBeenCalled();
  const childEvent = {
    type: 'codex',
    event: { type: 'turn.completed', thread_id: 'child' },
  };
  void emit?.(childEvent);
  expect(handler.mock.calls.at(-1)?.[0]).toEqual(childEvent);
  jest
    .mocked(deferredToolsReloadCoordinator)
    .hasActiveReload.mockReturnValue(false);
  jest
    .mocked(deferredToolsReloadCoordinator)
    .shouldSuppressProviderTerminal.mockReturnValue(false);
  void emit?.({
    type: 'result',
    is_error: false,
    result: 'Completed after reload',
  });
  expect(handler).toHaveBeenCalledTimes(2);
});

it('routes an immediate terminal event from the resumed transport', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const handler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(
    { ...options, sdkSessionId: 'root' },
    handler,
    () => null,
    {
      turnUserMessageId: 'turn',
      drainEventsBeforeRemoval: emptyDrain,
    },
  );
  jest
    .mocked(deferredToolsReloadCoordinator)
    .hasActiveReload.mockReturnValue(true);
  jest
    .mocked(deferredToolsReloadCoordinator)
    .shouldSuppressProviderTerminal.mockReturnValue(false);

  void getSessionMock.mock.calls[0]?.[1]({
    type: 'result',
    is_error: false,
    result: 'Completed immediately after resume',
  });

  expect(handler.mock.calls.at(-1)?.[0]).toEqual({
    type: 'result',
    is_error: false,
    result: 'Completed immediately after resume',
  });
});

it('drains a live snapshot prefix without cancelling or removing its source session', async () => {
  const session = makeSession();
  const cancel = jest.fn();
  const destroy = jest.fn();
  session.cancel = cancel;
  session.destroy = destroy;
  getSessionMock.mockResolvedValue(session);
  let release: (() => void) | undefined;
  const prefix = new Promise<void>((resolve) => {
    release = resolve;
  });
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    turnUserMessageId: 'active',
    drainEventsBeforeRemoval: () => prefix,
  });
  let drained = false;
  const pending = drainCurrentSessionEvents(options).then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(drained).toBe(false);
  release?.();
  await pending;
  expect(drained).toBe(true);
  expect(cancel).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(sessionEventRouterTestExports.currentRouteCount()).toBe(1);
});

it('drains every retained route for a reused live session', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  let releaseFirst: (() => void) | undefined;
  let releaseSecond: (() => void) | undefined;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondPending = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const firstDrain = jest.fn(() => firstPending);
  const secondDrain = jest.fn(() => secondPending);
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    turnUserMessageId: 'first',
    drainEventsBeforeRemoval: firstDrain,
  });
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    turnUserMessageId: 'second',
    drainEventsBeforeRemoval: secondDrain,
  });

  let drained = false;
  const pending = drainCurrentSessionEvents(options).then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(firstDrain).toHaveBeenCalled();
  expect(secondDrain).toHaveBeenCalled();
  releaseSecond?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const prematurelyDrained = drained;
  releaseFirst?.();
  await pending;
  expect(prematurelyDrained).toBe(false);
});

it('drops a same-root Codex error from an earlier provider turn', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const handler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(
    { ...options, sdkSessionId: 'root' },
    handler,
    () => null,
    {
      turnUserMessageId: 'turn',
      drainEventsBeforeRemoval: emptyDrain,
    },
  );
  const emit = getSessionMock.mock.calls[0]?.[1];
  const turnStarted = {
    type: 'codex',
    event: {
      type: 'turn.started',
      thread_id: 'root',
      turn_id: 'turn-current',
    },
  };
  const staleError = {
    type: 'codex',
    event: {
      type: 'error',
      thread_id: 'root',
      turn_id: 'turn-stale',
      message: 'Earlier turn failed late',
    },
  };
  const currentError = {
    type: 'codex',
    event: {
      type: 'error',
      thread_id: 'root',
      turn_id: 'turn-current',
      message: 'Current turn failed',
    },
  };

  void emit?.(turnStarted);
  void emit?.(staleError);
  void emit?.(currentError);

  expect(handler).toHaveBeenCalledTimes(2);
  expect(handler.mock.calls[0]?.[0]).toEqual(turnStarted);
  expect(handler.mock.calls[1]?.[0]).toEqual(currentError);
});

it('notifies only the latest route when a reused session is removed', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const first = jest.fn<void, [unknown]>();
  const second = jest.fn<void, [unknown]>();
  const firstLifecycle = {
    turnUserMessageId: 'first',
    drainEventsBeforeRemoval: emptyDrain,
    onRemoved: first,
  };
  const secondLifecycle = {
    turnUserMessageId: 'second',
    drainEventsBeforeRemoval: emptyDrain,
    onRemoved: second,
  };
  await getOrCreateRoutedSession(
    options,
    jest.fn(),
    () => null,
    firstLifecycle,
  );
  const retainedRemoval = getSessionMock.mock.calls[0]?.[3]?.onRemoved;
  await getOrCreateRoutedSession(
    options,
    jest.fn(),
    () => null,
    secondLifecycle,
  );
  retainedRemoval?.();
  retainedRemoval?.();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

it('does not notify the replacement route when a different session is removed', async () => {
  getSessionMock
    .mockResolvedValueOnce(makeSession())
    .mockResolvedValueOnce(makeSession());
  const removed = jest.fn();
  const lifecycle = {
    turnUserMessageId: 'first',
    drainEventsBeforeRemoval: emptyDrain,
    onRemoved: removed,
  };
  await getOrCreateRoutedSession(options, jest.fn(), () => null, lifecycle);
  const retainedRemoval = getSessionMock.mock.calls[0]?.[3]?.onRemoved;
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    ...lifecycle,
    turnUserMessageId: 'replacement',
  });
  retainedRemoval?.();
  expect(removed).not.toHaveBeenCalled();
  expect(sessionEventRouterTestExports.currentRouteCount()).toBe(1);
});

it('preserves a fast provider prefix behind autonomous pickup arbitration and drains it in order', async () => {
  const session = makeSession();
  session.getSteeringCapabilities = (): ReturnType<
    NonNullable<AgentSession['getSteeringCapabilities']>
  > => ({
    provider: 'claude',
    generation: 'live',
    steer: true,
    withdraw: true,
    interrupt: true,
  });
  getSessionMock.mockResolvedValue(session);
  let releaseBarrier = (): void => undefined;
  const barrier = new Promise<boolean>((resolve): void => {
    releaseBarrier = (): void => resolve(true);
  });
  const delivered: unknown[] = [];
  await getOrCreateRoutedSession(
    options,
    (data) => {
      delivered.push(data);
    },
    () => null,
    {
      turnUserMessageId: 'old-root',
      acceptTurnRoot: () => barrier,
      drainEventsBeforeRemoval: emptyDrain,
    },
  );
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');
  const events = [
    {
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'live',
      attemptId: 'pressure-attempt',
      phase: 'picked-up',
      startsTurn: true,
      userMessageId: 'new-root',
    },
    ...Array.from({ length: 128 }, (_, sequence) => ({
      type: 'assistant',
      canopy_turn_user_message_id: 'new-root',
      sequence,
      payload: 'x'.repeat(2048),
    })),
    { type: 'result', canopy_turn_user_message_id: 'new-root' },
  ];
  const largestFrameBytes = Math.max(
    ...events.map((event) => Buffer.byteLength(JSON.stringify(event), 'utf8')),
  );
  let produced = 0;
  let producedBytes = 0;
  const producer = (async (): Promise<void> => {
    for (const event of events) {
      // A cooperative source awaits an asynchronous route admission when one
      // exists. The current void callback admits every event immediately.
      await emit(event);
      produced += 1;
      producedBytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
    }
  })();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const heldProduced = produced;
    const heldBytes = producedBytes;
    const routePressure = getRoutedSessionPressureSnapshot(options);
    expect(delivered).toHaveLength(0);
    expect(
      routePressure.activeCount + routePressure.waitingCount,
    ).toBeGreaterThan(0);
    process.stdout.write(
      `ROUTE_PRESSURE_METRIC ${JSON.stringify({
        produced: heldProduced,
        retainedBytesLowerBound: heldBytes,
        delivered: delivered.length,
        routePressure,
      })}\n`,
    );
    expect(heldBytes).toBeLessThanOrEqual(64 * 1024 + largestFrameBytes);
  } finally {
    releaseBarrier();
    await producer;
    await drainCurrentSessionEvents(options);
  }
  expect(produced).toBe(events.length);
  expect(delivered).toHaveLength(events.length);
  expect(delivered[0]).toMatchObject({
    type: 'canopy_input_delivery',
    turnRootAccepted: true,
  });
  expect(delivered.slice(1)).toEqual(events.slice(1));
});

it('allows a derived event to enter while its parent owns an oversized pressure slot', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const delivered: string[] = [];
  let completeDerived = (): void => undefined;
  const derivedComplete = new Promise<void>((resolve) => {
    completeDerived = resolve;
  });
  const emitProviderEvent = (data: unknown): void | Promise<void> =>
    getSessionMock.mock.calls[0]?.[1]?.(data);
  await getOrCreateRoutedSession(
    options,
    async (data, markPersistenceSettled) => {
      if (typeof data !== 'object' || data === null) return;
      const type: unknown = Reflect.get(data, 'type');
      if (type === 'parent') {
        delivered.push('parent');
        // The real adapters release route pressure at the persistence
        // boundary, before downstream callbacks may await a derived event.
        markPersistenceSettled?.();
        await emitProviderEvent?.({
          type: 'derived',
          canopy_turn_user_message_id: 'root',
        });
      } else if (type === 'derived') {
        delivered.push('derived');
        completeDerived();
      }
    },
    () => null,
    {
      turnUserMessageId: 'root',
      drainEventsBeforeRemoval: emptyDrain,
    },
  );
  const providerCallback = getSessionMock.mock.calls[0]?.[1];
  if (!providerCallback) throw new Error('Missing provider callback');
  const parentDelivery = Promise.resolve(
    providerCallback({
      type: 'parent',
      canopy_turn_user_message_id: 'root',
      payload: 'x'.repeat(70 * 1024),
    }),
  );
  await expect(
    Promise.race([
      derivedComplete.then(() => 'derived'),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('timed-out'), 500),
      ),
    ]),
  ).resolves.toBe('derived');
  await parentDelivery;
  await drainCurrentSessionEvents(options);
  expect(delivered).toEqual(['parent', 'derived']);
});

it('holds a capacity waiter until charged bytes fall below the low-water mark', async () => {
  const gate = new EventPressureGate();
  const first = gate.admit({ payload: 'a'.repeat(1000) });
  const second = gate.admit({ payload: 'b'.repeat(5000) });
  const third = gate.admit({ payload: 'c'.repeat(3000) });
  if (
    typeof first !== 'function' ||
    typeof second !== 'function' ||
    typeof third !== 'function'
  ) {
    throw new Error('Initial charges unexpectedly waited');
  }
  const waiting = gate.admit({ payload: 'd'.repeat(3000) });
  if (typeof waiting === 'function') {
    throw new Error('Capacity waiter unexpectedly entered');
  }
  let admitted = false;
  const eventualRelease = waiting.then((release) => {
    admitted = true;
    return release;
  });
  expect(gate.snapshot().waitingCount).toBe(1);
  first();
  await Promise.resolve();
  expect(admitted).toBe(false);
  second();
  const fourth = await eventualRelease;
  expect(admitted).toBe(true);
  third();
  fourth();
  await gate.drain();
  expect(gate.snapshot()).toMatchObject({
    activeCount: 0,
    waitingCount: 0,
    chargedBytes: 0,
  });
});

it('releases an opaque oversized slot exactly once and admits its successor', async () => {
  const gate = new EventPressureGate();
  const first = gate.admit(new Date());
  if (typeof first !== 'function')
    throw new Error('Opaque event did not enter');
  expect(gate.snapshot()).toMatchObject({
    activeCount: 1,
    activeUncertainCount: 1,
  });
  const waiting = gate.admit({ type: 'assistant' });
  if (typeof waiting === 'function') throw new Error('Exclusive slot leaked');
  first();
  first();
  const second = await waiting;
  expect(gate.snapshot().activeUncertainCount).toBe(0);
  second();
  await gate.drain();
  expect(gate.snapshot().chargedBytes).toBe(0);
});

it('treats a sparse large array as an exclusive uncertain charge and releases it', async () => {
  const gate = new EventPressureGate();
  const sparse: string[] = [];
  sparse.length = 1_000_000;
  sparse[0] = 'small';
  const first = gate.admit({ type: 'assistant', payload: sparse });
  if (typeof first !== 'function')
    throw new Error('Unoccupied sparse event did not enter');
  expect(gate.snapshot().activeUncertainCount).toBe(1);
  const waiting = gate.admit({ type: 'result' });
  if (typeof waiting === 'function')
    throw new Error('Sparse event did not receive an exclusive slot');
  first();
  const second = await waiting;
  second();
  await gate.drain();
  expect(gate.snapshot()).toMatchObject({
    activeUncertainCount: 0,
    activeCount: 0,
    chargedBytes: 0,
  });
});

it('does not retain consumed pressure waiters across a long settled stream', async () => {
  const gate = new EventPressureGate();
  const oldReleases: Array<() => void> = [];
  for (let sequence = 0; sequence < 1_100; sequence += 1) {
    const exclusive = gate.admit(new Date());
    if (typeof exclusive !== 'function') {
      throw new Error('Unoccupied exclusive slot was delayed');
    }
    oldReleases.push(exclusive);
    const pending = gate.admit({ sequence });
    if (typeof pending === 'function') {
      throw new Error('Exclusive slot admitted a successor early');
    }
    exclusive();
    const successor = await pending;
    successor();
    expect(gate.snapshot().waitingStorageSlots).toBe(0);
  }
  // Retained idempotent closures must remain harmless after later admissions.
  for (const oldRelease of oldReleases) oldRelease();
  await gate.drain();
  expect(gate.snapshot()).toMatchObject({
    activeCount: 0,
    chargedBytes: 0,
    waitingStorageSlots: 0,
  });
});

it('releases rejected root arbitration and continues the following event', async () => {
  const session = makeSession();
  session.getSteeringCapabilities = (): ReturnType<
    NonNullable<AgentSession['getSteeringCapabilities']>
  > => ({
    provider: 'claude',
    generation: 'live',
    steer: true,
    withdraw: true,
    interrupt: true,
  });
  getSessionMock.mockResolvedValue(session);
  const delivered: unknown[] = [];
  await getOrCreateRoutedSession(
    options,
    (data) => {
      delivered.push(data);
    },
    () => null,
    {
      turnUserMessageId: 'root',
      acceptTurnRoot: () =>
        Promise.reject(new Error('root arbitration failed')),
      drainEventsBeforeRemoval: emptyDrain,
    },
  );
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');
  const emitWithReceipt: (...args: Parameters<typeof emit>) => unknown = emit;
  const failed = Promise.resolve(
    emitWithReceipt({
      type: 'canopy_input_delivery',
      provider: 'claude',
      generation: 'live',
      attemptId: 'reject',
      phase: 'picked-up',
      startsTurn: true,
      userMessageId: 'other-root',
    }),
  );
  const following = Promise.resolve(
    emitWithReceipt({
      type: 'assistant',
      canopy_turn_user_message_id: 'root',
      message: 'still delivered',
    }),
  );
  await expect(failed).rejects.toThrow('root arbitration failed');
  await following;
  await drainCurrentSessionEvents(options);
  expect(delivered).toEqual([
    {
      type: 'assistant',
      canopy_turn_user_message_id: 'root',
      message: 'still delivered',
    },
  ]);
});

it('joins an admitted commit across route replacement and removal drain', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  let releaseCommit = (): void => undefined;
  const heldCommit = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  await getOrCreateRoutedSession(
    options,
    async (_data, markPersistenceSettled) => {
      await heldCommit;
      markPersistenceSettled?.();
    },
    () => null,
    {
      turnUserMessageId: 'old-root',
      drainEventsBeforeRemoval: emptyDrain,
    },
  );
  const oldProviderCallback = getSessionMock.mock.calls[0]?.[1];
  if (!oldProviderCallback) throw new Error('Missing old provider callback');
  void oldProviderCallback({
    type: 'assistant',
    canopy_turn_user_message_id: 'old-root',
  });
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    turnUserMessageId: 'new-root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  let drained = false;
  const removalDrain =
    getSessionMock.mock.calls[0]?.[3]?.drainEventsBeforeRemoval;
  if (!removalDrain) throw new Error('Missing provider removal drain');
  const pending = removalDrain().then(() => {
    drained = true;
  });
  try {
    await Promise.resolve();
    expect(drained).toBe(false);
  } finally {
    releaseCommit();
    await pending;
  }
  expect(drained).toBe(true);
});

/** A live delegate's full snapshot, large enough for an exclusive admission. */
function liveDelegationSnapshot(
  delegationId: string,
  sequence: number,
  status: 'running' | 'completed' = 'running',
): Record<string, unknown> {
  return {
    type: 'canopy_delegation',
    canopy_turn_user_message_id: 'root',
    delegation: {
      delegationId,
      runGeneration: 1,
      sequence,
      parentHarnessId: 'claude',
      parentTurnId: 'root',
      parentToolCallId: 'call',
      createdAt: 1,
      task: {
        description: 'Review',
        prompt: 'Review the source',
        executionMode: 'background',
      },
      snapshot: {
        delegationId,
        status,
        outputTruncated: false,
        routeSnapshot: {
          selectedModelId: 'sonnet',
          runtimeModelId: 'claude-sonnet-4-6',
          harnessId: 'claude',
        },
      },
      transcript: Array.from({ length: sequence * 4 }, (_, index) => ({
        type: 'text',
        id: `item-${String(index)}`,
        sequence: index + 1,
        occurredAt: index + 1,
        text: `Progress ${String(index)}`,
      })),
    },
  };
}

function deliveredDelegations(handler: jest.Mock): Array<string | undefined> {
  return handler.mock.calls.map(([event]: [unknown]) => {
    if (typeof event !== 'object' || event === null) return undefined;
    const delegation: unknown = Reflect.get(event, 'delegation');
    if (typeof delegation !== 'object' || delegation === null)
      return String(Reflect.get(event, 'type'));
    return `${String(Reflect.get(delegation, 'delegationId'))}:${String(Reflect.get(delegation, 'sequence'))}`;
  });
}

it('commits only the newest queued snapshot of each delegate while earlier events persist', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const commits: Array<() => void> = [];
  const handler = jest.fn(
    (_data: unknown, markPersistenceSettled?: () => void): Promise<void> =>
      new Promise<void>((resolve) => {
        commits.push(() => {
          markPersistenceSettled?.();
          resolve();
        });
      }),
  );
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');
  const settleNext = async (): Promise<void> => {
    const commit = commits.shift();
    if (!commit) throw new Error('No commit is in flight');
    commit();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  };

  // The first snapshot is persisting; later ones wait for admission.
  void emit({
    ...liveDelegationSnapshot('child', 1),
    payload: 'x'.repeat(300_000),
  });
  for (let sequence = 2; sequence <= 6; sequence += 1)
    void emit(liveDelegationSnapshot('child', sequence));
  void emit(liveDelegationSnapshot('sibling', 1));
  void emit({ type: 'assistant', canopy_turn_user_message_id: 'root' });
  void emit(liveDelegationSnapshot('child', 7, 'completed'));
  expect(deliveredDelegations(handler)).toEqual(['child:1']);

  while (commits.length > 0) await settleNext();
  await drainCurrentSessionEvents(options);

  // The waiting snapshot keeps its place in line and carries the newest
  // content; a snapshot of another delegate and provider output keep theirs.
  expect(deliveredDelegations(handler)).toEqual([
    'child:1',
    'child:7',
    'sibling:1',
    'assistant',
  ]);
  expect(handler.mock.calls[1]?.[0]).toEqual(
    liveDelegationSnapshot('child', 7, 'completed'),
  );
});

describe('while chat storage group-commits', () => {
  let routes = 0;
  /** A route whose deliveries stay pending until the test settles them. */
  async function routeWithPendingDeliveries(): Promise<{
    emit: (data: unknown) => void | Promise<void>;
    delivered: unknown[];
    settle: Array<() => void>;
  }> {
    getSessionMock.mockResolvedValue(makeSession());
    const delivered: unknown[] = [];
    const settle: Array<() => void> = [];
    await getOrCreateRoutedSession(
      { ...options, chatId: `group-commit-${(routes += 1)}` },
      (data: unknown): Promise<void> => {
        delivered.push(data);
        return new Promise<void>((resolve) => {
          settle.push(resolve);
        });
      },
      () => null,
      { turnUserMessageId: 'root', drainEventsBeforeRemoval: emptyDrain },
    );
    const emit = getSessionMock.mock.calls.at(-1)?.[1];
    if (!emit) throw new Error('No provider event callback was registered');
    return { emit, delivered, settle };
  }

  const erroredResult = {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true }],
    },
  };

  it('returns no admission to the provider for events that fit, while their commits are pending', async () => {
    const { emit, delivered } = await routeWithPendingDeliveries();
    // A provider (the Claude query loop) awaits only a returned admission:
    // nothing is returned while the byte bound has room, so it keeps reading.
    expect(emit({ type: 'assistant', message: 'one' })).toBeUndefined();
    expect(emit({ type: 'assistant', message: 'two' })).toBeUndefined();
    expect(delivered).toHaveLength(2);
  });

  it('admits an errored tool result alone, so nothing is delivered behind it until it is released', async () => {
    const { emit, delivered, settle } = await routeWithPendingDeliveries();
    expect(emit(erroredResult)).toBeUndefined();
    const terminal = emit({ type: 'result', is_error: false });
    expect(terminal).toBeInstanceOf(Promise);
    expect(delivered).toEqual([erroredResult]);
    settle[0]?.();
    await terminal;
    expect(delivered).toEqual([
      erroredResult,
      { type: 'result', is_error: false },
    ]);
  });
});
