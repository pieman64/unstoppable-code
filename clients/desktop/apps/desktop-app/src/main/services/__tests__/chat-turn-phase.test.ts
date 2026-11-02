import {
  initialChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import {
  canRecoverCodexTurn,
  evaluateTurnAdmission,
  createTurnOwnershipRecord,
  bindTurnOwnershipRecord,
  matchesTurnOwnershipRecord,
  type TurnAdmissionInputs,
  readChatTurnPhase,
  type CodexTurnRecoveryInputs,
} from '../chat-turn-phase';
import type { AgentSession } from '../../agents/types';
import {
  destroyAllSessions,
  getChatSessionLiveness,
  markTurnActive,
  markTurnIdle,
  noteSessionMessageQueued,
  recordSessionEvent,
  registerSession,
} from '../../agents/session-manager';

const mockRecordSessionDiagnostic = jest.fn();
const mockWakeLockAcquire = jest.fn();
const mockWakeLockRelease = jest.fn();

jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: jest.fn(),
    finalizeObservedTask: jest.fn(),
    observeChatEvent: jest.fn(),
    completeChatTurn: jest.fn(),
    startChatTurn: jest.fn(),
    interruptMatchingEntries: jest.fn(),
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  })),
}));

jest.mock('../../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(() => ({
    acquire: mockWakeLockAcquire,
    release: mockWakeLockRelease,
  })),
}));

jest.mock('../../lib/bg-output-poller', () => ({
  flushAndStopOutputPollingForSession: jest.fn().mockResolvedValue(undefined),
  stopAllOutputPolling: jest.fn(),
}));

jest.mock('../../lib/session-ended-background-tasks', () => ({
  emitSessionEndedBackgroundTaskNotification: jest.fn(),
}));

jest.mock('../../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: jest.fn(() => ({
    flushWorktreeNow: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../plugins/plugin-cleanup', () => ({
  cleanupChatSkillPluginDir: jest.fn(),
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));

jest.mock('../../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
}));

function makeSession(
  options: {
    pendingSteeringInput?: boolean;
    disposed?: boolean;
  } = {},
): AgentSession {
  return {
    sendMessage: jest.fn(),
    hasPendingSteeringInput: () => options.pendingSteeringInput ?? false,
    isDisposed: () => options.disposed ?? false,
    cancel: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    setPlanMode: jest.fn().mockResolvedValue(undefined),
    setApprovalMode: jest.fn().mockResolvedValue(undefined),
    setThinkingLevel: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(async () => {
  await destroyAllSessions();
  jest.clearAllMocks();
});

describe('readChatTurnPhase', () => {
  it('projects an active provider turn as foreground work', () => {
    expect(
      readChatTurnPhase({
        hasActiveProviderTurn: true,
        hasPendingProviderContinuation: false,
        hasBackgroundWork: false,
        hostGateArmed: false,
      }),
    ).toEqual({ turnPhase: 'foreground', hasForegroundProviderWork: true });
  });

  it('projects a paused provider continuation as foreground work', () => {
    expect(
      readChatTurnPhase({
        hasActiveProviderTurn: false,
        hasPendingProviderContinuation: true,
        hasBackgroundWork: false,
        hostGateArmed: false,
      }),
    ).toEqual({ turnPhase: 'foreground', hasForegroundProviderWork: true });
  });

  it('projects background work only when there is no foreground provider work', () => {
    expect(
      readChatTurnPhase({
        hasActiveProviderTurn: false,
        hasPendingProviderContinuation: false,
        hasBackgroundWork: true,
        hostGateArmed: false,
      }),
    ).toEqual({ turnPhase: 'background', hasForegroundProviderWork: false });
  });

  it('projects no work as idle when provider truth and reservations are absent', () => {
    expect(
      readChatTurnPhase({
        hasActiveProviderTurn: false,
        hasPendingProviderContinuation: false,
        hasBackgroundWork: false,
        hostGateArmed: false,
      }),
    ).toEqual({ turnPhase: 'idle', hasForegroundProviderWork: false });
  });

  it('projects an armed host gate as foreground even when the provider reports idle', () => {
    // The gate stays armed until its turn's terminal: the provider can report
    // idle before it marks a prompt active, while it waits on the user, and
    // before the result is committed.
    expect(
      readChatTurnPhase({
        hasActiveProviderTurn: false,
        hasPendingProviderContinuation: false,
        hasBackgroundWork: true,
        hostGateArmed: true,
      }),
    ).toEqual({ turnPhase: 'foreground', hasForegroundProviderWork: false });
  });

  it.each(['dispatch', 'stop'] as const)(
    'projects an other-owner %s reservation as foreground without provider work',
    (kind) => {
      const operationOwner = Symbol('current operation');
      const reservationOwner = Symbol('reservation owner');

      expect(
        readChatTurnPhase(
          {
            hasActiveProviderTurn: false,
            hasPendingProviderContinuation: false,
            hasBackgroundWork: false,
            hostGateArmed: false,
            reservation: { kind, owner: reservationOwner },
          },
          operationOwner,
        ),
      ).toEqual({ turnPhase: 'foreground', hasForegroundProviderWork: false });
    },
  );

  it('ignores the caller operation’s reservation and retains background priority', () => {
    const operationOwner = Symbol('current operation');

    expect(
      readChatTurnPhase(
        {
          hasActiveProviderTurn: false,
          hasPendingProviderContinuation: false,
          hasBackgroundWork: true,
          hostGateArmed: false,
          reservation: { kind: 'dispatch', owner: operationOwner },
        },
        operationOwner,
      ),
    ).toEqual({ turnPhase: 'background', hasForegroundProviderWork: false });
  });

  it('does not let an own reservation hide provider cancellation or continuation truth', () => {
    const operationOwner = Symbol('current operation');
    const reservation = { kind: 'dispatch' as const, owner: operationOwner };

    expect(
      readChatTurnPhase(
        {
          hasActiveProviderTurn: true,
          hasPendingProviderContinuation: false,
          hasBackgroundWork: false,
          hostGateArmed: false,
          reservation,
        },
        operationOwner,
      ),
    ).toEqual({ turnPhase: 'foreground', hasForegroundProviderWork: true });
    expect(
      readChatTurnPhase(
        {
          hasActiveProviderTurn: false,
          hasPendingProviderContinuation: true,
          hasBackgroundWork: false,
          hostGateArmed: false,
          reservation,
        },
        operationOwner,
      ),
    ).toEqual({ turnPhase: 'foreground', hasForegroundProviderWork: true });
    expect(
      readChatTurnPhase(
        {
          hasActiveProviderTurn: false,
          hasPendingProviderContinuation: false,
          hasBackgroundWork: false,
          hostGateArmed: false,
          reservation,
        },
        operationOwner,
      ),
    ).toEqual({ turnPhase: 'idle', hasForegroundProviderWork: false });
  });

  it('does not infer a foreground reservation from an absent reservation', () => {
    expect(
      readChatTurnPhase({
        hasActiveProviderTurn: false,
        hasPendingProviderContinuation: false,
        hasBackgroundWork: false,
        hostGateArmed: false,
      }),
    ).toEqual({ turnPhase: 'idle', hasForegroundProviderWork: false });
  });
});

describe('canRecoverCodexTurn', () => {
  const eligible: CodexTurnRecoveryInputs = {
    hostGateArmed: true,
    turnUserMessageId: 'turn-1',
    hasActiveProviderTurn: false,
    hasPendingProviderContinuation: false,
    hasPendingUserDecision: false,
    dispatchInFlight: false,
    hasRecoveryInFlight: false,
    hasReservation: false,
    holdsTurn: false,
    hasMatchingTerminal: false,
    canonicalTurnOpen: true,
  };

  it('allows recovery only for an idle, owned gate with no matching terminal evidence', () => {
    expect(canRecoverCodexTurn(eligible)).toBe(true);
    expect(canRecoverCodexTurn({ ...eligible, hostGateArmed: false })).toBe(
      false,
    );
    expect(
      canRecoverCodexTurn({ ...eligible, turnUserMessageId: undefined }),
    ).toBe(false);
    expect(
      canRecoverCodexTurn({ ...eligible, hasActiveProviderTurn: true }),
    ).toBe(false);
    expect(
      canRecoverCodexTurn({
        ...eligible,
        hasPendingProviderContinuation: true,
      }),
    ).toBe(false);
    expect(
      canRecoverCodexTurn({ ...eligible, hasPendingUserDecision: true }),
    ).toBe(false);
    expect(canRecoverCodexTurn({ ...eligible, dispatchInFlight: true })).toBe(
      false,
    );
    expect(
      canRecoverCodexTurn({ ...eligible, hasRecoveryInFlight: true }),
    ).toBe(false);
    expect(canRecoverCodexTurn({ ...eligible, hasReservation: true })).toBe(
      false,
    );
    expect(canRecoverCodexTurn({ ...eligible, holdsTurn: true })).toBe(false);
    expect(
      canRecoverCodexTurn({ ...eligible, hasMatchingTerminal: true }),
    ).toBe(false);
    expect(canRecoverCodexTurn({ ...eligible, canonicalTurnOpen: false })).toBe(
      false,
    );
  });
});

describe('getChatSessionLiveness', () => {
  it('returns idle liveness when no provider session exists', () => {
    expect(getChatSessionLiveness('project', 'worktree', 'missing')).toEqual({
      foreground: false,
      background: false,
    });
  });

  it('includes active turns, queued messages, and pending steering input as foreground', () => {
    const activeTurnKey = 'project/worktree/active-turn';
    const queuedMessageKey = 'project/worktree/queued-message';
    const pendingSteeringKey = 'project/worktree/pending-steering';
    registerSession(
      activeTurnKey,
      makeSession(),
      new AbortController(),
      'claude',
    );
    registerSession(
      queuedMessageKey,
      makeSession(),
      new AbortController(),
      'claude',
    );
    registerSession(
      pendingSteeringKey,
      makeSession({ pendingSteeringInput: true }),
      new AbortController(),
      'claude',
    );
    markTurnActive(activeTurnKey);
    noteSessionMessageQueued(queuedMessageKey, 1);

    expect(
      getChatSessionLiveness('project', 'worktree', 'active-turn'),
    ).toEqual({
      foreground: true,
      background: false,
    });
    expect(
      getChatSessionLiveness('project', 'worktree', 'queued-message'),
    ).toEqual({ foreground: true, background: false });
    expect(
      getChatSessionLiveness('project', 'worktree', 'pending-steering'),
    ).toEqual({ foreground: true, background: false });
  });

  it('includes existing busy background work without treating it as foreground', () => {
    const key = 'project/worktree/background';
    registerSession(key, makeSession(), new AbortController(), 'claude');
    recordSessionEvent(key, {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-use',
            name: 'Bash',
            input: { command: 'sleep 10', run_in_background: true },
          },
        ],
      },
    });
    recordSessionEvent(key, {
      type: 'system',
      subtype: 'task_started',
      task_id: 'task',
      tool_use_id: 'tool-use',
    });
    markTurnIdle(key);

    expect(getChatSessionLiveness('project', 'worktree', 'background')).toEqual(
      {
        foreground: false,
        background: true,
      },
    );
  });

  it('excludes disposed provider sessions from both liveness flags', () => {
    const key = 'project/worktree/disposed';
    registerSession(
      key,
      makeSession({ disposed: true }),
      new AbortController(),
      'claude',
    );
    markTurnActive(key);

    expect(getChatSessionLiveness('project', 'worktree', 'disposed')).toEqual({
      foreground: false,
      background: false,
    });
  });
});

describe('evaluateTurnAdmission', () => {
  const idle = serializeChatTurnState(initialChatTurnState());
  const known: TurnAdmissionInputs = {
    knowledge: 'known',
    receipt: { generation: 4, state: idle },
    committed: { generation: 3, state: idle },
    unacknowledgedLifecycle: [],
    dispatchOwners: [],
    stopOwners: [],
  };
  const current = {
    id: 'T',
    origin: 'user' as const,
    startedAtMs: 1,
    pauses: [],
  };

  it.each(['unknown', 'loading'] as const)('waits while %s', (knowledge) => {
    expect(evaluateTurnAdmission({ ...known, knowledge })).toEqual({
      kind: 'wait',
      reason: knowledge,
    });
  });
  it.each(['receipt', 'committed'] as const)(
    'waits for a missing %s view even if marked known',
    (view) => {
      expect(evaluateTurnAdmission({ ...known, [view]: undefined })).toEqual({
        kind: 'wait',
        reason: 'unknown',
      });
    },
  );
  it('allows background alone and returns both generations', () => {
    const background = {
      ...idle,
      phase: 'background' as const,
      background: {
        native: [{ id: 'server' }],
        managed: { live: 1, queued: 1 },
      },
    };
    expect(
      evaluateTurnAdmission({
        ...known,
        receipt: { generation: 4, state: background },
      }),
    ).toEqual({ kind: 'allow', receiptGeneration: 4, committedGeneration: 3 });
  });
  it.each(['receipt', 'committed'] as const)(
    'blocks %s current including paused requires_action',
    (view) => {
      const verdict = evaluateTurnAdmission({
        ...known,
        [view]: {
          generation: 5,
          state: {
            ...idle,
            decisionPending: true,
            current: {
              ...current,
              pauses: [
                { ownerKind: 'approval', ownerId: 'approval', startedAtMs: 2 },
              ],
            },
          },
        },
      });
      expect(verdict).toEqual({
        kind: 'blocked',
        blockers: [{ kind: `${view}-foreground`, turnId: 'T' }],
      });
    },
  );
  it('retains coalesced start/end obligations even with no current', () => {
    const unacknowledgedLifecycle = [
      {
        turnId: 'T',
        generation: 4,
        transition: 'start' as const,
        inputIds: ['A', 'B'],
      },
      {
        turnId: 'T',
        generation: 5,
        transition: 'end' as const,
        inputIds: ['A', 'B'],
      },
    ];
    expect(
      evaluateTurnAdmission({ ...known, unacknowledgedLifecycle }),
    ).toEqual({
      kind: 'blocked',
      blockers: unacknowledgedLifecycle.map((ownership) => ({
        kind: 'unacknowledged-lifecycle',
        ownership,
      })),
    });
  });
  it.each(['dispatch', 'stop'] as const)(
    'exempts only the caller %s reservation',
    (kind) => {
      const owner = createTurnOwnershipRecord({
        kind,
        token: Symbol('owner'),
        operationEpoch: 2,
      });
      const owners =
        kind === 'dispatch'
          ? { dispatchOwners: [owner] }
          : { stopOwners: [owner] };
      expect(evaluateTurnAdmission({ ...known, ...owners })).toEqual({
        kind: 'blocked',
        blockers: [{ kind, owner }],
      });
      expect(
        evaluateTurnAdmission({ ...known, ...owners, callerToken: owner.token })
          .kind,
      ).toBe('allow');
      expect(
        evaluateTurnAdmission({
          ...known,
          ...owners,
          callerToken: Symbol('foreign'),
        }).kind,
      ).toBe('blocked');
      expect(
        evaluateTurnAdmission({
          ...known,
          ...owners,
          callerToken: owner.token,
          receipt: { generation: 6, state: { ...idle, current } },
        }).kind,
      ).toBe('blocked');
    },
  );
  it('binds host records without changing token/epoch and matches both for release', () => {
    const owner = createTurnOwnershipRecord({
      kind: 'dispatch',
      token: Symbol('D'),
      operationEpoch: 7,
      userMessageId: 'A',
    });
    expect(owner.reason).toBe('awaiting-start');
    const bound = bindTurnOwnershipRecord(owner, 'T');
    expect(bound).toEqual({ ...owner, turnId: 'T', reason: 'awaiting-commit' });
    expect(owner.turnId).toBeUndefined();
    expect(matchesTurnOwnershipRecord(bound, owner.token, 7)).toBe(true);
    expect(matchesTurnOwnershipRecord(bound, Symbol('D'), 7)).toBe(false);
    expect(matchesTurnOwnershipRecord(bound, owner.token, 6)).toBe(false);
    expect(
      createTurnOwnershipRecord({
        kind: 'stop',
        token: Symbol('S'),
        operationEpoch: 8,
      }).reason,
    ).toBe('awaiting-commit');
  });
});
