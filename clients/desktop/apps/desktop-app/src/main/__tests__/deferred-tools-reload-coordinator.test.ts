import { randomUUID } from 'node:crypto';
import type { ChatTurnLifecycleEvent } from '@canopy/protocol/canopy-core';
import {
  armTurnLifecycleContinuation,
  getTurnLifecycleProducer,
  releaseTurnLifecycleProducer,
  setTurnLifecycleSink,
} from '../agents/provider-turn-lifecycle';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import type {
  DeferredToolsReloadEvent,
  DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';

function scope(): DeferredToolsReloadScopeKey {
  return {
    projectId: `project-${randomUUID()}`,
    worktreeId: `worktree-${randomUUID()}`,
    chatId: `chat-${randomUUID()}`,
  };
}

const additions = {
  skillRefs: [{ sourceId: 'source', skillName: 'skill-one' }],
  pluginRefs: [],
  mcpServerRefs: [],
};

const enabledResources = [
  {
    ref: 'skill:source:skill-one',
    kind: 'skill' as const,
    name: 'skill-one',
    sourceLabel: 'source',
  },
];

describe('deferredToolsReloadCoordinator', () => {
  let restoreRevalidator: (() => void) | undefined;
  let restoreIntentTimeout: (() => void) | undefined;

  beforeEach(() => {
    restoreRevalidator =
      deferredToolsReloadCoordinator.setCatalogRevalidatorForTests(() =>
        Promise.resolve(undefined),
      );
  });

  afterEach(() => {
    deferredToolsReloadCoordinator.resetForTests();
    restoreIntentTimeout?.();
    restoreIntentTimeout = undefined;
    restoreRevalidator?.();
    restoreRevalidator = undefined;
  });

  it('binds an OpenCode receipt to the active scope and provider, and delivers once', () => {
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) =>
      events.push(event),
    );
    const ownScope = scope();
    const otherScope = scope();
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: ownScope,
      toolCallId: '42',
      providerType: 'opencode',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) throw new Error('Expected accepted intent');
    try {
      expect(
        deferredToolsReloadCoordinator.markOpenCodeResultDelivered(
          otherScope,
          intent.requestId,
        ),
      ).toBe(false);
      expect(
        deferredToolsReloadCoordinator.markOpenCodeResultDelivered(
          ownScope,
          'stale',
        ),
      ).toBe(false);
      expect(events).toEqual([]);
      expect(
        deferredToolsReloadCoordinator.markOpenCodeResultDelivered(
          ownScope,
          intent.requestId,
        ),
      ).toBe(true);
      expect(
        deferredToolsReloadCoordinator.markOpenCodeResultDelivered(
          ownScope,
          intent.requestId,
        ),
      ).toBe(false);
      expect(events).toHaveLength(1);
      expect(events[0]?.toolCallId).toBe('42');
      deferredToolsReloadCoordinator.cancelActiveReload(ownScope);
      expect(
        deferredToolsReloadCoordinator.markOpenCodeResultDelivered(
          ownScope,
          intent.requestId,
        ),
      ).toBe(false);
      const claude = deferredToolsReloadCoordinator.createIntent({
        scope: ownScope,
        toolCallId: '42',
        providerType: 'claude',
        additions,
        enabledResources,
      });
      if (!claude.accepted) throw new Error('Expected accepted Claude intent');
      expect(
        deferredToolsReloadCoordinator.markOpenCodeResultDelivered(
          ownScope,
          claude.requestId,
        ),
      ).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('does not emit until the provider tool result is delivered', () => {
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;

    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'codex',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });

    expect(intent.accepted).toBe(true);
    expect(events).toEqual([]);

    deferredToolsReloadCoordinator.markToolResultDelivered(
      testScope,
      toolCallId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      scope: testScope,
      toolCallId,
      lifecycle: { kind: 'state', state: 'result_pending' },
      enabledResources,
    });
    unsubscribe();
  });

  it('suppresses retiring-provider terminals only before resume starts', async () => {
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;
    expect(
      deferredToolsReloadCoordinator.shouldSuppressProviderTerminal(testScope),
    ).toBe(true);

    let releaseResume: (() => void) | undefined;
    deferredToolsReloadCoordinator.registerResumeHandler(
      testScope,
      () =>
        new Promise<void>((resolve) => {
          releaseResume = resolve;
        }),
    );
    await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });
    const finishPromise = deferredToolsReloadCoordinator.finish({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      userMessageId: 'message-1',
      continuationText: 'continue',
      resume: { providerType: 'claude' },
    });

    expect(
      deferredToolsReloadCoordinator.shouldSuppressProviderTerminal(testScope),
    ).toBe(false);
    releaseResume?.();
    await finishPromise;
  });

  it('restarts the session itself only from begin until resume, so that end is not a cancellation', async () => {
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    if (!intent.accepted) throw new Error('Expected accepted intent');
    const events: ChatTurnLifecycleEvent[] = [];
    setTurnLifecycleSink((event) => events.push(event));
    const producer = getTurnLifecycleProducer('claude', testScope);
    const end = (turnId: string): void =>
      producer.turnEnded({
        turnId,
        origin: 'user',
        binding: 'bound',
        submissionIds: [],
        userMessageIds: ['message-1'],
        providerUserMessageUuids: [],
        endedAtMs: 1,
        outcome: 'cancelled',
        terminalReason: 'Session aborted',
        source: 'abort-fallback',
      });
    try {
      expect(
        deferredToolsReloadCoordinator.isRestartingSession(testScope),
      ).toBe(false);
      end('before-begin');
      await deferredToolsReloadCoordinator.begin({
        scope: testScope,
        requestId: intent.requestId,
        toolCallId,
        additions,
        enabledResources,
      });
      expect(
        deferredToolsReloadCoordinator.isRestartingSession(testScope),
      ).toBe(true);
      end('restarted');
      deferredToolsReloadCoordinator.registerResumeHandler(testScope, () =>
        Promise.resolve(),
      );
      await deferredToolsReloadCoordinator.finish({
        scope: testScope,
        requestId: intent.requestId,
        toolCallId,
        userMessageId: 'message-1',
        continuationText: 'continue',
        resume: { providerType: 'claude' },
      });
      expect(
        deferredToolsReloadCoordinator.isRestartingSession(testScope),
      ).toBe(false);
      producer.turnStarted({
        turnId: 'continuation',
        origin: 'autonomous',
        binding: 'pending',
        submissionIds: [],
        userMessageIds: [],
        providerUserMessageUuids: [],
        phase: 'start',
        startedAtMs: 1,
      });
      expect(events.at(-1)).toMatchObject({
        type: 'TurnStarted',
        spawnedBy: { toolUseId: toolCallId, toolsLoaded: true },
      });
      end('after-resume');
      expect(
        events.flatMap((event) =>
          event.type === 'TurnEnded' ? [[event.turnId, event.outcome]] : [],
        ),
      ).toEqual([
        ['before-begin', 'cancelled'],
        ['restarted', 'completed'],
        ['after-resume', 'cancelled'],
      ]);
    } finally {
      setTurnLifecycleSink(null);
      armTurnLifecycleContinuation(testScope, null);
      releaseTurnLifecycleProducer('claude', testScope);
    }
  });

  it('cancels an active reload by chat scope before the renderer handshake begins', () => {
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);

    expect(
      deferredToolsReloadCoordinator.cancelActiveReload(
        testScope,
        'The user stopped the chat.',
      ),
    ).toBe(true);

    expect(deferredToolsReloadCoordinator.hasActiveReload(testScope)).toBe(
      false,
    );
    expect(events[events.length - 1]).toMatchObject({
      scope: testScope,
      lifecycle: { kind: 'outcome', outcome: 'cancelled' },
      error: { message: 'The user stopped the chat.' },
    });
    unsubscribe();
  });

  it('removes a resume handler when its logical chat is closed', async () => {
    const testScope = scope();
    const resume = jest.fn(() => Promise.resolve());
    deferredToolsReloadCoordinator.registerResumeHandler(testScope, resume);
    deferredToolsReloadCoordinator.unregisterResumeHandler(testScope);
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;
    await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });

    const finishAck = await deferredToolsReloadCoordinator.finish({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      userMessageId: 'message-1',
      continuationText: 'continue',
      resume: { providerType: 'claude' },
    });

    expect(finishAck).toMatchObject({
      accepted: false,
      lifecycle: { kind: 'outcome', outcome: 'resume_failed' },
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it('delivers only the intent in the matching scope when tool-call ids collide', () => {
    const firstScope = scope();
    const secondScope = scope();
    const sharedToolCallId = '1';
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });

    deferredToolsReloadCoordinator.createIntent({
      scope: firstScope,
      toolCallId: sharedToolCallId,
      additions,
      enabledResources,
    });
    deferredToolsReloadCoordinator.createIntent({
      scope: secondScope,
      toolCallId: sharedToolCallId,
      additions,
      enabledResources,
    });

    deferredToolsReloadCoordinator.markToolResultDelivered(
      secondScope,
      sharedToolCallId,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.scope).toEqual(secondScope);
    unsubscribe();
  });

  it('serializes concurrent reload intents for the same chat', () => {
    const testScope = scope();
    const first = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId: `tool-${randomUUID()}`,
      additions,
      enabledResources,
    });
    const second = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId: `tool-${randomUUID()}`,
      additions,
      enabledResources,
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
  });

  it('expires an abandoned intent and releases the chat for another reload', async () => {
    restoreIntentTimeout =
      deferredToolsReloadCoordinator.setIntentTimeoutMsForTests(1);
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const testScope = scope();
    const first = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId: `tool-${randomUUID()}`,
      additions,
      enabledResources,
    });
    expect(first.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const timeoutEvent = events[events.length - 1];
    expect(timeoutEvent).toMatchObject({
      lifecycle: { kind: 'outcome', outcome: 'enable_failed' },
    });
    expect(timeoutEvent?.error?.message).toContain('timed out');
    const retryToolCallId = `tool-${randomUUID()}`;
    const retry = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId: retryToolCallId,
      additions,
      enabledResources,
    });
    expect(retry.accepted).toBe(true);
    if (retry.accepted) {
      deferredToolsReloadCoordinator.cancel({
        scope: testScope,
        requestId: retry.requestId,
        toolCallId: retryToolCallId,
        reason: 'test_cleanup',
      });
    }
    unsubscribe();
  });

  it('reports an enabling-phase timeout as an enable failure', async () => {
    restoreIntentTimeout =
      deferredToolsReloadCoordinator.setIntentTimeoutMsForTests(1);
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;

    await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events[events.length - 1]).toMatchObject({
      lifecycle: { kind: 'outcome', outcome: 'enable_failed' },
    });
    unsubscribe();
  });

  it('restarts the short result-delivery timeout for active enablement work', async () => {
    restoreIntentTimeout =
      deferredToolsReloadCoordinator.setIntentTimeoutMsForTests(1, 50);
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);

    deferredToolsReloadCoordinator.markToolResultDelivered(
      testScope,
      toolCallId,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(deferredToolsReloadCoordinator.hasActiveReload(testScope)).toBe(
      true,
    );
    expect(events.some((event) => event.lifecycle.kind === 'outcome')).toBe(
      false,
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events[events.length - 1]).toMatchObject({
      lifecycle: { kind: 'outcome', outcome: 'enable_failed' },
    });
    unsubscribe();
  });

  it('finishes by invoking the registered hidden-continuation resume handler', async () => {
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;

    const resume = jest.fn(() => Promise.resolve());
    const unsubscribeResume =
      deferredToolsReloadCoordinator.registerResumeHandler(testScope, resume);

    const beginAck = await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });
    expect(beginAck.accepted).toBe(true);

    const finishRequest = {
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      userMessageId: 'message-1',
      continuationText:
        '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>',
      resume: {
        sdkSessionId: 'session-1',
        providerType: 'claude' as const,
        interfaceMode: 'canopy' as const,
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'source', skillName: 'skill-one' }],
          pluginRefs: [],
        },
      },
    };
    const finishAck =
      await deferredToolsReloadCoordinator.finish(finishRequest);

    expect(finishAck.accepted).toBe(true);
    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: testScope,
        requestId: intent.requestId,
        toolCallId,
        userMessageId: 'message-1',
        sdkSessionId: 'session-1',
        enabledResources,
      }),
    );
    unsubscribeResume();
  });

  it('returns completed for duplicate finish retries without resuming twice', async () => {
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;

    const resume = jest.fn(() => Promise.resolve());
    const unsubscribeResume =
      deferredToolsReloadCoordinator.registerResumeHandler(testScope, resume);

    const beginAck = await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });
    expect(beginAck.accepted).toBe(true);

    const finishRequest = {
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      userMessageId: 'message-1',
      continuationText:
        '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>',
      resume: {
        sdkSessionId: 'session-1',
        providerType: 'claude' as const,
        interfaceMode: 'canopy' as const,
        pluginSelections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'source', skillName: 'skill-one' }],
          pluginRefs: [],
        },
      },
    };

    const firstAck = await deferredToolsReloadCoordinator.finish(finishRequest);
    const retryAck = await deferredToolsReloadCoordinator.finish(finishRequest);

    expect(firstAck).toMatchObject({
      accepted: true,
      lifecycle: { kind: 'state', state: 'completed' },
    });
    expect(retryAck).toMatchObject({
      accepted: true,
      lifecycle: { kind: 'state', state: 'completed' },
    });
    expect(resume).toHaveBeenCalledTimes(1);
    unsubscribeResume();
  });

  it('coalesces concurrent finish requests into one resume', async () => {
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;

    let releaseResume: (() => void) | undefined;
    const resume = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseResume = resolve;
        }),
    );
    const unsubscribeResume =
      deferredToolsReloadCoordinator.registerResumeHandler(testScope, resume);
    await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });
    const finishRequest = {
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      userMessageId: 'message-1',
      continuationText: 'continue',
      resume: { providerType: 'claude' as const },
    };

    const firstFinish = deferredToolsReloadCoordinator.finish(finishRequest);
    const secondFinish = deferredToolsReloadCoordinator.finish(finishRequest);
    expect(resume).toHaveBeenCalledTimes(1);
    releaseResume?.();

    const [firstAck, secondAck] = await Promise.all([
      firstFinish,
      secondFinish,
    ]);
    expect(firstAck).toMatchObject({ accepted: true });
    expect(secondAck).toEqual(firstAck);
    unsubscribeResume();
  });

  it('does not emit completion when resume finishes after intent timeout', async () => {
    restoreIntentTimeout =
      deferredToolsReloadCoordinator.setIntentTimeoutMsForTests(1);
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;

    let releaseResume: (() => void) | undefined;
    let resumeSignal: AbortSignal | undefined;
    const unsubscribeResume =
      deferredToolsReloadCoordinator.registerResumeHandler(
        testScope,
        (request) => {
          resumeSignal = request.signal;
          return new Promise<void>((resolve) => {
            releaseResume = resolve;
          });
        },
      );
    await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });
    const finishPromise = deferredToolsReloadCoordinator.finish({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      userMessageId: 'message-1',
      continuationText: 'continue',
      resume: { providerType: 'claude' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resumeSignal?.aborted).toBe(true);
    releaseResume?.();
    const finishAck = await finishPromise;

    expect(finishAck).toMatchObject({
      accepted: false,
      lifecycle: { kind: 'outcome', outcome: 'resume_failed' },
    });
    expect(
      events.filter(
        (event) =>
          event.lifecycle.kind === 'state' &&
          event.lifecycle.state === 'completed',
      ),
    ).toEqual([]);
    expect(events[events.length - 1]).toMatchObject({
      lifecycle: { kind: 'outcome', outcome: 'resume_failed' },
    });
    unsubscribeResume();
    unsubscribe();
  });

  it('fails visibly if a resource disappears before enablement', async () => {
    restoreRevalidator?.();
    restoreRevalidator =
      deferredToolsReloadCoordinator.setCatalogRevalidatorForTests(() =>
        Promise.resolve('skill:source:skill-one: Catalog item was not found.'),
      );
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      providerType: 'claude',
      interfaceMode: 'canopy',
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;

    const beginAck = await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });

    expect(beginAck.accepted).toBe(false);
    expect(beginAck.lifecycle).toEqual({
      kind: 'outcome',
      outcome: 'enable_failed',
    });
    expect(events[events.length - 1]).toMatchObject({
      scope: testScope,
      requestId: intent.requestId,
      lifecycle: { kind: 'outcome', outcome: 'enable_failed' },
    });
    unsubscribe();
  });

  it('does not revive an intent cancelled during catalog revalidation', async () => {
    let finishRevalidation: (() => void) | undefined;
    restoreRevalidator?.();
    restoreRevalidator =
      deferredToolsReloadCoordinator.setCatalogRevalidatorForTests(
        (): Promise<string | undefined> =>
          new Promise<string | undefined>((resolve) => {
            finishRevalidation = (): void => resolve(undefined);
          }),
      );
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;

    const beginPromise = deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions,
      enabledResources,
    });
    deferredToolsReloadCoordinator.cancel({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      reason: 'test cancellation',
    });
    finishRevalidation?.();

    const beginAck = await beginPromise;
    expect(beginAck).toMatchObject({
      accepted: false,
      rejection: { code: 'unknown_request' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      lifecycle: { kind: 'outcome', outcome: 'cancelled' },
    });
    unsubscribe();
  });

  it('rejects renderer payloads that differ from coordinator selections', async () => {
    const events: DeferredToolsReloadEvent[] = [];
    const unsubscribe = deferredToolsReloadCoordinator.subscribe((event) => {
      events.push(event);
    });
    const testScope = scope();
    const toolCallId = `tool-${randomUUID()}`;
    const intent = deferredToolsReloadCoordinator.createIntent({
      scope: testScope,
      toolCallId,
      additions,
      enabledResources,
    });
    expect(intent.accepted).toBe(true);
    if (!intent.accepted) return;

    const beginAck = await deferredToolsReloadCoordinator.begin({
      scope: testScope,
      requestId: intent.requestId,
      toolCallId,
      additions: {
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'different' }],
        mcpServerRefs: [],
      },
      enabledResources,
    });

    expect(beginAck).toMatchObject({
      accepted: false,
      lifecycle: { kind: 'outcome', outcome: 'rejected' },
      rejection: { code: 'invalid_request' },
    });
    expect(events[events.length - 1]).toMatchObject({
      lifecycle: { kind: 'outcome', outcome: 'rejected' },
    });
    expect(deferredToolsReloadCoordinator.hasActiveReload(testScope)).toBe(
      false,
    );
    unsubscribe();
  });

  describe('whenActiveReloadSettles', () => {
    function startReload(testScope: DeferredToolsReloadScopeKey): {
      requestId: string;
      toolCallId: string;
    } {
      const toolCallId = `tool-${randomUUID()}`;
      const intent = deferredToolsReloadCoordinator.createIntent({
        scope: testScope,
        toolCallId,
        providerType: 'claude',
        additions,
        enabledResources,
      });
      if (!intent.accepted) throw new Error('Expected an accepted reload');
      return { requestId: intent.requestId, toolCallId };
    }

    it('registers nothing when no reload is active in the scope', () => {
      const onSettled = jest.fn();

      expect(
        deferredToolsReloadCoordinator.whenActiveReloadSettles(
          scope(),
          onSettled,
        ),
      ).toBe(false);
      expect(onSettled).not.toHaveBeenCalled();
    });

    it('calls back once when the active reload is cancelled', () => {
      const testScope = scope();
      const { requestId, toolCallId } = startReload(testScope);
      const first = jest.fn();
      const second = jest.fn();

      expect(
        deferredToolsReloadCoordinator.whenActiveReloadSettles(
          testScope,
          first,
        ),
      ).toBe(true);
      deferredToolsReloadCoordinator.whenActiveReloadSettles(testScope, second);
      expect(first).not.toHaveBeenCalled();

      deferredToolsReloadCoordinator.cancel({
        scope: testScope,
        requestId,
        toolCallId,
        reason: 'cancelled',
      });
      deferredToolsReloadCoordinator.cancelActiveReload(testScope);

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('calls back once when the active reload times out', async () => {
      restoreIntentTimeout =
        deferredToolsReloadCoordinator.setIntentTimeoutMsForTests(1);
      const testScope = scope();
      startReload(testScope);
      const onSettled = jest.fn();
      deferredToolsReloadCoordinator.whenActiveReloadSettles(
        testScope,
        onSettled,
      );

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(deferredToolsReloadCoordinator.hasActiveReload(testScope)).toBe(
        false,
      );
      expect(onSettled).toHaveBeenCalledTimes(1);
    });

    it('calls back once after the resume handler hands off, and not for a later reload', async () => {
      const testScope = scope();
      const { requestId, toolCallId } = startReload(testScope);
      let handedOff = false;
      const unsubscribeResume =
        deferredToolsReloadCoordinator.registerResumeHandler(testScope, () => {
          handedOff = true;
          return Promise.resolve();
        });
      const onSettled = jest.fn(() => {
        expect(handedOff).toBe(true);
      });
      deferredToolsReloadCoordinator.whenActiveReloadSettles(
        testScope,
        onSettled,
      );

      const ack = await deferredToolsReloadCoordinator.finish({
        scope: testScope,
        requestId,
        toolCallId,
        userMessageId: 'message-1',
        continuationText: '<system_instruction>Continue</system_instruction>',
        resume: { providerType: 'claude' },
      });

      expect(ack.accepted).toBe(true);
      expect(onSettled).toHaveBeenCalledTimes(1);

      startReload(testScope);
      deferredToolsReloadCoordinator.cancelActiveReload(testScope);
      expect(onSettled).toHaveBeenCalledTimes(1);
      unsubscribeResume();
    });

    it('still clears the reload and calls later callbacks when one throws', () => {
      const testScope = scope();
      startReload(testScope);
      const later = jest.fn();
      deferredToolsReloadCoordinator.whenActiveReloadSettles(testScope, () => {
        throw new Error('callback failed');
      });
      deferredToolsReloadCoordinator.whenActiveReloadSettles(testScope, later);

      expect(() =>
        deferredToolsReloadCoordinator.cancelActiveReload(testScope),
      ).not.toThrow();
      expect(later).toHaveBeenCalledTimes(1);
      expect(deferredToolsReloadCoordinator.hasActiveReload(testScope)).toBe(
        false,
      );
    });
  });
});
