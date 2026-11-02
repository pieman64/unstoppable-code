import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import type { AgentSession } from '../agents/types';
import { getOrCreateSession } from '../agents/session-manager';
import {
  EventPressureGate,
  GROUP_COMMIT_EVENT_PRESSURE_LIMITS,
} from '../agents/event-pressure';
import { recordEventReceiptTime } from '../agents/event-receipt-time';
import {
  activatePendingTurnRoute,
  getTurnRootAcceptance,
  observeRoutedTurnBinding,
  observeRoutedCodexTurnStart,
  discardPendingTurnRoute,
  getOrCreateRoutedSession,
  drainCurrentSessionEvents,
  getRoutedSessionPressureSnapshot,
  sessionEventRouterTestExports,
} from '../agents/session-event-router';
import { recordChatEventDropped } from '../lib/chat-event-drop-diagnostics';
import {
  attachProviderRunEvent,
  createProviderRunGeneration,
  observeProviderRunItem,
  registerProviderRun,
  retireProviderRunGeneration,
  settleProviderRun,
} from '../lib/provider-run-reconciliation';
import type { ChatQueueRevivalLease } from '../services/chat-queue-service';
import type { SessionDiagnosticRecord } from '../observability/service';

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

jest.mock('../lib/chat-event-drop-diagnostics', () => ({
  recordChatEventDropped: jest.fn(),
}));

const mockRecordSessionDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordSessionDiagnostic: typeof mockRecordSessionDiagnostic;
  } => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  }),
}));

const getSessionMock = jest.mocked(getOrCreateSession);
const recordChatEventDroppedMock = jest.mocked(recordChatEventDropped);
const recordSessionDiagnosticMock = mockRecordSessionDiagnostic;
const options = {
  cwd: '/tmp',
  projectId: 'cowork',
  worktreeId: 'entry',
  chatId: 'chat',
  providerType: 'claude' as const,
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function eventType(data: unknown): unknown {
  return typeof data === 'object' && data !== null
    ? Reflect.get(data, 'type')
    : undefined;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

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
  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      gate: 'router_stamp_mismatch',
      reason: 'route_turn_mismatch',
      data: { type: 'assistant', canopy_turn_user_message_id: 'wrong' },
      turnUserMessageId: 'root',
    }),
  );
  expect(handler.mock.calls.map(([event]) => event)).not.toContainEqual(
    expect.objectContaining({ type: 'assistant' }),
  );
  const oldGenerationPickup = handler.mock.calls.find(
    ([event]): boolean =>
      typeof event === 'object' &&
      event !== null &&
      Reflect.get(event, 'attemptId') === 'wrong',
  )?.[0];
  expect(oldGenerationPickup).not.toHaveProperty('turnRootAccepted');
  expect(getTurnRootAcceptance(oldGenerationPickup)).toBeUndefined();
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
  const pickup = handler.mock.calls.find(
    ([event]): boolean =>
      typeof event === 'object' &&
      event !== null &&
      Reflect.get(event, 'type') === 'canopy_input_delivery' &&
      Reflect.get(event, 'attemptId') === 'input',
  )?.[0];
  expect(getTurnRootAcceptance(pickup)).toEqual({ accepted: true });
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
  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      gate: 'turn_root_refused',
      reason: 'turn_root_refused',
      data: {
        type: 'canopy_input_delivery',
        provider: 'claude',
        generation: 'live',
        attemptId: 'stale-attempt',
        phase: 'picked-up',
        startsTurn: true,
        userMessageId: 'stale-root',
      },
      turnUserMessageId: 'stale-root',
    }),
  );
  expect(handler.mock.calls.map(([event]) => event)).toContainEqual(
    expect.objectContaining({
      type: 'canopy_input_delivery',
      attemptId: 'stale-attempt',
      phase: 'picked-up',
      turnRootAccepted: false,
    }),
  );
  const pickup = handler.mock.calls.find(
    ([event]): boolean =>
      typeof event === 'object' &&
      event !== null &&
      Reflect.get(event, 'attemptId') === 'stale-attempt',
  )?.[0];
  expect(getTurnRootAcceptance(pickup)).toEqual({ accepted: false });
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
  const pickup = handler.mock.calls.find(
    ([event]): boolean =>
      typeof event === 'object' &&
      event !== null &&
      Reflect.get(event, 'attemptId') === 'stale-attempt',
  )?.[0];
  expect(getTurnRootAcceptance(pickup)).toEqual({ accepted: false });
});

it('keeps a Claude pickup lease on its delivered object outside event persistence and forwarding', async () => {
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
  const lease: ChatQueueRevivalLease = { rootId: 'accepted-root', epoch: 7 };
  const acceptance = { accepted: true, lease };
  let resolveAcceptance: ((value: typeof acceptance) => void) | undefined;
  const acceptanceThenable = {
    then(resolve: (value: typeof acceptance) => void): void {
      resolveAcceptance = resolve;
    },
  };
  const forwarded: unknown[] = [];
  const persisted: unknown[] = [];
  const observedAcceptances: unknown[] = [];
  const handler = jest.fn((data: unknown): void => {
    if (
      typeof data === 'object' &&
      data !== null &&
      Reflect.get(data, 'type') === 'canopy_input_delivery'
    ) {
      observedAcceptances.push(getTurnRootAcceptance(data));
    }
    // Model the route sink's persistence and forwarding boundaries.
    const serialized = JSON.stringify(data);
    if (serialized !== undefined) persisted.push(JSON.parse(serialized));
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      forwarded.push({ ...data });
    }
  });
  const pickupSource: unknown = {
    type: 'canopy_input_delivery',
    provider: 'claude',
    generation: 'live',
    attemptId: 'accepted-attempt',
    phase: 'picked-up',
    startsTurn: true,
    userMessageId: 'accepted-root',
  };
  const lifecycle = {
    turnUserMessageId: 'old-root',
    acceptTurnRoot: (): typeof acceptanceThenable => acceptanceThenable,
    drainEventsBeforeRemoval: emptyDrain,
  };
  await Reflect.apply(getOrCreateRoutedSession, undefined, [
    options,
    handler,
    (): null => null,
    lifecycle,
  ]);
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');
  const pickupDelivery = emit(pickupSource);
  const followingEvent = emit({
    type: 'assistant',
    canopy_turn_user_message_id: 'accepted-root',
    message: 'accepted turn output',
  });
  await new Promise<void>((resolve): void => {
    setImmediate(resolve);
  });
  expect(handler).not.toHaveBeenCalled();
  if (!resolveAcceptance) {
    throw new Error('Expected the acceptance thenable to be observed');
  }
  resolveAcceptance(acceptance);
  await Promise.all([pickupDelivery, followingEvent]);
  await drainCurrentSessionEvents(options);

  const deliveredPickup = handler.mock.calls[0]?.[0];
  expect(deliveredPickup).toMatchObject({ turnRootAccepted: true });
  expect(observedAcceptances).toEqual([acceptance]);
  expect(observedAcceptances[0]).toBe(acceptance);
  expect(getTurnRootAcceptance(deliveredPickup)).toEqual(acceptance);
  expect(getTurnRootAcceptance(deliveredPickup)?.lease).toBe(lease);
  expect(getTurnRootAcceptance(pickupSource)).toBeUndefined();
  if (
    deliveredPickup === null ||
    typeof deliveredPickup !== 'object' ||
    Array.isArray(deliveredPickup)
  ) {
    throw new Error('Expected the delivered pickup event to be an object');
  }
  expect(
    handler.mock.calls.map(([event]): unknown =>
      typeof event === 'object' && event !== null && 'type' in event
        ? event.type
        : undefined,
    ),
  ).toEqual(['canopy_input_delivery', 'assistant']);
  const eventKeys = Object.keys(deliveredPickup);
  expect(eventKeys.filter((key) => /lease/i.test(key))).toEqual([]);
  expect(
    Reflect.ownKeys(deliveredPickup).filter((key) => typeof key === 'symbol'),
  ).toEqual([]);
  const serializedPickup = JSON.stringify(deliveredPickup);
  expect(serializedPickup).not.toContain('lease');

  const forwardedPickup = forwarded[0];
  const persistedPickup = persisted[0];
  expect(forwardedPickup).toEqual(deliveredPickup);
  expect(persistedPickup).toEqual(deliveredPickup);
  expect(getTurnRootAcceptance(forwardedPickup)).toBeUndefined();
  expect(getTurnRootAcceptance(persistedPickup)).toBeUndefined();
  if (
    forwardedPickup === null ||
    typeof forwardedPickup !== 'object' ||
    persistedPickup === null ||
    typeof persistedPickup !== 'object'
  ) {
    throw new Error('Expected forwarded and persisted pickup objects');
  }
  expect(
    Reflect.ownKeys(forwardedPickup).filter((key) => typeof key === 'symbol'),
  ).toEqual([]);
  expect(
    Reflect.ownKeys(persistedPickup).filter((key) => typeof key === 'symbol'),
  ).toEqual([]);
  expect(JSON.stringify(forwardedPickup)).not.toContain('lease');
  expect(JSON.stringify(persistedPickup)).not.toContain('lease');
});

it('does not replace the routed root when an object pickup acceptance is false', async () => {
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
  const rejectedLease: ChatQueueRevivalLease = {
    rootId: 'rejected-root',
    epoch: 8,
  };
  const acceptance = { accepted: false, lease: rejectedLease };
  const delivered: unknown[] = [];
  const handler = jest.fn((data: unknown): void => {
    delivered.push(data);
  });
  const lifecycle = {
    turnUserMessageId: 'current-root',
    acceptTurnRoot: (): typeof acceptance => acceptance,
    drainEventsBeforeRemoval: emptyDrain,
  };
  await Reflect.apply(getOrCreateRoutedSession, undefined, [
    options,
    handler,
    (): null => null,
    lifecycle,
  ]);
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');
  await emit({
    type: 'canopy_input_delivery',
    provider: 'claude',
    generation: 'live',
    attemptId: 'rejected-attempt',
    phase: 'picked-up',
    startsTurn: true,
    userMessageId: 'rejected-root',
  });
  await emit({
    type: 'assistant',
    canopy_turn_user_message_id: 'rejected-root',
    message: 'must be filtered',
  });
  await emit({
    type: 'assistant',
    canopy_turn_user_message_id: 'current-root',
    message: 'still current',
  });
  await drainCurrentSessionEvents(options);

  const deliveredPickup = delivered.find(
    (event): boolean =>
      typeof event === 'object' &&
      event !== null &&
      Reflect.get(event, 'attemptId') === 'rejected-attempt',
  );
  expect(deliveredPickup).toMatchObject({ turnRootAccepted: false });
  expect(getTurnRootAcceptance(deliveredPickup)).toEqual(acceptance);
  expect(getTurnRootAcceptance(deliveredPickup)?.lease).toBe(rejectedLease);
  expect(delivered).not.toContainEqual(
    expect.objectContaining({ message: 'must be filtered' }),
  );
  expect(delivered).toContainEqual(
    expect.objectContaining({ message: 'still current' }),
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  recordSessionDiagnosticMock.mockReset();
  sessionEventRouterTestExports.reset();
});

afterEach(() => {
  sessionEventRouterTestExports.reset();
});

it('routes a trusted late command result past a newer stamp without changing the root and rejects retired late provenance', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const handler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'newer-root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');

  const scope = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
  };
  const generation = createProviderRunGeneration(scope);
  const run = registerProviderRun(generation, {
    threadId: 'thread-1',
    turnId: 'older-turn',
    executionUserMessageId: 'older-root',
    origin: 'dispatched',
  });
  observeProviderRunItem(run, 'codex-item-older', 'command_execution');
  settleProviderRun(run);
  const lateEvent = {
    type: 'codex',
    canopy_turn_user_message_id: 'older-root',
    event: {
      type: 'item.completed',
      thread_id: 'thread-1',
      turn_id: 'older-turn',
      item: {
        id: 'codex-item-older',
        type: 'command_execution',
        aggregated_output: 'completed output',
      },
    },
  };
  attachProviderRunEvent(lateEvent, run, 'late');

  await emit(lateEvent);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler).toHaveBeenCalledWith(lateEvent, expect.any(Function));
  expect(recordChatEventDroppedMock).not.toHaveBeenCalled();

  await emit({
    type: 'assistant',
    canopy_turn_user_message_id: 'older-root',
    message: 'untrusted old-root output',
  });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      gate: 'router_stamp_mismatch',
      reason: 'route_turn_mismatch',
      turnUserMessageId: 'newer-root',
    }),
  );

  const retiredGeneration = createProviderRunGeneration(scope);
  const retiredRun = registerProviderRun(retiredGeneration, {
    threadId: 'thread-1',
    turnId: 'older-turn',
    executionUserMessageId: 'newer-root',
    origin: 'provider_owned',
  });
  observeProviderRunItem(retiredRun, 'codex-item-retired', 'command_execution');
  settleProviderRun(retiredRun);
  const retiredEvent = {
    type: 'codex',
    canopy_turn_user_message_id: 'newer-root',
    event: {
      type: 'item.completed',
      thread_id: 'thread-1',
      turn_id: 'older-turn',
      item: {
        id: 'codex-item-retired',
        type: 'command_execution',
        aggregated_output: 'must not be admitted',
      },
    },
  };
  attachProviderRunEvent(retiredEvent, retiredRun, 'late');
  retireProviderRunGeneration(retiredGeneration);

  await emit(retiredEvent);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      gate: 'router_stamp_mismatch',
      reason: 'retired_generation',
      data: retiredEvent,
    }),
  );
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
  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      gate: 'router_no_route',
      reason: 'replaced_transport',
      data: { type: 'assistant' },
    }),
  );
  oldRemoved?.();
  void getSessionMock.mock.calls[1]?.[1]({ type: 'assistant' });
  expect(oldHandler).not.toHaveBeenCalled();
  expect(currentHandler).toHaveBeenCalledTimes(1);
  expect(sessionEventRouterTestExports.currentRouteCount()).toBe(1);
});

it('records provider output after its route has been removed', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const handler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(
    { ...options, providerType: 'claude' },
    handler,
    () => null,
    { turnUserMessageId: 'root', drainEventsBeforeRemoval: emptyDrain },
  );
  const callback = getSessionMock.mock.calls[0]?.[1];
  getSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
  const dropped = { type: 'assistant', message: 'late output' };
  void callback?.(dropped);

  expect(handler).not.toHaveBeenCalled();
  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'cowork',
      worktreeId: 'entry',
      chatId: 'chat',
      providerType: 'claude',
      gate: 'router_no_route',
      reason: 'no_route',
      data: dropped,
    }),
  );
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
    { ...options, providerType: 'codex', sdkSessionId: 'root' },
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

it('records a root Codex terminal suppressed during a deferred-tools reload', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  jest
    .mocked(deferredToolsReloadCoordinator)
    .shouldSuppressProviderTerminal.mockReturnValue(true);
  const handler = jest.fn<void, [unknown]>();
  await getOrCreateRoutedSession(
    { ...options, providerType: 'codex', sdkSessionId: 'root' },
    handler,
    () => null,
    { turnUserMessageId: 'turn-owner', drainEventsBeforeRemoval: emptyDrain },
  );
  const emit = getSessionMock.mock.calls[0]?.[1];
  void emit?.({
    type: 'codex',
    event: { type: 'turn.started', thread_id: 'root', turn_id: 'turn-current' },
  });
  handler.mockClear();
  const dropped = {
    type: 'codex',
    event: {
      type: 'turn.completed',
      thread_id: 'root',
      turn_id: 'turn-current',
    },
  };
  void emit?.(dropped);

  expect(handler).not.toHaveBeenCalled();
  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      gate: 'router_deferred_tools_suppressed',
      reason: 'deferred_tools_terminal_suppressed',
      data: dropped,
      providerThreadId: 'root',
      providerTurnId: 'turn-current',
    }),
  );
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

it('drains the received prefix during a steady stream of later commits', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const pendingCommits: Array<() => void> = [];
  const handler = jest.fn(
    (): Promise<void> =>
      new Promise<void>((resolve) => {
        pendingCommits.push(resolve);
      }),
  );
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');

  void emit({ type: 'early' });
  let drained = false;
  const drain = drainCurrentSessionEvents(options).then(() => {
    drained = true;
  });
  let sequence = 0;
  const stream = setInterval(() => {
    void emit({ type: 'background', sequence: (sequence += 1) });
  }, 3);

  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    expect(drained).toBe(false);
    expect(pendingCommits.length).toBeGreaterThan(1);
    const beforeEarlyCommit = getRoutedSessionPressureSnapshot(options);
    expect(
      beforeEarlyCommit.activeCount + beforeEarlyCommit.waitingCount,
    ).toBeGreaterThan(0);

    const releaseEarly = pendingCommits[0];
    if (!releaseEarly) throw new Error('Missing early commit release');
    releaseEarly();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(drained).toBe(true);
    const atResolution = getRoutedSessionPressureSnapshot(options);
    // The former idle drain would still be waiting at this point.
    expect(
      atResolution.activeCount + atResolution.waitingCount,
    ).toBeGreaterThan(0);
  } finally {
    clearInterval(stream);
    for (const release of pendingCommits) release();
    await drain;
  }
});

it('starts the lifecycle drain after the last pre-call event and before later events', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const blocker = {
    type: 'blocker',
    payload: 'x'.repeat(
      GROUP_COMMIT_EVENT_PRESSURE_LIMITS.highWaterBytes + 6 * 1024,
    ),
  };
  const beforeDrain = { type: 'before-drain' };
  const afterDrain = { type: 'after-drain' };
  let releaseBlocker: (() => void) | undefined;
  const heldBlocker = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const received: unknown[] = [];
  const lifecyclePositions: number[] = [];
  const handler = jest.fn((data: unknown): void | Promise<void> => {
    received.push(data);
    return data === blocker ? heldBlocker : undefined;
  });
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: () => {
      lifecyclePositions.push(received.length);
      return Promise.resolve();
    },
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');

  void emit(blocker);
  const beforeReceipt = emit(beforeDrain);
  expect(beforeReceipt).toBeInstanceOf(Promise);
  expect(getRoutedSessionPressureSnapshot(options).waitingCount).toBe(1);
  const drain = drainCurrentSessionEvents(options);
  const afterReceipt = emit(afterDrain);
  expect(received).toEqual([blocker]);

  releaseBlocker?.();
  await Promise.all([
    drain,
    Promise.resolve(beforeReceipt),
    Promise.resolve(afterReceipt),
  ]);

  expect(received).toEqual([blocker, beforeDrain, afterDrain]);
  expect(lifecyclePositions).toEqual([2]);
});

it('commits a pre-call terminal result before the barrier resolves', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const terminal = {
    type: 'result',
    canopy_turn_user_message_id: 'root',
  };
  let releaseCommit: (() => void) | undefined;
  const commit = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let committed = false;
  const committedPromise = commit.then(() => {
    committed = true;
  });
  const handler = jest.fn(() => committedPromise);
  const lifecycleDrain = jest.fn(() => committedPromise);
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: lifecycleDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');

  void emit(terminal);
  let drained = false;
  const drain = drainCurrentSessionEvents(options).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(handler).toHaveBeenCalledWith(terminal, expect.any(Function));
  expect(lifecycleDrain).toHaveBeenCalledTimes(1);
  expect(committed).toBe(false);
  expect(drained).toBe(false);

  releaseCommit?.();
  await drain;

  expect(committed).toBe(true);
  expect(drained).toBe(true);
});

it('resolves a pre-removal drain while retained owned delegation events continue', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const preCall = { type: 'pre-removal' };
  let releasePreCall: (() => void) | undefined;
  const heldPreCall = new Promise<void>((resolve) => {
    releasePreCall = resolve;
  });
  const pendingDelegations: Array<() => void> = [];
  const handler = jest.fn((data: unknown): void | Promise<void> => {
    if (data === preCall) return heldPreCall;
    return new Promise<void>((resolve) => {
      pendingDelegations.push(resolve);
    });
  });
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');

  void emit(preCall);
  let drained = false;
  const drain = drainCurrentSessionEvents(options).then(() => {
    drained = true;
  });
  getSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
  void emit(delegationEvent('running'));
  void emit(delegationEvent('cancelled'));
  expect(handler).toHaveBeenCalledTimes(3);

  releasePreCall?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  try {
    expect(drained).toBe(true);
    expect(pendingDelegations).toHaveLength(2);
  } finally {
    for (const release of pendingDelegations) release();
    await drain;
  }
});

it('does not extend an old route drain to events on a replacement route', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const preCall = { type: 'old-route' };
  let releasePreCall: (() => void) | undefined;
  const heldPreCall = new Promise<void>((resolve) => {
    releasePreCall = resolve;
  });
  const oldHandler = jest.fn(() => heldPreCall);
  await getOrCreateRoutedSession(options, oldHandler, () => null, {
    turnUserMessageId: 'old-root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const oldEmit = getSessionMock.mock.calls[0]?.[1];
  if (!oldEmit) throw new Error('Missing old provider callback');

  void oldEmit(preCall);
  let drained = false;
  const drain = drainCurrentSessionEvents(options).then(() => {
    drained = true;
  });
  const pendingNewCommits: Array<() => void> = [];
  const newHandler = jest.fn(
    (): Promise<void> =>
      new Promise<void>((resolve) => {
        pendingNewCommits.push(resolve);
      }),
  );
  await getOrCreateRoutedSession(options, newHandler, () => null, {
    turnUserMessageId: 'new-root',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const newEmit = getSessionMock.mock.calls[1]?.[1];
  if (!newEmit) throw new Error('Missing replacement provider callback');
  void newEmit({ type: 'assistant', canopy_turn_user_message_id: 'new-root' });

  releasePreCall?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  try {
    expect(drained).toBe(true);
    expect(pendingNewCommits).toHaveLength(1);
  } finally {
    for (const release of pendingNewCommits) release();
    await drain;
  }
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
    { ...options, providerType: 'codex', sdkSessionId: 'root' },
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

  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({
      gate: 'router_stale_codex_root_error',
      reason: 'stale_codex_root_error',
      data: staleError,
      providerType: 'codex',
      providerThreadId: 'root',
      providerTurnId: 'turn-current',
    }),
  );

  expect(handler).toHaveBeenCalledTimes(2);
  expect(handler.mock.calls[0]?.[0]).toEqual(turnStarted);
  expect(handler.mock.calls[1]?.[0]).toEqual(currentError);
});

it('notifies only the latest route when a reused session is removed', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const first = jest.fn<void, []>();
  const second = jest.fn<void, []>();
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
    expect(heldBytes).toBeLessThanOrEqual(
      GROUP_COMMIT_EVENT_PRESSURE_LIMITS.highWaterBytes + largestFrameBytes,
    );
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

it('drains pending pickup arbitration and delivery but not later events', async () => {
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
  let acceptRoot: (accepted: boolean) => void = () => undefined;
  const acceptance = new Promise<boolean>((resolve) => {
    acceptRoot = resolve;
  });
  let releasePickupCommit = (): void => undefined;
  const pickupCommit = new Promise<void>((resolve) => {
    releasePickupCommit = resolve;
  });
  const laterCommits: Array<() => void> = [];
  const delivered: unknown[] = [];
  const lifecyclePositions: number[] = [];
  const handler = jest.fn((data: unknown): Promise<void> => {
    delivered.push(data);
    if (
      typeof data === 'object' &&
      data !== null &&
      Reflect.get(data, 'type') === 'canopy_input_delivery'
    ) {
      return pickupCommit;
    }
    return new Promise<void>((resolve) => {
      laterCommits.push(resolve);
    });
  });
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'old-root',
    acceptTurnRoot: () => acceptance,
    drainEventsBeforeRemoval: () => {
      lifecyclePositions.push(delivered.length);
      return Promise.resolve();
    },
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');

  void emit({
    type: 'canopy_input_delivery',
    provider: 'claude',
    generation: 'live',
    attemptId: 'pickup',
    phase: 'picked-up',
    startsTurn: true,
    userMessageId: 'new-root',
  });
  let drained = false;
  const drain = drainCurrentSessionEvents(options).then(() => {
    drained = true;
  });
  void emit({
    type: 'assistant',
    canopy_turn_user_message_id: 'new-root',
    message: 'later event',
  });

  try {
    expect(handler).not.toHaveBeenCalled();
    expect(drained).toBe(false);
    acceptRoot(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivered[0]).toMatchObject({
      type: 'canopy_input_delivery',
      turnRootAccepted: true,
    });
    expect(delivered[1]).toMatchObject({
      type: 'assistant',
      message: 'later event',
    });
    expect(lifecyclePositions).toEqual([1]);
    expect(drained).toBe(false);

    releasePickupCommit();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(drained).toBe(true);
    expect(laterCommits).toHaveLength(1);
  } finally {
    acceptRoot(true);
    releasePickupCommit();
    for (const release of laterCommits) release();
    await drain;
  }
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

it('starts a re-entrant drain after the parent handler returns', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const parent = { type: 'parent', canopy_turn_user_message_id: 'root' };
  const derived = { type: 'derived', canopy_turn_user_message_id: 'root' };
  let releaseParent = (): void => undefined;
  const parentCommit = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  let parentHandlerActive = false;
  let lifecycleStartedDuringParent = false;
  let drain: Promise<void> | undefined;
  const emitDerived = (): void => {
    const emit = getSessionMock.mock.calls[0]?.[1];
    if (!emit) throw new Error('Missing provider callback');
    void emit(derived);
  };
  const handler = jest.fn((data: unknown): void | Promise<void> => {
    if (data === parent) {
      parentHandlerActive = true;
      drain = drainCurrentSessionEvents(options);
      emitDerived();
      parentHandlerActive = false;
      return parentCommit;
    }
    return;
  });
  await getOrCreateRoutedSession(options, handler, () => null, {
    turnUserMessageId: 'root',
    drainEventsBeforeRemoval: (): Promise<void> => {
      lifecycleStartedDuringParent ||= parentHandlerActive;
      return Promise.resolve();
    },
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');

  const parentDelivery = emit(parent);
  expect(parentHandlerActive).toBe(false);
  expect(lifecycleStartedDuringParent).toBe(false);
  expect(drain).toBeDefined();
  let drained = false;
  const pendingDrain = Promise.resolve(drain).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  releaseParent();
  await Promise.all([parentDelivery, pendingDrain]);
  expect(drained).toBe(true);
  expect(lifecycleStartedDuringParent).toBe(false);
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

describe('periodic session ingestion diagnostics', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    sessionEventRouterTestExports.reset();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('records content-free lag from the receipt timestamp on the 10-second cadence', async () => {
    const session = makeSession();
    const delivered = jest.fn<void, [unknown]>();
    getSessionMock.mockResolvedValue(session);
    await getOrCreateRoutedSession(options, delivered, () => null, {
      turnUserMessageId: 'root',
      drainEventsBeforeRemoval: emptyDrain,
    });

    jest.advanceTimersByTime(1_500);
    const event = { type: 'assistant', message: 'private provider payload' };
    recordEventReceiptTime(event, performance.now() - 1_000);
    void getSessionMock.mock.calls[0]?.[1]?.(event);

    expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
    // The session's cadence begins at bind time, before this arrival.
    jest.advanceTimersByTime(8_499);
    expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    expect(recordSessionDiagnosticMock).toHaveBeenCalledTimes(1);
    const diagnostic = recordSessionDiagnosticMock.mock.calls[0]?.[0];
    expect(diagnostic).toMatchObject({
      kind: 'ingestion_lag',
      sessionKey: 'cowork/entry/chat',
      projectId: 'cowork',
      worktreeId: 'entry',
      chatId: 'chat',
      providerType: 'claude',
      admissionLatencyP50Ms: 1_000,
      admissionLatencyP95Ms: 1_000,
      admissionSampleCount: 1,
      admissionReceiptSampleCount: 1,
      admissionWindowMs: 10_000,
      backlogDepth: 0,
      backlogPeakDepth: 1,
    });
    expect(diagnostic).not.toHaveProperty('outcome');
    expect(JSON.stringify(diagnostic)).not.toContain(
      'private provider payload',
    );
  });

  it('uses the pressure-admission call as the fallback start time', async () => {
    const session = makeSession();
    const settlement = deferred();
    getSessionMock.mockResolvedValue(session);
    await getOrCreateRoutedSession(
      options,
      () => settlement.promise,
      () => null,
      { turnUserMessageId: 'root', drainEventsBeforeRemoval: emptyDrain },
    );

    void getSessionMock.mock.calls[0]?.[1]?.({ type: 'assistant' });
    jest.advanceTimersByTime(125);
    settlement.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(10_000);

    expect(recordSessionDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordSessionDiagnosticMock.mock.calls[0]?.[0]).toMatchObject({
      admissionLatencyP50Ms: 125,
      admissionLatencyP95Ms: 125,
      admissionSampleCount: 1,
      admissionReceiptSampleCount: 0,
    });
  });

  it('merges prebinding samples into reused-session metrics and aggregates overlapping route backlog', async () => {
    const session = makeSession();
    const firstSampleSettlement = deferred();
    const oldRouteHeld = deferred();
    const newRouteHeld = deferred();
    getSessionMock.mockResolvedValueOnce(session);

    await getOrCreateRoutedSession(
      options,
      (event: unknown): Promise<void> =>
        eventType(event) === 'old-sample'
          ? firstSampleSettlement.promise
          : oldRouteHeld.promise,
      () => null,
      { turnUserMessageId: 'root', drainEventsBeforeRemoval: emptyDrain },
    );
    const emitOldRoute = getSessionMock.mock.calls[0]?.[1];
    void emitOldRoute?.({ type: 'old-sample' });
    jest.advanceTimersByTime(40);
    firstSampleSettlement.resolve();
    await flushMicrotasks();
    void emitOldRoute?.({ type: 'old-held' });

    jest.advanceTimersByTime(960);
    getSessionMock.mockImplementationOnce(async (_options, onEvent) => {
      const prebindingSample = { type: 'prebinding-sample' };
      recordEventReceiptTime(prebindingSample, performance.now() - 500);
      void onEvent(prebindingSample);
      await flushMicrotasks();
      void onEvent({ type: 'new-held' });
      return session;
    });
    await getOrCreateRoutedSession(
      options,
      (event: unknown): Promise<void> =>
        eventType(event) === 'new-held'
          ? newRouteHeld.promise
          : Promise.resolve(),
      () => null,
      { turnUserMessageId: 'root', drainEventsBeforeRemoval: emptyDrain },
    );

    expect(getRoutedSessionPressureSnapshot(options)).toMatchObject({
      routeCount: 2,
      activeCount: 2,
      waitingCount: 0,
    });

    // The first window retains its original 10-second cadence across route
    // reuse. The prebinding sample merges into it, and both live route gates
    // contribute to the same session backlog snapshot.
    jest.advanceTimersByTime(9_040);
    expect(recordSessionDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordSessionDiagnosticMock.mock.calls[0]?.[0]).toMatchObject({
      kind: 'ingestion_lag',
      providerType: 'claude',
      admissionSampleCount: 2,
      admissionReceiptSampleCount: 1,
      backlogDepth: 2,
      backlogPeakDepth: 2,
    });

    // A still-held backlog repeats at the next cadence without new arrivals.
    jest.advanceTimersByTime(10_000);
    expect(recordSessionDiagnosticMock).toHaveBeenCalledTimes(2);
    expect(recordSessionDiagnosticMock.mock.calls[1]?.[0]).toMatchObject({
      admissionSampleCount: 0,
      backlogDepth: 2,
      backlogPeakDepth: 2,
    });

    oldRouteHeld.resolve();
    newRouteHeld.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(10_000);
    expect(recordSessionDiagnosticMock).toHaveBeenCalledTimes(3);
    expect(recordSessionDiagnosticMock.mock.calls[2]?.[0]).toMatchObject({
      admissionSampleCount: 2,
      backlogDepth: 0,
    });
  });

  it('starts a fresh metric window when the concrete session is replaced', async () => {
    const firstSession = makeSession();
    const replacementSession = makeSession();
    getSessionMock
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(replacementSession);

    await getOrCreateRoutedSession(
      options,
      () => undefined,
      () => null,
      {
        turnUserMessageId: 'root',
        drainEventsBeforeRemoval: emptyDrain,
      },
    );
    void getSessionMock.mock.calls[0]?.[1]?.({ type: 'assistant' });

    await getOrCreateRoutedSession(
      { ...options, providerType: 'codex' },
      () => undefined,
      () => null,
      { turnUserMessageId: 'root', drainEventsBeforeRemoval: emptyDrain },
    );
    void getSessionMock.mock.calls[1]?.[1]?.({ type: 'assistant' });
    jest.advanceTimersByTime(10_000);

    expect(recordSessionDiagnosticMock).toHaveBeenCalledTimes(2);
    expect(
      recordSessionDiagnosticMock.mock.calls.map(([record]) => record),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerType: 'claude',
          admissionSampleCount: 1,
        }),
        expect.objectContaining({
          providerType: 'codex',
          admissionSampleCount: 1,
        }),
      ]),
    );
  });

  it('does not report idle sessions and treats diagnostic failures as best effort', async () => {
    const idleSession = makeSession();
    getSessionMock.mockResolvedValueOnce(idleSession);
    await getOrCreateRoutedSession(
      options,
      () => undefined,
      () => null,
      {
        turnUserMessageId: 'root',
        drainEventsBeforeRemoval: emptyDrain,
      },
    );
    jest.advanceTimersByTime(30_000);
    expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();

    const activeSession = makeSession();
    getSessionMock.mockResolvedValueOnce(activeSession);
    await getOrCreateRoutedSession(
      options,
      () => undefined,
      () => null,
      {
        turnUserMessageId: 'root',
        drainEventsBeforeRemoval: emptyDrain,
      },
    );
    void getSessionMock.mock.calls[1]?.[1]?.({ type: 'assistant' });
    recordSessionDiagnosticMock.mockImplementationOnce(() => {
      throw new Error('diagnostics unavailable');
    });

    expect(() => jest.advanceTimersByTime(10_000)).not.toThrow();
  });

  it('flushes the last window once on removal and clears timers on removal, reset, and prebinding creation failure', async () => {
    const session = makeSession();
    getSessionMock.mockResolvedValueOnce(session);
    await getOrCreateRoutedSession(
      options,
      () => undefined,
      () => null,
      {
        turnUserMessageId: 'root',
        drainEventsBeforeRemoval: emptyDrain,
      },
    );
    void getSessionMock.mock.calls[0]?.[1]?.({ type: 'assistant' });
    getSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
    // Removal records the last partial window once; no timer survives it.
    expect(recordSessionDiagnosticMock).toHaveBeenCalledTimes(1);
    expect(recordSessionDiagnosticMock.mock.calls[0]?.[0]).toMatchObject({
      kind: 'ingestion_lag',
      admissionSampleCount: 1,
    });
    jest.advanceTimersByTime(10_000);
    expect(recordSessionDiagnosticMock).toHaveBeenCalledTimes(1);
    recordSessionDiagnosticMock.mockClear();

    getSessionMock.mockResolvedValueOnce(makeSession());
    await getOrCreateRoutedSession(
      options,
      () => undefined,
      () => null,
      {
        turnUserMessageId: 'root',
        drainEventsBeforeRemoval: emptyDrain,
      },
    );
    void getSessionMock.mock.calls[1]?.[1]?.({ type: 'assistant' });
    sessionEventRouterTestExports.reset();
    jest.advanceTimersByTime(10_000);
    expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();

    getSessionMock.mockImplementationOnce((_options, onEvent) => {
      void onEvent({ type: 'prebinding-sample' });
      return Promise.reject(new Error('session creation failed'));
    });
    await expect(
      getOrCreateRoutedSession(
        options,
        () => undefined,
        () => null,
        {
          turnUserMessageId: 'root',
          drainEventsBeforeRemoval: emptyDrain,
        },
      ),
    ).rejects.toThrow('session creation failed');
    jest.advanceTimersByTime(20_000);
    expect(recordSessionDiagnosticMock).not.toHaveBeenCalled();
  });
});

it('keeps an authenticated autonomous execution separate while a pending destination prepares', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const oldSink = jest.fn<void, [unknown]>();
  const pendingSink = jest.fn<void, [unknown]>();
  const codexOptions = { ...options, providerType: 'codex' as const };
  await getOrCreateRoutedSession(codexOptions, oldSink, () => null, {
    turnUserMessageId: 'old-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');
  const pending = {
    dispatchOwner: Symbol('prepared'),
    operationEpoch: 1,
    turnUserMessageId: 'prepared-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  };
  await getOrCreateRoutedSession(
    codexOptions,
    pendingSink,
    () => null,
    pending,
  );
  const generation = createProviderRunGeneration(options);
  const wake = registerProviderRun(generation, {
    threadId: 'native-thread',
    turnId: 'wake-turn',
    executionUserMessageId: 'old-anchor',
    origin: 'provider_owned',
  });
  const frame = (
    type: string,
    run = wake,
    anchor = run.executionUserMessageId,
  ): object =>
    attachProviderRunEvent(
      {
        type: 'codex',
        canopy_turn_user_message_id: anchor,
        event: { type, thread_id: run.threadId, turn_id: run.turnId },
      },
      run,
      'running',
    );
  const wakeStart = frame('turn.started');
  await emit(wakeStart);
  await emit(frame('item.started'));
  expect(oldSink).toHaveBeenCalledWith(wakeStart, expect.any(Function));
  expect(pendingSink).not.toHaveBeenCalled();

  const dispatched = registerProviderRun(generation, {
    threadId: 'native-thread',
    turnId: 'prepared-turn',
    executionUserMessageId: 'prepared-anchor',
    origin: 'dispatched',
  });
  const preparedStart = frame('turn.started', dispatched);
  await emit(preparedStart);
  expect(pendingSink).toHaveBeenCalledWith(preparedStart, expect.any(Function));
  const wakeTail = frame('item.updated');
  await emit(wakeTail);
  expect(oldSink).toHaveBeenCalledWith(wakeTail, expect.any(Function));
  expect(pendingSink).not.toHaveBeenCalledWith(wakeTail, expect.any(Function));

  const before = oldSink.mock.calls.length + pendingSink.mock.calls.length;
  await emit(frame('item.updated', wake, 'foreign-anchor'));
  const foreign = registerProviderRun(
    createProviderRunGeneration({ ...options, chatId: 'foreign' }),
    {
      threadId: 'native-thread',
      turnId: 'foreign-turn',
      executionUserMessageId: 'old-anchor',
      origin: 'provider_owned',
    },
  );
  await emit(frame('turn.started', foreign));
  retireProviderRunGeneration(generation);
  await emit(frame('item.updated', wake));
  expect(recordChatEventDroppedMock).toHaveBeenCalledWith(
    expect.objectContaining({ reason: 'retired_generation' }),
  );
  expect(oldSink.mock.calls.length + pendingSink.mock.calls.length).toBe(
    before,
  );
  expect(recordChatEventDroppedMock).toHaveBeenCalled();
});

it("delivers a pending destination's own failure before native start, then retires it", async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const previous = jest.fn<void, [unknown]>();
  const pending = jest.fn<void, [unknown]>();
  const codexOptions = { ...options, providerType: 'codex' as const };
  await getOrCreateRoutedSession(codexOptions, previous, () => null, {
    turnUserMessageId: 'previous-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');
  await getOrCreateRoutedSession(codexOptions, pending, () => null, {
    dispatchOwner: Symbol('prepared'),
    operationEpoch: 1,
    turnUserMessageId: 'prepared-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  // A turn/start failure carries the prompt's stamp but no run descriptor.
  const failure = {
    type: 'result',
    is_error: true,
    result: 'Codex turn failed',
    canopy_turn_user_message_id: 'prepared-anchor',
  };
  await emit(failure);
  expect(pending).toHaveBeenCalledWith(failure, expect.any(Function));
  expect(previous).not.toHaveBeenCalled();
  expect(sessionEventRouterTestExports.pendingRouteCount()).toBe(0);
  const previousOwn = {
    type: 'assistant',
    canopy_turn_user_message_id: 'previous-anchor',
  };
  await emit(previousOwn);
  expect(previous).toHaveBeenCalledWith(previousOwn, expect.any(Function));
  expect(pending).toHaveBeenCalledTimes(1);
});

it('activates the newest pending destination when an unsent one shares its anchor', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const unsent = jest.fn<void, [unknown]>();
  const resent = jest.fn<void, [unknown]>();
  const codexOptions = { ...options, providerType: 'codex' as const };
  await getOrCreateRoutedSession(codexOptions, jest.fn(), () => null, {
    turnUserMessageId: 'previous-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing provider callback');
  await getOrCreateRoutedSession(codexOptions, unsent, () => null, {
    dispatchOwner: Symbol('unsent'),
    operationEpoch: 1,
    turnUserMessageId: 'same-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  await getOrCreateRoutedSession(codexOptions, resent, () => null, {
    dispatchOwner: Symbol('resent'),
    operationEpoch: 2,
    turnUserMessageId: 'same-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  expect(sessionEventRouterTestExports.pendingRouteCount()).toBe(1);
  const run = registerProviderRun(createProviderRunGeneration(options), {
    threadId: 'native-thread',
    turnId: 'resent-turn',
    executionUserMessageId: 'same-anchor',
    origin: 'dispatched',
  });
  const start = attachProviderRunEvent(
    {
      type: 'codex',
      canopy_turn_user_message_id: 'same-anchor',
      event: {
        type: 'turn.started',
        thread_id: 'native-thread',
        turn_id: 'resent-turn',
      },
    },
    run,
    'running',
  );
  await emit(start);
  expect(resent).toHaveBeenCalledWith(start, expect.any(Function));
  expect(unsent).not.toHaveBeenCalled();
});

it('does not activate a pending destination from a stale generation or foreign transport binding for the same anchor', async () => {
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
  const previous = jest.fn();
  const pending = jest.fn();
  await getOrCreateRoutedSession(options, previous, () => null, {
    turnUserMessageId: 'same-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing callback');
  const dispatchOwner = Symbol('prepared');
  await getOrCreateRoutedSession(options, pending, () => null, {
    dispatchOwner,
    operationEpoch: 1,
    turnUserMessageId: 'same-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  observeRoutedTurnBinding(options, session, ['same-anchor'], 'stale');
  observeRoutedTurnBinding(options, makeSession(), ['same-anchor'], 'live');
  await emit({ type: 'assistant', canopy_turn_user_message_id: 'same-anchor' });
  expect(previous).toHaveBeenCalledTimes(1);
  expect(pending).not.toHaveBeenCalled();
  observeRoutedTurnBinding(options, session, ['same-anchor'], 'live');
  await emit({ type: 'assistant', canopy_turn_user_message_id: 'same-anchor' });
  expect(pending).toHaveBeenCalledTimes(1);
  await discardPendingTurnRoute(options, dispatchOwner, 1);
  await emit({ type: 'assistant', canopy_turn_user_message_id: 'same-anchor' });
  expect(pending).toHaveBeenCalledTimes(2);
});

it('activates a prepared destination at its send only for its own owner and epoch', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const previous = jest.fn();
  const prepared = jest.fn();
  await getOrCreateRoutedSession(options, previous, () => null, {
    turnUserMessageId: 'previous-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing callback');
  const dispatchOwner = Symbol('prepared');
  await getOrCreateRoutedSession(options, prepared, () => null, {
    dispatchOwner,
    operationEpoch: 2,
    turnUserMessageId: 'prepared-anchor',
    drainEventsBeforeRemoval: emptyDrain,
  });
  // A wake's untagged output keeps the current route while the prompt prepares.
  await emit({ type: 'assistant' });
  activatePendingTurnRoute(options, Symbol('other'), 2);
  activatePendingTurnRoute(options, dispatchOwner, 1);
  await emit({ type: 'assistant' });
  expect(previous).toHaveBeenCalledTimes(2);
  expect(prepared).not.toHaveBeenCalled();

  activatePendingTurnRoute(options, dispatchOwner, 2);
  await emit({ type: 'assistant' });
  expect(prepared).toHaveBeenCalledTimes(1);
  expect(previous).toHaveBeenCalledTimes(2);
  expect(sessionEventRouterTestExports.pendingRouteCount()).toBe(0);
});

it('routes content after normalized Codex start receipt even when the native start frame has not arrived', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const handler = jest.fn();
  await getOrCreateRoutedSession(
    { ...options, providerType: 'codex' },
    handler,
    () => null,
    { turnUserMessageId: 'retained', drainEventsBeforeRemoval: emptyDrain },
  );
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing callback');
  const generation = createProviderRunGeneration(options);
  const run = registerProviderRun(generation, {
    threadId: 'thread',
    turnId: 'native',
    origin: 'provider_owned',
    executionUserMessageId: 'retained',
  });
  const item = attachProviderRunEvent(
    {
      type: 'codex',
      canopy_turn_user_message_id: 'retained',
      event: { type: 'item.started', thread_id: 'thread', turn_id: 'native' },
    },
    run,
    'running',
  );
  observeRoutedCodexTurnStart(options, session, 'thread', 'native');
  await emit(item);
  expect(handler).toHaveBeenCalledWith(item, expect.any(Function));
});

it('acknowledges merged producer membership without moving execution output to the second input destination', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const original = jest.fn();
  const merged = jest.fn();
  await getOrCreateRoutedSession(options, original, () => null, {
    turnUserMessageId: 'first',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing callback');
  observeRoutedTurnBinding(options, session, ['first'], undefined, 'live-T');
  await getOrCreateRoutedSession(options, merged, () => null, {
    dispatchOwner: Symbol('merge'),
    operationEpoch: 2,
    turnUserMessageId: 'second',
    drainEventsBeforeRemoval: emptyDrain,
  });
  observeRoutedTurnBinding(
    options,
    session,
    ['first', 'second'],
    undefined,
    'live-T',
  );
  const output = { type: 'assistant', canopy_turn_user_message_id: 'first' };
  await emit(output);
  expect(original).toHaveBeenCalledWith(output, expect.any(Function));
  expect(merged).not.toHaveBeenCalled();
});

it('discards only a matching pending D and epoch after its captured drain without touching the execution route', async () => {
  const session = makeSession();
  getSessionMock.mockResolvedValue(session);
  const oldSink = jest.fn();
  const pendingSink = jest.fn();
  await getOrCreateRoutedSession(options, oldSink, () => null, {
    turnUserMessageId: 'executing',
    drainEventsBeforeRemoval: emptyDrain,
  });
  const emit = getSessionMock.mock.calls[0]?.[1];
  if (!emit) throw new Error('Missing callback');
  const captured = deferred();
  const drain = jest.fn(() => captured.promise);
  const owner = Symbol('D');
  await getOrCreateRoutedSession(options, pendingSink, () => null, {
    dispatchOwner: owner,
    operationEpoch: 3,
    turnUserMessageId: 'prepared',
    drainEventsBeforeRemoval: drain,
  });
  await discardPendingTurnRoute(options, owner, 2);
  expect(drain).not.toHaveBeenCalled();
  let discarded = false;
  const discard = discardPendingTurnRoute(options, owner, 3).then(() => {
    discarded = true;
  });
  await flushMicrotasks();
  expect(discarded).toBe(false);
  await emit({ type: 'assistant', canopy_turn_user_message_id: 'executing' });
  expect(oldSink).toHaveBeenCalledTimes(1);
  captured.resolve();
  await discard;
  observeRoutedTurnBinding(options, session, ['prepared'], undefined, 'new-T');
  await emit({ type: 'assistant', canopy_turn_user_message_id: 'prepared' });
  expect(pendingSink).not.toHaveBeenCalled();
  await discardPendingTurnRoute(options, owner, 3);
  expect(drain).toHaveBeenCalledTimes(1);
});

it('notifies a prepared destination when its live transport is removed without activating it', async () => {
  getSessionMock.mockResolvedValue(makeSession());
  const executionRemoved = jest.fn<void, []>();
  const pendingRemoved = jest.fn<void, []>();
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    turnUserMessageId: 'execution',
    drainEventsBeforeRemoval: emptyDrain,
    onRemoved: executionRemoved,
  });
  await getOrCreateRoutedSession(options, jest.fn(), () => null, {
    dispatchOwner: Symbol('pending'),
    operationEpoch: 1,
    turnUserMessageId: 'pending',
    drainEventsBeforeRemoval: emptyDrain,
    onRemoved: pendingRemoved,
  });
  getSessionMock.mock.calls[0]?.[3]?.onRemoved?.();
  expect(pendingRemoved).toHaveBeenCalledTimes(1);
  expect(executionRemoved).toHaveBeenCalledTimes(1);
});
