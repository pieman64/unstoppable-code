import type {
  ChatQueueOrigin,
  ChatQueueTarget,
  ChatQueueUpdatedEvent,
  ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';
import type { SessionDiagnosticRecord } from '../observability/service';
import {
  ChatQueueService,
  type ChatQueueServiceDependencies,
} from '../services/chat-queue-service';
import {
  beginCodexSessionTurn,
  finishCodexSessionTurn,
  recordCodexTurnEnd,
} from '../agents/provider-turn-evidence';
import { buildChatSessionKey } from '../agents/session-key';
import { TurnAuthPreflightBlockedError } from '../lib/auth-preflight-error';
import { AutoModelRoutingInProgressError } from '../model-routing/in-progress-error';

const mockRecordSessionDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();

type DiagnosticMockService = {
  recordSessionDiagnostic: (event: SessionDiagnosticRecord) => void;
};

type DiagnosticMockModule = {
  getObservabilityService: () => DiagnosticMockService;
};

jest.mock(
  '../observability',
  (): DiagnosticMockModule => ({
    getObservabilityService: (): DiagnosticMockService => ({
      recordSessionDiagnostic: mockRecordSessionDiagnostic,
    }),
  }),
);

jest.mock(
  '../observability/service',
  (): DiagnosticMockModule => ({
    getObservabilityService: (): DiagnosticMockService => ({
      recordSessionDiagnostic: mockRecordSessionDiagnostic,
    }),
  }),
);

// Delegation deliveries in these tests stand for live host-issued ones.
jest.mock('../agents/delegation/lifecycle', () => ({
  ...jest.requireActual<object>('../agents/delegation/lifecycle'),
  isDelegationDeliveryActive: (): boolean => true,
}));

jest.mock(
  '../lib/main-process-logging',
  (): { logMainProcessWarn: () => void } => ({
    logMainProcessWarn: jest.fn(),
  }),
);

interface ReconcileHarness {
  service: ChatQueueService;
  dispatched: string[];
  broadcasts: ChatQueueUpdatedEvent[];
  scheduledDelays: number[];
  timeline: string[];
  setActiveProviderTurn: (active: boolean) => void;
  setPendingProviderContinuation: (pending: boolean) => void;
  setPendingUserDecision: (pending: boolean) => void;
  setBackgroundWork: (active: boolean) => void;
  setDispatchImpl: (impl: (() => Promise<void>) | undefined) => void;
  setCancelImpl: (impl: (() => Promise<void>) | undefined) => void;
  setDrainProviderEventsImpl: (
    impl: ((target: ChatQueueTarget) => Promise<void>) | undefined,
  ) => void;
  setPersistRuntimeImpl: (
    impl: ChatQueueServiceDependencies['persistRuntime'] | undefined,
  ) => void;
  setSettleImpl: (impl: (() => Promise<void>) | undefined) => void;
  setCanonicalTurnOpenImpl: (
    impl:
      | ((
          target: ChatQueueTarget,
          turnUserMessageId: string,
        ) => Promise<boolean>)
      | undefined,
  ) => void;
  setHasCommittedMessageImpl: (
    impl: ChatQueueServiceDependencies['hasCommittedMessage'] | undefined,
  ) => void;
  setPreparationCancelled: (cancelled: boolean) => void;
}

function reconcileTarget(): ChatQueueTarget {
  return {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };
}

function reconcileRequest(userMessageId: string): ChatSendMessageRequest {
  return {
    ...reconcileTarget(),
    userMessageId,
    text: userMessageId,
  };
}

function createReconcileHarness(): ReconcileHarness {
  const dispatched: string[] = [];
  const broadcasts: ChatQueueUpdatedEvent[] = [];
  const scheduledDelays: number[] = [];
  const timeline: string[] = [];
  let id = 0;
  let activeProviderTurn = false;
  let pendingProviderContinuation = false;
  let pendingUserDecision = false;
  let backgroundWork = false;
  let dispatchImpl: (() => Promise<void>) | undefined;
  let cancelImpl: (() => Promise<void>) | undefined;
  let drainProviderEventsImpl:
    | ((target: ChatQueueTarget) => Promise<void>)
    | undefined;
  let persistRuntimeImpl:
    | ChatQueueServiceDependencies['persistRuntime']
    | undefined;
  let settleImpl: (() => Promise<void>) | undefined;
  let canonicalTurnOpenImpl:
    | ((target: ChatQueueTarget, turnUserMessageId: string) => Promise<boolean>)
    | undefined;
  let hasCommittedMessageImpl:
    | ChatQueueServiceDependencies['hasCommittedMessage']
    | undefined;
  let preparationCancelled = false;
  const dependencies: ChatQueueServiceDependencies = {
    dispatch: async (
      request: ChatSendMessageRequest,
      _origin: ChatQueueOrigin,
      _fromQueue: boolean,
    ): Promise<void> => {
      void _origin;
      void _fromQueue;
      dispatched.push(request.userMessageId);
      timeline.push(`dispatch:${request.userMessageId}`);
      if (dispatchImpl) await dispatchImpl();
    },
    cancel: (): Promise<void> => cancelImpl?.() ?? Promise.resolve(),
    settleCancelledTurn: async (
      _target: ChatQueueTarget,
      turnUserMessageId?: string,
    ): Promise<void> => {
      timeline.push(`settle:${turnUserMessageId ?? 'untagged'}`);
      if (settleImpl) await settleImpl();
    },
    beginTurnPreparation: () => ({
      cancelled: preparationCancelled,
      finish: (): void => {
        timeline.push('finish-preparation');
      },
    }),
    hasActiveProviderTurn: (): boolean => activeProviderTurn,
    hasPendingProviderContinuation: (): boolean => pendingProviderContinuation,
    hasPendingUserDecision: (): boolean => pendingUserDecision,
    hasBackgroundWork: (): boolean => backgroundWork,
    drainProviderEvents: (queuedTarget): Promise<void> => {
      timeline.push('drain-provider-events');
      return drainProviderEventsImpl?.(queuedTarget) ?? Promise.resolve();
    },
    get isCanonicalTurnOpen(): ChatQueueServiceDependencies['isCanonicalTurnOpen'] {
      return canonicalTurnOpenImpl;
    },
    get hasCommittedMessage(): ChatQueueServiceDependencies['hasCommittedMessage'] {
      return hasCommittedMessageImpl;
    },
    persistRuntime: (...args): void | Promise<void> => {
      timeline.push('persist-runtime');
      return persistRuntimeImpl?.(...args);
    },
    broadcast: (event): void => {
      broadcasts.push(event);
    },
    createId: (): string => `queued-${++id}`,
    now: (): number => Date.now(),
    schedule: (callback, delayMs): ReturnType<typeof setTimeout> => {
      scheduledDelays.push(delayMs);
      return setTimeout(callback, delayMs);
    },
  };
  return {
    service: new ChatQueueService(dependencies),
    dispatched,
    broadcasts,
    scheduledDelays,
    timeline,
    setActiveProviderTurn: (active): void => {
      activeProviderTurn = active;
    },
    setPendingProviderContinuation: (pending): void => {
      pendingProviderContinuation = pending;
    },
    setPendingUserDecision: (pending): void => {
      pendingUserDecision = pending;
    },
    setBackgroundWork: (active): void => {
      backgroundWork = active;
    },
    setDispatchImpl: (impl): void => {
      dispatchImpl = impl;
    },
    setCancelImpl: (impl): void => {
      cancelImpl = impl;
    },
    setDrainProviderEventsImpl: (impl): void => {
      drainProviderEventsImpl = impl;
    },
    setPersistRuntimeImpl: (impl): void => {
      persistRuntimeImpl = impl;
    },
    setSettleImpl: (impl): void => {
      settleImpl = impl;
    },
    setCanonicalTurnOpenImpl: (impl): void => {
      canonicalTurnOpenImpl = impl;
    },
    setHasCommittedMessageImpl: (impl): void => {
      hasCommittedMessageImpl = impl;
    },
    setPreparationCancelled: (cancelled): void => {
      preparationCancelled = cancelled;
    },
  };
}

function diagnosticRecords(
  kind: SessionDiagnosticRecord['kind'],
): SessionDiagnosticRecord[] {
  return mockRecordSessionDiagnostic.mock.calls
    .map(([record]) => record)
    .filter((record) => record.kind === kind);
}

function reconcileSessionActivity(service: ChatQueueService): void {
  service.reconcileSessionActivity();
}

function authPreflightRefusal(): TurnAuthPreflightBlockedError {
  return new TurnAuthPreflightBlockedError([
    {
      dependencyClass: 'mcp',
      dependencyId: 'server-1:config-1',
      displayName: 'Build MCP server',
      failureClass: 'unauthenticated',
      recovery: {
        kind: 'mcp_oauth',
        serverId: 'server-1',
        configId: 'config-1',
      },
    },
  ]);
}

async function parkAuthPreflightRefusedHead(
  harness: ReconcileHarness,
): Promise<string> {
  await harness.service.submit(
    reconcileRequest('auth-refusal-root'),
    'desktop',
  );
  await harness.service.submit(reconcileRequest('auth-refused-row'), 'desktop');
  harness.setDispatchImpl(() => Promise.reject(authPreflightRefusal()));
  harness.service.onTurnTerminal(
    reconcileTarget(),
    'complete',
    'auth-refusal-root',
  );
  await jest.advanceTimersByTimeAsync(0);
  const rowId = harness.service.getWorktreeSnapshots(
    'project-1',
    'worktree-1',
  )[0]?.queue[0]?.id;
  if (!rowId) throw new Error('Expected the refused row to be restored');
  return rowId;
}

describe('ChatQueueService stale-gate reconciliation', () => {
  beforeEach((): void => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
    mockRecordSessionDiagnostic.mockClear();
    const key = buildChatSessionKey('project-1', 'worktree-1', 'chat-1');
    beginCodexSessionTurn(key, 'reconcile-test-reset');
    finishCodexSessionTurn(key, 'reconcile-test-reset');
  });

  afterEach((): void => {
    jest.useRealTimers();
  });

  it.each([
    'provider_events',
    'canonical_turn',
    'settle_cancelled_turn',
  ] as const)(
    'attributes a held %s dependency to its own recovery phase, not gate age',
    async (phase) => {
      const harness = createReconcileHarness();
      await harness.service.submit(reconcileRequest('timed-root'), 'desktop');
      await harness.service.submit(
        reconcileRequest('timed-follow-up'),
        'desktop',
      );
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (phase === 'provider_events')
        harness.setDrainProviderEventsImpl(() => held);
      if (phase === 'canonical_turn')
        harness.setCanonicalTurnOpenImpl(() => held.then(() => true));
      if (phase === 'settle_cancelled_turn') harness.setSettleImpl(() => held);

      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(1_000);

      const stalled = diagnosticRecords('chat_wait_phase').find(
        (record) =>
          record.waitOperation === 'chat_queue.stale_gate_reconcile' &&
          record.waitPhase === phase &&
          record.waitOutcome === 'stalled',
      );
      expect(stalled).toMatchObject({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        waitElapsedMs: 1_000,
        waitQueueDepth: 1,
        waitGateOwnerInputId: 'timed-root',
      });
      expect(typeof stalled?.waitOperationId).toBe('string');
      expect(typeof stalled?.waitStartedAtMs).toBe('number');
      expect(typeof stalled?.waitOperationEpoch).toBe('number');
      expect(stalled?.queueGateAgeMs).toBeGreaterThanOrEqual(6_000);
      expect(stalled?.waitElapsedMs).toBeLessThan(stalled?.queueGateAgeMs ?? 0);
      if (phase === 'provider_events')
        expect(
          diagnosticRecords('chat_wait_phase').filter(
            (record) =>
              record.waitOperationId === stalled?.waitOperationId &&
              record.waitPhase === 'recovery_acquired',
          ),
        ).toHaveLength(0);
      expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);

      release();
      await jest.advanceTimersByTimeAsync(0);
      expect(diagnosticRecords('chat_wait_phase')).toContainEqual(
        expect.objectContaining({
          waitOperationId: stalled?.waitOperationId,
          waitPhase: phase,
          waitOutcome:
            phase === 'settle_cancelled_turn' ? 'released' : 'completed',
        }),
      );
    },
  );

  it.each([
    'queue_persistence',
    'provider_events',
    'canonical_turn',
    'settle_cancelled_turn',
  ] as const)('names a held Codex recovery %s dependency', async (phase) => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      { ...reconcileRequest('codex-recovery-root'), executionHarness: 'codex' },
      'desktop',
    );
    harness.setCanonicalTurnOpenImpl(() => Promise.resolve(true));
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dependencyEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      dependencyEntered = resolve;
    });
    if (phase === 'queue_persistence')
      harness.setPersistRuntimeImpl(() => {
        dependencyEntered();
        return held;
      });
    if (phase === 'provider_events')
      harness.setDrainProviderEventsImpl(() => {
        dependencyEntered();
        return held;
      });
    if (phase === 'canonical_turn')
      harness.setCanonicalTurnOpenImpl(() => {
        dependencyEntered();
        return held.then(() => true);
      });
    if (phase === 'settle_cancelled_turn')
      harness.setSettleImpl(() => {
        dependencyEntered();
        return held;
      });

    const followUp = harness.service.submit(
      {
        ...reconcileRequest('codex-recovery-follow-up'),
        executionHarness: 'codex',
      },
      'desktop',
    );
    await entered;
    await jest.advanceTimersByTimeAsync(1_000);
    const stalled = diagnosticRecords('chat_wait_phase').find(
      (record) =>
        record.waitOperation === 'chat_queue.recover_idle_codex_turn_gate' &&
        record.waitPhase === phase &&
        record.waitOutcome === 'stalled',
    );
    expect(stalled).toMatchObject({
      waitElapsedMs: 1_000,
      waitGateOwnerInputId: 'codex-recovery-root',
    });
    expect(typeof stalled?.waitOwnerTokenId).toBe('string');
    expect(typeof stalled?.waitOperationEpoch).toBe('number');
    expect(diagnosticRecords('chat_wait_phase')).toContainEqual(
      expect.objectContaining({
        waitOperationId: stalled?.waitOperationId,
        waitPhase: 'recovery_acquired',
        waitOwnerTokenId: stalled?.waitOwnerTokenId,
      }),
    );
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    release();
    await followUp;
    expect(diagnosticRecords('chat_wait_phase')).toContainEqual(
      expect.objectContaining({
        waitOperationId: stalled?.waitOperationId,
        waitPhase: 'recovery_released',
        waitOwnerTokenId: stalled?.waitOwnerTokenId,
      }),
    );
  });

  it('records an immediate queue mutation recovery claim and release', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(reconcileRequest('move-root'), 'desktop');
    await harness.service.submit(reconcileRequest('move-row'), 'desktop');
    const rowId = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    )[0]?.queue[0]?.id;
    if (!rowId) throw new Error('Expected queued row');

    await expect(
      harness.service.move(reconcileTarget(), rowId, null),
    ).resolves.toBe('applied');
    const records = diagnosticRecords('chat_wait_phase').filter(
      (record) => record.waitOperation === 'chat_queue.move',
    );
    const acquired = records.find(
      (record) => record.waitPhase === 'recovery_acquired',
    );
    const released = records.find(
      (record) => record.waitPhase === 'recovery_released',
    );
    expect(acquired).toMatchObject({
      waitScope: reconcileTarget(),
      waitOutcome: 'completed',
    });
    expect(released).toMatchObject({
      waitOperationId: acquired?.waitOperationId,
      waitOwnerTokenId: acquired?.waitOwnerTokenId,
      waitOutcome: 'released',
    });
  });

  it('caps recovery wait records for a burst of queue mutations', async () => {
    // Start a fresh limiter window, apart from records of earlier tests.
    await jest.advanceTimersByTimeAsync(60_000);
    mockRecordSessionDiagnostic.mockClear();
    const harness = createReconcileHarness();
    await harness.service.submit(reconcileRequest('burst-root'), 'desktop');
    await harness.service.submit(reconcileRequest('burst-row'), 'desktop');
    const rowId = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    )[0]?.queue[0]?.id;
    if (!rowId) throw new Error('Expected queued row');

    for (let index = 0; index < 250; index += 1) {
      await expect(
        harness.service.move(reconcileTarget(), rowId, null),
      ).resolves.toBe('applied');
    }
    const records = diagnosticRecords('chat_wait_phase');
    const movePhases = (phase: string): SessionDiagnosticRecord[] =>
      records.filter(
        (record) =>
          record.waitOperation === 'chat_queue.move' &&
          record.waitPhase === phase,
      );
    // Unbounded, 250 claimed moves would record 750.
    expect(records.length).toBeLessThanOrEqual(512);
    const acquired = movePhases('recovery_acquired');
    expect(acquired.length).toBeGreaterThan(0);
    expect(acquired.length).toBeLessThan(250);
    // An admitted claim keeps both halves of its interval.
    expect(
      movePhases('recovery_released').map((record) => record.waitOperationId),
    ).toEqual(acquired.map((record) => record.waitOperationId));
    // Later tests start in a fresh limiter window.
    await jest.advanceTimersByTimeAsync(60_000);
  });

  it('releases an idle message-owned gate after five seconds and drains its queued row', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('lost-terminal-root'),
      'desktop',
    );

    await harness.service.submit(
      reconcileRequest('queued-follow-up'),
      'desktop',
    );
    expect(harness.dispatched).toEqual(['lost-terminal-root']);

    await jest.advanceTimersByTimeAsync(5_000);

    expect(harness.service.isTurnActive(reconcileTarget())).toBe(false);
    expect(diagnosticRecords('chat_queue_gate_stale')).toContainEqual(
      expect.objectContaining({
        queueGateSource: 'immediate-dispatch',
        queueGateOwnerId: 'lost-terminal-root',
      }),
    );
    expect(
      diagnosticRecords('chat_queue_gate_stale').find(
        (record) => record.queueGateOwnerId === 'lost-terminal-root',
      )?.queueGateAgeMs,
    ).toBeGreaterThanOrEqual(5_000);
    await jest.advanceTimersByTimeAsync(1);

    expect(harness.dispatched).toEqual([
      'lost-terminal-root',
      'queued-follow-up',
    ]);

    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([
      expect.objectContaining({
        kind: 'chat_queue_gate_stale',
        queueGateSource: 'immediate-dispatch',
        queueGateOwnerId: 'lost-terminal-root',
      }),
    ]);
    expect(
      diagnosticRecords('chat_queue_gate_stale')[0]?.queueGateAgeMs,
    ).toBeGreaterThanOrEqual(5_000);
  });

  it('reconciles a lost terminal on a queued dispatch gate', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('queued-gate-root'),
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('queued-gate-dispatch'),
      'desktop',
    );
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'queued-gate-root',
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual([
      'queued-gate-root',
      'queued-gate-dispatch',
    ]);

    await harness.service.submit(
      reconcileRequest('queued-gate-follow-up'),
      'desktop',
    );
    await jest.advanceTimersByTimeAsync(5_000);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(false);
    expect(diagnosticRecords('chat_queue_gate_stale')).toContainEqual(
      expect.objectContaining({
        queueGateSource: 'queued-dispatch',
        queueGateOwnerId: 'queued-gate-dispatch',
      }),
    );
    expect(
      diagnosticRecords('chat_queue_gate_stale').find(
        (record) => record.queueGateOwnerId === 'queued-gate-dispatch',
      )?.queueGateAgeMs,
    ).toBeGreaterThanOrEqual(5_000);
    await jest.advanceTimersByTimeAsync(1);

    expect(harness.dispatched).toEqual([
      'queued-gate-root',
      'queued-gate-dispatch',
      'queued-gate-follow-up',
    ]);
    expect(diagnosticRecords('chat_queue_gate_stale')).toContainEqual(
      expect.objectContaining({
        queueGateSource: 'queued-dispatch',
        queueGateOwnerId: 'queued-gate-dispatch',
      }),
    );
    expect(
      diagnosticRecords('chat_queue_gate_stale').find(
        (record) => record.queueGateOwnerId === 'queued-gate-dispatch',
      )?.queueGateAgeMs,
    ).toBeGreaterThanOrEqual(5_000);
  });

  it('reconciles an idle revived-root gate and reports its arm source', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('revived-gate-root'),
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('revived-gate-follow-up'),
      'desktop',
    );
    harness.setCanonicalTurnOpenImpl(() => Promise.resolve(false));
    harness.service.confirmTurnRevived(reconcileTarget(), 'revived-gate-root');

    await jest.advanceTimersByTimeAsync(5_000);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(false);
    expect(diagnosticRecords('chat_queue_gate_stale')).toContainEqual(
      expect.objectContaining({
        queueGateSource: 'revived-root',
        queueGateOwnerId: 'revived-gate-root',
      }),
    );
    await jest.advanceTimersByTimeAsync(1);

    expect(harness.dispatched).toEqual([
      'revived-gate-root',
      'revived-gate-follow-up',
    ]);
    expect(diagnosticRecords('chat_queue_gate_stale')).toContainEqual(
      expect.objectContaining({
        queueGateSource: 'revived-root',
        queueGateOwnerId: 'revived-gate-root',
      }),
    );
  });

  it('reconciles an aged adopted provider gate on idle/removal session activity', async () => {
    const harness = createReconcileHarness();
    harness.setActiveProviderTurn(true);
    await harness.service.submit(
      reconcileRequest('adopted-follow-up'),
      'desktop',
    );

    await jest.advanceTimersByTimeAsync(5_000);
    expect(harness.dispatched).toEqual([]);

    harness.setActiveProviderTurn(false);
    reconcileSessionActivity(harness.service);
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual(['adopted-follow-up']);
    const staleDiagnostic = diagnosticRecords('chat_queue_gate_stale')[0];
    expect(diagnosticRecords('chat_queue_gate_stale')).toContainEqual(
      expect.objectContaining({
        queueGateSource: 'adopted-provider-activity',
      }),
    );
    expect(staleDiagnostic).not.toHaveProperty('queueGateOwnerId');
  });

  it('does not steal a force recovery reservation during stale-gate reconciliation', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('force-recovery-root'),
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('force-recovery-row'),
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('force-recovery-tail'),
      'desktop',
    );
    harness.setActiveProviderTurn(true);
    await jest.advanceTimersByTimeAsync(5_000);

    let signalCancelStart = (): void => undefined;
    const cancelStarted = new Promise<void>((resolve) => {
      signalCancelStart = resolve;
    });
    let releaseCancel = (): void => undefined;
    harness.setCancelImpl(
      () =>
        new Promise<void>((resolve) => {
          signalCancelStart();
          releaseCancel = resolve;
        }),
    );
    const queue = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    )[0]?.queue;
    const forceRowId = queue?.[0]?.id;
    const tailRowId = queue?.[1]?.id;
    if (!forceRowId || !tailRowId)
      throw new Error('Expected two queued rows before forcing');
    const force = harness.service.force(reconcileTarget(), forceRowId);
    await cancelStarted;

    harness.setActiveProviderTurn(false);
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(harness.dispatched).toEqual(['force-recovery-root']);
    await expect(
      harness.service.edit({
        ...reconcileTarget(),
        entryId: tailRowId,
        text: 'must remain locked during force',
      }),
    ).resolves.toBe('busy');

    releaseCancel();
    await expect(force).resolves.toBe('applied');
    expect(harness.dispatched).toEqual([
      'force-recovery-root',
      'force-recovery-row',
    ]);
  });

  it('cancels a pending retry when an in-flight dispatch parks its refused row', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('retry-race-root'),
      'desktop',
    );
    await harness.service.submit(reconcileRequest('retry-race-row'), 'desktop');
    await harness.service.submit(
      reconcileRequest('retry-race-tail'),
      'desktop',
    );

    let signalDispatchStart = (): void => undefined;
    const dispatchStarted = new Promise<void>((resolve) => {
      signalDispatchStart = resolve;
    });
    let refuseDispatch: (error: Error) => void = () => undefined;
    harness.setDispatchImpl(
      () =>
        new Promise<void>((_resolve, reject) => {
          signalDispatchStart();
          refuseDispatch = (error): void => reject(error);
        }),
    );
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'retry-race-root',
    );
    await jest.advanceTimersByTimeAsync(0);
    await dispatchStarted;

    reconcileSessionActivity(harness.service);
    expect(harness.scheduledDelays).toContain(1_000);

    refuseDispatch(authPreflightRefusal());
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual(['retry-race-root', 'retry-race-row']);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(harness.dispatched).toEqual(['retry-race-root', 'retry-race-row']);

    harness.setDispatchImpl(undefined);
    await harness.service.submit(
      reconcileRequest('retry-race-trigger'),
      'desktop',
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual([
      'retry-race-root',
      'retry-race-row',
      'retry-race-row',
    ]);
  });

  it('does not reconcile an auth-preflight parked row and retries it after a new submit', async () => {
    const harness = createReconcileHarness();
    await parkAuthPreflightRefusedHead(harness);

    reconcileSessionActivity(harness.service);
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual([
      'auth-refusal-root',
      'auth-refused-row',
    ]);

    harness.setDispatchImpl(undefined);
    await harness.service.submit(
      reconcileRequest('auth-retry-trigger'),
      'desktop',
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual([
      'auth-refusal-root',
      'auth-refused-row',
      'auth-refused-row',
    ]);
  });

  it('retries an auth-preflight parked row after the user edits it', async () => {
    const harness = createReconcileHarness();
    const rowId = await parkAuthPreflightRefusedHead(harness);

    reconcileSessionActivity(harness.service);
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual([
      'auth-refusal-root',
      'auth-refused-row',
    ]);

    harness.setDispatchImpl(undefined);

    await harness.service.edit({
      ...reconcileTarget(),
      entryId: rowId,
      text: 'edited auth-refused row',
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual([
      'auth-refusal-root',
      'auth-refused-row',
      'auth-refused-row',
    ]);
  });

  it('does not reconcile a capped committed-message fallback row', async () => {
    const harness = createReconcileHarness();
    harness.setActiveProviderTurn(true);
    await harness.service.submit(
      reconcileRequest('capped-fallback-row'),
      'desktop',
    );
    harness.setActiveProviderTurn(false);
    harness.setHasCommittedMessageImpl(() => Promise.resolve(false));
    harness.setDispatchImpl(() =>
      Promise.reject(new Error('temporary failure')),
    );
    harness.service.onTurnTerminal(reconcileTarget(), 'complete');
    await jest.advanceTimersByTimeAsync(0);

    for (const delay of [500, 1_000, 2_000, 4_000, 8_000]) {
      await jest.advanceTimersByTimeAsync(delay);
    }
    expect(harness.dispatched).toEqual(Array(6).fill('capped-fallback-row'));

    reconcileSessionActivity(harness.service);
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual(Array(6).fill('capped-fallback-row'));
  });

  it('does not let reconciliation preempt a scheduled retryAfterMs backoff', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(reconcileRequest('backoff-root'), 'desktop');
    await harness.service.submit(reconcileRequest('backoff-row'), 'desktop');
    harness.setDispatchImpl(() =>
      Promise.reject(new AutoModelRoutingInProgressError(5_000)),
    );
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'backoff-root',
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual(['backoff-root', 'backoff-row']);

    reconcileSessionActivity(harness.service);
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual(['backoff-root', 'backoff-row']);
  });

  it('still reconciles an idle chat with an ordinary queued row and no timer', async () => {
    const harness = createReconcileHarness();
    harness.service.hydratePersistedInput(
      reconcileRequest('idle-queued-row'),
      'idle-queued-row-id',
      'desktop',
      Date.now(),
    );

    reconcileSessionActivity(harness.service);
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual(['idle-queued-row']);
  });

  it('keeps a revived root while an immediate dispatch adopts provider activity', async () => {
    const harness = createReconcileHarness();
    let signalBarrierStart = (): void => undefined;
    const barrierStarted = new Promise<void>((resolve) => {
      signalBarrierStart = resolve;
    });
    let releaseBarrier = (): void => undefined;
    harness.setDrainProviderEventsImpl(
      () =>
        new Promise<void>((resolve) => {
          signalBarrierStart();
          releaseBarrier = resolve;
        }),
    );
    const submission = harness.service.submit(
      reconcileRequest('immediate-adoption-request'),
      'desktop',
    );
    await barrierStarted;

    harness.service.confirmTurnRevived(reconcileTarget(), 'root-b');
    harness.setActiveProviderTurn(true);
    releaseBarrier();
    await submission;
    harness.setDrainProviderEventsImpl(undefined);
    harness.setActiveProviderTurn(false);

    harness.service.onTurnTerminal(reconcileTarget(), 'complete', 'root-a');
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(harness.dispatched).toEqual([]);

    harness.service.onTurnTerminal(reconcileTarget(), 'complete', 'root-b');
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual(['immediate-adoption-request']);
  });

  it('never releases a stale gate while a provider turn is live', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(reconcileRequest('live-root'), 'desktop');
    harness.setActiveProviderTurn(true);
    await harness.service.submit(reconcileRequest('live-follow-up'), 'desktop');

    await jest.advanceTimersByTimeAsync(15_000);

    expect(harness.dispatched).toEqual(['live-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([]);

    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);
    const foregroundDeclines = diagnosticRecords(
      'chat_queue_drain_declined',
    ).filter((record) => record.queueDrainGuard === 'provider-foreground');
    expect(foregroundDeclines).toEqual([
      expect.objectContaining({
        queueGateSource: 'immediate-dispatch',
        queueGateOwnerId: 'live-root',
        queueDrainWakeEvent: 'provider-terminal-or-session-activity',
      }),
    ]);
    expect(foregroundDeclines).toHaveLength(1);
  });

  it('keeps a stale gate while a provider continuation is pending', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('continuation-root'),
      'desktop',
    );
    harness.setPendingProviderContinuation(true);
    await harness.service.submit(
      reconcileRequest('continuation-follow-up'),
      'desktop',
    );

    await jest.advanceTimersByTimeAsync(10_000);

    expect(harness.dispatched).toEqual(['continuation-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([]);
  });

  it('keeps a Codex gate while a user decision is pending', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      { ...reconcileRequest('decision-root'), executionHarness: 'codex' },
      'desktop',
    );
    harness.setPendingUserDecision(true);
    await harness.service.submit(
      reconcileRequest('decision-follow-up'),
      'desktop',
    );

    await jest.advanceTimersByTimeAsync(10_000);

    expect(harness.dispatched).toEqual(['decision-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([]);
  });

  it('does not clear a Codex gate while its turn evidence still holds the turn', async () => {
    const harness = createReconcileHarness();
    const key = buildChatSessionKey('project-1', 'worktree-1', 'chat-1');
    await harness.service.submit(
      { ...reconcileRequest('held-codex-root'), executionHarness: 'codex' },
      'desktop',
    );
    beginCodexSessionTurn(key, 'held-codex-root');
    await harness.service.submit(reconcileRequest('held-follow-up'), 'desktop');

    await jest.advanceTimersByTimeAsync(10_000);

    expect(harness.dispatched).toEqual(['held-codex-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([]);
  });

  it('leaves matching Codex terminal evidence for its durable terminal path', async () => {
    const harness = createReconcileHarness();
    const key = buildChatSessionKey('project-1', 'worktree-1', 'chat-1');
    await harness.service.submit(
      {
        ...reconcileRequest('terminal-evidence-root'),
        executionHarness: 'codex',
      },
      'desktop',
    );
    beginCodexSessionTurn(key, 'terminal-evidence-root');
    recordCodexTurnEnd(key, {
      turnUserMessageId: 'terminal-evidence-root',
      outcome: 'completed',
      endedAtMs: Date.now(),
    });
    finishCodexSessionTurn(key, 'terminal-evidence-root');
    await harness.service.submit(
      reconcileRequest('terminal-evidence-follow-up'),
      'desktop',
    );

    await jest.advanceTimersByTimeAsync(10_000);

    expect(harness.dispatched).toEqual(['terminal-evidence-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(harness.timeline).not.toContain('settle:terminal-evidence-root');
    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([]);

    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'terminal-evidence-root',
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual([
      'terminal-evidence-root',
      'terminal-evidence-follow-up',
    ]);
  });

  it('does not release the Stop reservation gate after the stale interval', async () => {
    const harness = createReconcileHarness();
    harness.setPreparationCancelled(true);
    await harness.service.submit(reconcileRequest('stop-root'), 'desktop');
    await harness.service.submit(reconcileRequest('stop-follow-up'), 'desktop');

    await jest.advanceTimersByTimeAsync(10_000);

    expect(harness.dispatched).toEqual([]);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([]);

    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);
    const reservationDeclines = diagnosticRecords(
      'chat_queue_drain_declined',
    ).filter((record) => record.queueDrainGuard === 'reservation');
    expect(reservationDeclines).toEqual([
      expect.objectContaining({
        queueGateSource: 'stop-preparation',
        queueGateOwnerId: 'stop-root',
        queueDrainWakeEvent: 'reservation-released',
      }),
    ]);
    expect(reservationDeclines[0]?.queueDrainRetryAtMs).toBeLessThanOrEqual(
      Date.now() + 2_000,
    );

    harness.setPreparationCancelled(false);
    harness.service.onTurnTerminal(reconcileTarget(), 'cancelled');
    await jest.advanceTimersByTimeAsync(500);
    expect(harness.dispatched).toEqual(['stop-follow-up']);
  });

  it('does not stale-release a dispatch reservation and drains from its finalizer', async () => {
    const harness = createReconcileHarness();
    let signalDispatchStart = (): void => undefined;
    const dispatchStarted = new Promise<void>((resolve) => {
      signalDispatchStart = resolve;
    });
    let releaseDispatch = (): void => undefined;
    harness.setDispatchImpl(
      () =>
        new Promise<void>((resolve) => {
          signalDispatchStart();
          releaseDispatch = resolve;
        }),
    );
    const rootSubmission = harness.service.submit(
      reconcileRequest('dispatching-root'),
      'desktop',
    );
    await dispatchStarted;
    await harness.service.submit(
      reconcileRequest('dispatching-follow-up'),
      'desktop',
    );

    reconcileSessionActivity(harness.service);

    await jest.advanceTimersByTimeAsync(10_000);

    expect(harness.dispatched).toEqual(['dispatching-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    const dispatchDeclines = diagnosticRecords(
      'chat_queue_drain_declined',
    ).filter((record) => record.queueDrainGuard === 'dispatch-in-flight');
    expect(dispatchDeclines).toHaveLength(1);
    expect(dispatchDeclines[0]).toEqual(
      expect.objectContaining({
        queueDrainWakeEvent: 'dispatch-finalizer',
      }),
    );
    expect(dispatchDeclines[0]?.queueDrainRetryAtMs).toBeLessThanOrEqual(
      Date.now() + 2_000,
    );

    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'dispatching-root',
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual(['dispatching-root']);

    harness.setDispatchImpl(undefined);
    releaseDispatch();
    await rootSubmission;
    await jest.advanceTimersByTimeAsync(1_000);
    expect(harness.dispatched).toEqual([
      'dispatching-root',
      'dispatching-follow-up',
    ]);
  });

  it('keeps a same-id revival alive while stale reconciliation awaits canonical state', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      { ...reconcileRequest('same-root'), executionHarness: 'codex' },
      'desktop',
    );
    let canonicalReadStarted = false;
    let releaseCanonicalRead = (): void => undefined;
    harness.setCanonicalTurnOpenImpl(
      () =>
        new Promise<boolean>((resolve) => {
          canonicalReadStarted = true;
          releaseCanonicalRead = (): void => resolve(true);
        }),
    );
    await harness.service.submit(reconcileRequest('same-follow-up'), 'desktop');

    await jest.advanceTimersByTimeAsync(10_000);

    expect(canonicalReadStarted).toBe(true);
    if (canonicalReadStarted) {
      harness.service.confirmTurnRevived(reconcileTarget(), 'same-root');
      releaseCanonicalRead();
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(harness.dispatched).toEqual(['same-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([]);
  });

  it('keeps a same-id revival during canonical lookup from settling or dispatching', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      { ...reconcileRequest('revived-root'), executionHarness: 'codex' },
      'desktop',
    );
    harness.setActiveProviderTurn(false);
    let startCanonicalRead = (): void => undefined;
    const canonicalReadStarted = new Promise<void>((resolve) => {
      startCanonicalRead = resolve;
    });
    let releaseCanonicalRead = (): void => undefined;
    harness.setCanonicalTurnOpenImpl(
      () =>
        new Promise<boolean>((resolve) => {
          startCanonicalRead();
          releaseCanonicalRead = (): void => resolve(true);
        }),
    );
    const followUpSubmission = harness.service.submit(
      { ...reconcileRequest('codex-follow-up'), executionHarness: 'codex' },
      'desktop',
    );
    await canonicalReadStarted;
    await jest.advanceTimersByTimeAsync(5_000);

    harness.service.confirmTurnRevived(reconcileTarget(), 'revived-root');
    releaseCanonicalRead();
    await followUpSubmission;
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.timeline).not.toContain('settle:revived-root');
    expect(harness.dispatched).toEqual(['revived-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
  });

  it('keeps a same-id revival during the finite backlog barrier from dispatching', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(reconcileRequest('backlog-root'), 'desktop');
    await harness.service.submit(
      reconcileRequest('backlog-follow-up'),
      'desktop',
    );
    let barrierWasStarted = false;
    let signalBarrierStart = (): void => undefined;
    const barrierStarted = new Promise<void>((resolve) => {
      signalBarrierStart = resolve;
    });
    let releaseBarrier = (): void => undefined;
    harness.setDrainProviderEventsImpl(
      () =>
        new Promise<void>((resolve) => {
          barrierWasStarted = true;
          signalBarrierStart();
          releaseBarrier = resolve;
        }),
    );
    await jest.advanceTimersByTimeAsync(5_000);
    expect(barrierWasStarted).toBe(true);
    await barrierStarted;

    harness.service.confirmTurnRevived(reconcileTarget(), 'backlog-root');
    releaseBarrier();
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual(['backlog-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
  });

  it('sends at once when the real terminal lands during the backlog barrier', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('barrier-terminal-root'),
      'desktop',
    );
    let barrierCalls = 0;
    let signalBarrierStart = (): void => undefined;
    const barrierStarted = new Promise<void>((resolve) => {
      signalBarrierStart = resolve;
    });
    let releaseBarrier = (): void => undefined;
    harness.setDrainProviderEventsImpl(() => {
      barrierCalls += 1;
      if (barrierCalls > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        signalBarrierStart();
        releaseBarrier = resolve;
      });
    });
    // The stale check waits on the backlog that still holds the terminal.
    await jest.advanceTimersByTimeAsync(5_000);
    await barrierStarted;

    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'barrier-terminal-root',
    );
    await harness.service.submit(
      reconcileRequest('barrier-terminal-follow-up'),
      'desktop',
    );

    // The gate the check guarded is gone, so the send does not wait for it.
    expect(harness.dispatched).toEqual([
      'barrier-terminal-root',
      'barrier-terminal-follow-up',
    ]);
    releaseBarrier();
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual([
      'barrier-terminal-root',
      'barrier-terminal-follow-up',
    ]);
    expect(harness.timeline).not.toContain('settle:barrier-terminal-root');
  });

  it('reports the host-gate decline when a revived root wins during a drain barrier', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('post-barrier-root'),
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('post-barrier-follow-up'),
      'desktop',
    );
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'post-barrier-root',
    );

    let barrierCalls = 0;
    let signalBarrierStart = (): void => undefined;
    const barrierStarted = new Promise<void>((resolve) => {
      signalBarrierStart = resolve;
    });
    let releaseBarrier = (): void => undefined;
    harness.setDrainProviderEventsImpl(() => {
      barrierCalls += 1;
      if (barrierCalls > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        signalBarrierStart();
        releaseBarrier = resolve;
      });
    });

    await jest.advanceTimersByTimeAsync(0);
    await barrierStarted;
    harness.service.confirmTurnRevived(reconcileTarget(), 'post-barrier-root');
    releaseBarrier();
    await jest.advanceTimersByTimeAsync(1);
    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);

    expect(harness.dispatched).toEqual(['post-barrier-root']);
    const hostGateDeclines = diagnosticRecords(
      'chat_queue_drain_declined',
    ).filter((record) => record.queueDrainGuard === 'host-gate');
    expect(hostGateDeclines).toContainEqual(
      expect.objectContaining({
        queueDrainGuard: 'host-gate',
        queueDrainWakeEvent: 'gate-reconcile',
        queueGateSource: 'revived-root',
        queueGateOwnerId: 'post-barrier-root',
      }),
    );
    expect(hostGateDeclines).toHaveLength(1);
  });

  it('does not dispatch a Codex follow-up until orphaned-turn settlement is durable', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      { ...reconcileRequest('orphaned-codex-root'), executionHarness: 'codex' },
      'desktop',
    );
    harness.setActiveProviderTurn(false);
    harness.setCanonicalTurnOpenImpl(() => Promise.resolve(true));
    let signalSettlementStart = (): void => undefined;
    const settlementStarted = new Promise<void>((resolve) => {
      signalSettlementStart = resolve;
    });
    let releaseSettlement = (): void => undefined;
    harness.setSettleImpl(
      () =>
        new Promise<void>((resolve) => {
          signalSettlementStart();
          releaseSettlement = resolve;
        }),
    );
    const followUpSubmission = harness.service.submit(
      {
        ...reconcileRequest('orphaned-codex-follow-up'),
        executionHarness: 'codex',
      },
      'desktop',
    );
    await settlementStarted;

    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);
    const recoveryDeclines = diagnosticRecords(
      'chat_queue_drain_declined',
    ).filter((record) => record.queueDrainGuard === 'recovery-in-flight');
    expect(recoveryDeclines).toEqual([
      expect.objectContaining({
        queueGateSource: 'immediate-dispatch',
        queueGateOwnerId: 'orphaned-codex-root',
        queueDrainWakeEvent: 'recovery-finalizer',
      }),
    ]);
    expect(recoveryDeclines[0]?.queueDrainRetryAtMs).toBeLessThanOrEqual(
      Date.now() + 2_000,
    );

    await jest.advanceTimersByTimeAsync(5_000);
    expect(
      diagnosticRecords('chat_queue_drain_declined').filter(
        (record) => record.queueDrainGuard === 'recovery-in-flight',
      ),
    ).toHaveLength(1);

    expect(harness.dispatched).toEqual(['orphaned-codex-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    releaseSettlement();
    await followUpSubmission;
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.timeline.indexOf('settle:orphaned-codex-root')).toBeLessThan(
      harness.timeline.indexOf('dispatch:orphaned-codex-follow-up'),
    );
    expect(harness.dispatched).toEqual([
      'orphaned-codex-root',
      'orphaned-codex-follow-up',
    ]);
  });

  it('keeps a same-id revival gated until an in-progress synthetic settlement finishes', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      {
        ...reconcileRequest('settling-revived-root'),
        executionHarness: 'codex',
      },
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('settling-revived-follow-up'),
      'desktop',
    );
    harness.setCanonicalTurnOpenImpl(() => Promise.resolve(true));

    let signalSettlementStart = (): void => undefined;
    const settlementStarted = new Promise<void>((resolve) => {
      signalSettlementStart = resolve;
    });
    let releaseSettlement = (): void => undefined;
    harness.setSettleImpl(
      () =>
        new Promise<void>((resolve) => {
          signalSettlementStart();
          releaseSettlement = resolve;
        }),
    );

    await jest.advanceTimersByTimeAsync(5_000);
    await settlementStarted;
    expect(harness.timeline).toContain('settle:settling-revived-root');
    expect(harness.dispatched).toEqual(['settling-revived-root']);

    harness.service.confirmTurnRevived(
      reconcileTarget(),
      'settling-revived-root',
    );
    releaseSettlement();
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual(['settling-revived-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(diagnosticRecords('chat_queue_gate_stale')).toEqual([]);

    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'settling-revived-root',
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(harness.dispatched).toEqual([
      'settling-revived-root',
      'settling-revived-follow-up',
    ]);
  });

  it('does not let concurrent Codex recovery dispatch through a stale settlement wait', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      {
        ...reconcileRequest('concurrent-recovery-root'),
        executionHarness: 'codex',
      },
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('desktop-follow-up'),
      'desktop',
    );

    let canonicalTurnOpen = false;
    harness.setCanonicalTurnOpenImpl(() => Promise.resolve(canonicalTurnOpen));
    let signalStaleSettlementStart = (): void => undefined;
    const staleSettlementStarted = new Promise<void>((resolve) => {
      signalStaleSettlementStart = resolve;
    });
    let releaseStaleSettlement = (): void => undefined;
    let settlementCalls = 0;
    harness.setSettleImpl(() => {
      settlementCalls += 1;
      if (settlementCalls > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        signalStaleSettlementStart();
        releaseStaleSettlement = resolve;
      });
    });

    // Queue normal desktop work first, then make its old Codex root canonically
    // open. At five seconds stale reconciliation starts synthetic settlement;
    // a concurrent Codex send must not recover and drain through that wait.
    canonicalTurnOpen = true;
    await jest.advanceTimersByTimeAsync(5_000);
    await staleSettlementStarted;
    expect(harness.dispatched).toEqual(['concurrent-recovery-root']);
    expect(settlementCalls).toBe(1);

    await harness.service.submit(
      {
        ...reconcileRequest('concurrent-codex-recovery'),
        executionHarness: 'codex',
      },
      'desktop',
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(settlementCalls).toBe(1);
    expect(harness.dispatched).toEqual(['concurrent-recovery-root']);

    releaseStaleSettlement();
    await jest.advanceTimersByTimeAsync(0);

    expect(
      harness.timeline.indexOf('settle:concurrent-recovery-root'),
    ).toBeLessThan(harness.timeline.indexOf('dispatch:desktop-follow-up'));
    expect(harness.dispatched).toEqual([
      'concurrent-recovery-root',
      'desktop-follow-up',
    ]);
  });

  it('never releases an orphaned Codex gate after synthetic terminal persistence fails', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      {
        ...reconcileRequest('failed-settlement-root'),
        executionHarness: 'codex',
      },
      'desktop',
    );
    harness.setActiveProviderTurn(false);
    harness.setCanonicalTurnOpenImpl(() => Promise.resolve(true));
    harness.setSettleImpl(() =>
      Promise.reject(new Error('synthetic terminal write failed')),
    );
    await harness.service.submit(
      {
        ...reconcileRequest('failed-settlement-follow-up'),
        executionHarness: 'codex',
      },
      'desktop',
    );

    await jest.advanceTimersByTimeAsync(10_000);

    expect(harness.dispatched).toEqual(['failed-settlement-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    expect(
      harness.timeline.filter(
        (item) => item === 'settle:failed-settlement-root',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('retries a failed provider-event barrier within two seconds and deduplicates its decline', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(reconcileRequest('barrier-root'), 'desktop');
    await harness.service.submit(
      reconcileRequest('barrier-follow-up'),
      'desktop',
    );
    let drainCalls = 0;
    harness.setDrainProviderEventsImpl(() => {
      drainCalls += 1;
      return drainCalls === 1
        ? Promise.reject(new Error('provider-event barrier failed'))
        : Promise.resolve();
    });
    const retryWindowStartedAt = Date.now();
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'barrier-root',
    );
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(2_000);

    expect(drainCalls).toBeGreaterThanOrEqual(2);
    expect(harness.dispatched).toEqual(['barrier-root', 'barrier-follow-up']);
    const declines = diagnosticRecords('chat_queue_drain_declined').filter(
      (record) => record.queueDrainGuard === 'backlog-wait-failed',
    );
    expect(declines).toHaveLength(1);
    expect(declines[0]?.queueDrainRetryAtMs).toBeGreaterThanOrEqual(
      retryWindowStartedAt,
    );
    expect(declines[0]?.queueDrainRetryAtMs).toBeLessThanOrEqual(
      retryWindowStartedAt + 2_000,
    );
  });

  it('names authentication resume when an auth pause prevents a failed-barrier retry', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('auth-barrier-root'),
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('auth-barrier-follow-up'),
      'desktop',
    );
    harness.setDrainProviderEventsImpl(async () => {
      await harness.service.pauseForAuthentication(
        reconcileTarget(),
        'barrier-auth',
      );
      throw new Error('barrier failed while authentication paused');
    });
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'auth-barrier-root',
    );
    await jest.advanceTimersByTimeAsync(0);

    const declines = diagnosticRecords('chat_queue_drain_declined').filter(
      (record) => record.queueDrainGuard === 'backlog-wait-failed',
    );
    expect(declines).toHaveLength(1);
    expect(declines[0]?.queueDrainWakeEvent).toBe('authentication-resumed');
    expect(harness.dispatched).toEqual(['auth-barrier-root']);

    harness.setDrainProviderEventsImpl(undefined);
    harness.service.releaseAuthenticationPause(
      reconcileTarget(),
      'barrier-auth',
    );
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.dispatched).toEqual([
      'auth-barrier-root',
      'auth-barrier-follow-up',
    ]);
  });

  it('retries a failed stale-reconcile barrier within two seconds before releasing its gate', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('stale-barrier-root'),
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('stale-barrier-follow-up'),
      'desktop',
    );
    let drainCalls = 0;
    harness.setDrainProviderEventsImpl(() => {
      drainCalls += 1;
      return drainCalls === 1
        ? Promise.reject(new Error('stale provider-event barrier failed'))
        : Promise.resolve();
    });
    await jest.advanceTimersByTimeAsync(5_000);
    const retryWindowStartedAt = Date.now();

    expect(harness.dispatched).toEqual(['stale-barrier-root']);
    expect(harness.service.isTurnActive(reconcileTarget())).toBe(true);
    const declines = diagnosticRecords('chat_queue_drain_declined').filter(
      (record) => record.queueDrainGuard === 'backlog-wait-failed',
    );
    expect(declines).toHaveLength(1);
    expect(declines[0]?.queueDrainRetryAtMs).toBeGreaterThanOrEqual(
      retryWindowStartedAt,
    );
    expect(declines[0]?.queueDrainRetryAtMs).toBeLessThanOrEqual(
      retryWindowStartedAt + 2_000,
    );

    await jest.advanceTimersByTimeAsync(1_001);

    expect(drainCalls).toBeGreaterThanOrEqual(2);
    expect(diagnosticRecords('chat_queue_gate_stale')).toContainEqual(
      expect.objectContaining({
        queueGateSource: 'immediate-dispatch',
        queueGateOwnerId: 'stale-barrier-root',
      }),
    );
    expect(harness.dispatched).toEqual([
      'stale-barrier-root',
      'stale-barrier-follow-up',
    ]);
    expect(harness.timeline.indexOf('settle:stale-barrier-root')).toBeLessThan(
      harness.timeline.indexOf('dispatch:stale-barrier-follow-up'),
    );
    expect(
      diagnosticRecords('chat_queue_drain_declined').filter(
        (record) => record.queueDrainGuard === 'backlog-wait-failed',
      ),
    ).toHaveLength(1);
  });

  it('keeps an auth-paused queue until the matching authentication attempt resumes', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(
      reconcileRequest('auth-pause-root'),
      'desktop',
    );
    await harness.service.submit(
      reconcileRequest('auth-pause-follow-up'),
      'desktop',
    );
    await harness.service.pauseForAuthentication(
      reconcileTarget(),
      'auth-attempt-1',
    );
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'auth-pause-root',
    );
    await jest.advanceTimersByTimeAsync(0);
    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);

    expect(harness.dispatched).toEqual(['auth-pause-root']);
    const authDeclines = diagnosticRecords('chat_queue_drain_declined').filter(
      (record) => record.queueDrainGuard === 'auth-pause',
    );
    expect(authDeclines).toEqual([
      expect.objectContaining({
        queueDrainWakeEvent: 'authentication-resumed',
      }),
    ]);

    harness.service.releaseAuthenticationPause(
      reconcileTarget(),
      'wrong-attempt',
    );
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.dispatched).toEqual(['auth-pause-root']);

    harness.service.releaseAuthenticationPause(
      reconcileTarget(),
      'auth-attempt-1',
    );
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.dispatched).toEqual([
      'auth-pause-root',
      'auth-pause-follow-up',
    ]);
  });

  it('reports an edit-locked head until unlocking it wakes the FIFO drain', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(reconcileRequest('edit-lock-root'), 'desktop');
    await harness.service.submit(
      reconcileRequest('edit-lock-follow-up'),
      'desktop',
    );
    const queueEntryId = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    )[0]?.queue[0]?.id;
    if (!queueEntryId) throw new Error('Expected a queued follow-up row');

    await harness.service.setEditLock(reconcileTarget(), queueEntryId, true);
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'edit-lock-root',
    );
    await jest.advanceTimersByTimeAsync(1);
    reconcileSessionActivity(harness.service);
    reconcileSessionActivity(harness.service);
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual(['edit-lock-root']);
    const editDeclines = diagnosticRecords('chat_queue_drain_declined').filter(
      (record) => record.queueDrainGuard === 'edit-locked-head',
    );
    expect(editDeclines).toEqual([
      expect.objectContaining({
        queueDrainWakeEvent: 'head-edit-unlocked',
      }),
    ]);

    await harness.service.setEditLock(reconcileTarget(), queueEntryId, false);
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.dispatched).toEqual([
      'edit-lock-root',
      'edit-lock-follow-up',
    ]);
  });

  it('keeps a visible watcher ahead of a hidden delegation across a held barrier and slow durable dequeue', async () => {
    const harness = createReconcileHarness();
    await harness.service.submit(reconcileRequest('monkey-root'), 'desktop');
    await harness.service.submit(
      {
        ...reconcileRequest('visible-watcher'),
        text: 'Visible watcher',
        watcherFired: { kind: 'Build completed' },
      },
      'desktop',
    );
    await harness.service.submit(
      {
        ...reconcileRequest('hidden-delegation'),
        text: 'secret internal payload',
        managedDelegationDeliveryId: 'hidden-delegation',
        internalRow: {
          kind: 'delegation-request',
          delegationId: 'delegation-hidden',
          displayLine: 'Delegate request',
        },
      },
      'desktop',
    );
    expect(
      harness.service
        .getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.queue.map((row) => row.text),
    ).toEqual(['Visible watcher']);
    expect(
      harness.service.getWorktreeSnapshots('project-1', 'worktree-1')[0]
        ?.waitingDelegationIds,
    ).toEqual(['delegation-hidden']);

    let signalBarrierStart = (): void => undefined;
    const barrierStarted = new Promise<void>((resolve) => {
      signalBarrierStart = resolve;
    });
    let barrierWasStarted = false;
    let releaseBarrier = (): void => undefined;
    let barrierCalls = 0;
    harness.setDrainProviderEventsImpl(() => {
      barrierCalls += 1;
      if (barrierCalls > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        barrierWasStarted = true;
        signalBarrierStart();
        releaseBarrier = resolve;
      });
    });
    let signalPersistenceStart = (): void => undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      signalPersistenceStart = resolve;
    });
    let releasePersistence = (): void => undefined;
    let dequeuePersistenceHeld = false;
    harness.setPersistRuntimeImpl(
      (
        _target,
        _queuedMessageIds,
        turnActive,
        _mutation,
        _queuedMessages,
        _activeTurnUserMessageId,
        inFlight,
      ) => {
        if (
          dequeuePersistenceHeld ||
          !turnActive ||
          inFlight?.request.userMessageId !== 'visible-watcher'
        )
          return Promise.resolve();
        dequeuePersistenceHeld = true;
        return new Promise<void>((resolve) => {
          signalPersistenceStart();
          releasePersistence = resolve;
        });
      },
    );
    await jest.advanceTimersByTimeAsync(5_000);
    expect(barrierWasStarted).toBe(true);
    await barrierStarted;
    releaseBarrier();
    const barrierResolvedAt = Date.now();
    await jest.advanceTimersByTimeAsync(1);
    await persistenceStarted;

    await jest.advanceTimersByTimeAsync(750);
    expect(harness.dispatched).toEqual(['monkey-root']);
    releasePersistence();
    await jest.advanceTimersByTimeAsync(1);

    expect(harness.dispatched).toEqual(['monkey-root', 'visible-watcher']);
    expect(Date.now() - barrierResolvedAt).toBeLessThanOrEqual(2_000);
    const afterWatcher = harness.service.getWorktreeSnapshots(
      'project-1',
      'worktree-1',
    )[0];
    expect(afterWatcher?.queue).toEqual([]);
    expect(afterWatcher?.waitingDelegationIds).toEqual(['delegation-hidden']);
    expect(JSON.stringify(harness.broadcasts)).not.toContain(
      'secret internal payload',
    );

    harness.setPersistRuntimeImpl(undefined);
    harness.setDrainProviderEventsImpl(undefined);
    harness.service.onTurnTerminal(
      reconcileTarget(),
      'complete',
      'visible-watcher',
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(harness.dispatched).toEqual([
      'monkey-root',
      'visible-watcher',
      'hidden-delegation',
    ]);
  });
});
