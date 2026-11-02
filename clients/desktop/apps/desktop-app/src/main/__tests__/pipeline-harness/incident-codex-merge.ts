/** Codex app-server resume/start identity merge regression coverage. */
import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import {
  createScenarioEnvironment,
  disposeScenario,
  SCENARIO_TEST_TIMEOUT_MS,
} from './scenarios';
import type { PipelineTraceEvent } from './contracts';
import type { PipelineStorage } from './storage';

const FIRST_PROMPT = 'codex merge original prompt';
const MERGED_PROMPT = 'codex merge overlapping prompt';
const RESUMED_OUTPUT = 'codex merge resumed live output';

interface ChatSnapshot {
  sdkSessionId: string | null;
  runtimeStatus: ChatRuntimeState['status'] | null;
  activeTurnUserMessageId: string | null;
  queuedMessageIds: readonly string[];
  openTimerCount: number;
  errorNoticeCount: number;
  messages: readonly { id: string; serialized: string }[];
}

interface MergeObservation {
  setupError?: string;
  firstUserMessageId?: string;
  firstTurnId?: string;
  secondUserMessageId?: string | null;
  secondTurnId?: string;
  resumeStatus: 'inProgress' | 'completed';
  startOrder: 'response-first' | 'started-first';
  beforeDestroy?: ChatSnapshot;
  afterDestroy?: ChatSnapshot;
  afterResumedStart?: ChatSnapshot;
  afterResumedOutput?: ChatSnapshot;
  afterResumedCompletion?: ChatSnapshot;
  queueHeldBeforeCompletion?: boolean;
  queueReleasedAfterCompletion?: boolean;
  completionFramesBefore?: number;
  completionFramesAfter?: number;
  settlementTransitions?: number;
  queueReleases?: number;
  observedStartOrder?: string;
  transportOperations?: string[];
  sendError?: string;
  turnStartRequestCount: number;
  resumeResponseCount: number;
  steerRequestCount: number;
  outputRevisionAnchors: readonly string[];
  outputAfterMergedPrompt?: boolean;
}

function snapshotFromTrace(
  trace: readonly PipelineTraceEvent[],
  chatId: string,
  outputText: string,
): { outputRevisionAnchors: string[]; outputRevisionCount: number } {
  const outputRevisions = trace.filter((event) => {
    if (event.kind !== 'revision') return false;
    const rows = event.chats[chatId]?.rows;
    return (
      rows?.some((row) => JSON.stringify(row).includes(outputText)) ?? false
    );
  });
  return {
    outputRevisionCount: outputRevisions.length,
    outputRevisionAnchors: outputRevisions.flatMap((event) => {
      if (event.kind !== 'revision') return [];
      const userMessageId =
        event.chats[chatId]?.runtime?.activeTurn?.userMessageId;
      return userMessageId ? [userMessageId] : [];
    }),
  };
}

async function readChatSnapshot(
  storage: PipelineStorage,
  target: { projectId: string; worktreeId: string; chatId: string },
): Promise<ChatSnapshot> {
  const state = await storage.repository.getState(
    { projectId: target.projectId, worktreeId: target.worktreeId },
    { chatIds: [target.chatId], fullTranscript: true },
  );
  const tab = state.tabsFile.tabs.find(
    (candidate) => candidate.id === target.chatId,
  );
  const runtime = state.runtimeByChatId[target.chatId];
  return {
    sdkSessionId: tab?.sdkSessionId ?? null,
    runtimeStatus: runtime?.status ?? null,
    activeTurnUserMessageId: runtime?.activeTurn?.userMessageId ?? null,
    queuedMessageIds: runtime?.queuedMessageIds ?? [],
    openTimerCount: (tab?.messages ?? [])
      .flatMap((message) => message.blocks)
      .filter(
        (block) => block.type === 'turn_timer' && block.completedAt === null,
      ).length,
    errorNoticeCount: (tab?.messages ?? []).filter(
      (row) =>
        row.role === 'system' &&
        row.blocks.some(
          (block) => block.type === 'text' && block.text.startsWith('Error:'),
        ),
    ).length,
    messages: (tab?.messages ?? []).map((message) => ({
      id: message.id,
      serialized: JSON.stringify(message),
    })),
  };
}

function findMessageId(
  snapshot: ChatSnapshot | undefined,
  text: string,
): string | null {
  return (
    snapshot?.messages.find((message) => message.serialized.includes(text))
      ?.id ?? null
  );
}

async function runMergeObservation(
  resumeStatus: MergeObservation['resumeStatus'],
  startOrder: MergeObservation['startOrder'],
): Promise<MergeObservation> {
  const observation: MergeObservation = {
    resumeStatus,
    startOrder,
    turnStartRequestCount: 0,
    resumeResponseCount: 0,
    steerRequestCount: 0,
    outputRevisionAnchors: [],
  };
  let env: Awaited<ReturnType<typeof createScenarioEnvironment>> | undefined;
  let storage: PipelineStorage | undefined;

  try {
    env = await createScenarioEnvironment('worktree', 'codex', {
      prepareStorage: (preparedStorage): Promise<void> => {
        storage = preparedStorage;
        return Promise.resolve();
      },
    });
    if (!storage)
      throw new Error('Codex merge incident requires real pipeline storage');

    const firstSendPromise = env.host.send({ text: FIRST_PROMPT });
    const firstTurn = await env.driver.nextTurn({ timeoutMs: 10_000 });
    await firstTurn.emitText('codex merge original output');
    const firstSend = await firstSendPromise;
    await env.host.drain();
    observation.firstUserMessageId = firstSend.userMessageId;
    observation.firstTurnId = firstTurn.turnKey;

    // Use the public session-manager lifecycle to force the next host send to
    // create a fresh provider process and resume the retained Codex thread.
    const sessionManager = await import('../../agents/session-manager');
    const providerThreadId = sessionManager
      .getSession(
        env.target.projectId,
        env.target.worktreeId,
        env.target.chatId,
      )
      ?.getProviderSessionId?.();
    if (!providerThreadId) throw new Error('Expected live provider thread id');
    // The headless fixture has no renderer compatibility writer; restore the
    // actual native continuity id through the canonical repository.
    await storage.repository.transact(
      env.target,
      [
        {
          type: 'tab.metadata_patched',
          tabId: env.target.chatId,
          patch: { sdkSessionId: providerThreadId },
        },
      ],
      { source: 'renderer-command' },
    );
    observation.beforeDestroy = await readChatSnapshot(storage, env.target);
    await sessionManager.destroySession(
      env.target.projectId,
      env.target.worktreeId,
      env.target.chatId,
      { retainDelegations: true },
    );
    observation.afterDestroy = await readChatSnapshot(storage, env.target);

    env.driver.configureNextResume?.({
      status: resumeStatus,
      turnId: firstTurn.turnKey,
      startOrder,
    });
    const resumedTraceStart = env.harness.recorder.events.length;
    const secondSendPromise = env.host
      .send({ text: MERGED_PROMPT, resume: true })
      .then(
        (result) => {
          observation.secondUserMessageId = result.userMessageId;
          return { ok: true as const };
        },
        (error: unknown) => {
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        },
      );
    const resumedTurn = await env.driver.nextTurn({ timeoutMs: 10_000 });
    observation.secondTurnId = resumedTurn.turnKey;
    await env.host.drain();
    observation.afterResumedStart = await readChatSnapshot(storage, env.target);

    await resumedTurn.emitText(RESUMED_OUTPUT);
    await env.host.drain();
    observation.afterResumedOutput = await readChatSnapshot(
      storage,
      env.target,
    );
    observation.secondUserMessageId ??= findMessageId(
      observation.afterResumedOutput,
      MERGED_PROMPT,
    );
    await env.harness.checkpoint('codex-merge-before-completion', env.target);
    const beforeCheckpoint = env.harness.recorder.events.at(-1);
    observation.queueHeldBeforeCompletion =
      beforeCheckpoint?.kind === 'checkpoint' &&
      beforeCheckpoint.queueTurnActive === true;
    observation.completionFramesBefore = env.harness.recorder.events
      .slice(resumedTraceStart)
      .filter(
        (event) =>
          event.kind === 'provider' &&
          event.type === 'notification:turn/completed',
      ).length;

    await resumedTurn.complete();
    await env.host.drain();
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const sendOutcome = await Promise.race([
      secondSendPromise,
      new Promise<'timeout'>((resolve) => {
        settlementTimer = setTimeout(() => resolve('timeout'), 5_000);
      }),
    ]);
    if (settlementTimer) clearTimeout(settlementTimer);
    if (sendOutcome === 'timeout') {
      observation.sendError = 'Host admission did not settle';
    } else {
      if (!sendOutcome.ok) observation.sendError = sendOutcome.error;
    }
    observation.afterResumedCompletion = await readChatSnapshot(
      storage,
      env.target,
    );

    await env.harness.checkpoint('codex-merge-after-completion', env.target);
    const afterCheckpoint = env.harness.recorder.events.at(-1);
    observation.queueReleasedAfterCompletion =
      afterCheckpoint?.kind === 'checkpoint' &&
      afterCheckpoint.queueTurnActive === false &&
      afterCheckpoint.sessionTurnActive === false;
    const resumedTrace = env.harness.recorder.events.slice(resumedTraceStart);
    observation.completionFramesAfter = resumedTrace.filter(
      (event) =>
        event.kind === 'provider' &&
        event.type === 'notification:turn/completed',
    ).length;
    let wasRunning = false;
    let priorGate: boolean | undefined;
    observation.settlementTransitions = 0;
    observation.queueReleases = 0;
    for (const event of resumedTrace) {
      if (event.kind === 'revision') {
        const runtime = event.chats[env.target.chatId]?.runtime;
        if (runtime?.activeTurn) wasRunning = true;
        if (
          wasRunning &&
          runtime?.status === 'completed' &&
          !runtime.activeTurn
        ) {
          observation.settlementTransitions++;
          wasRunning = false;
        }
      }
      if (event.kind === 'queue') {
        if (priorGate === true && event.turnActive === false)
          observation.queueReleases++;
        if (event.turnActive !== undefined) priorGate = event.turnActive;
      }
    }
    observation.observedStartOrder = resumedTrace
      .filter(
        (event) =>
          event.kind === 'provider' &&
          ['response:turn/start', 'notification:turn/started'].includes(
            event.type,
          ),
      )
      .map((event) => (event.kind === 'provider' ? event.type : ''))
      .join(',');
    const chatId = env.target.chatId;
    const providerEvents = env.harness.recorder.events.filter(
      (event) => event.kind === 'provider' && event.target.chatId === chatId,
    );
    observation.transportOperations = providerEvents.map((event) =>
      event.kind === 'provider' ? event.type : '',
    );
    observation.turnStartRequestCount = providerEvents.filter(
      (event) =>
        event.kind === 'provider' &&
        event.direction === 'to-provider' &&
        event.type === 'client:turn/start',
    ).length;
    observation.resumeResponseCount = providerEvents.filter(
      (event) =>
        event.kind === 'provider' &&
        event.direction === 'to-canopy' &&
        event.type === 'response:thread/resume',
    ).length;
    observation.steerRequestCount = providerEvents.filter(
      (event) =>
        event.kind === 'provider' &&
        event.direction === 'to-provider' &&
        /steer/i.test(event.type),
    ).length;
    const finalMessages = observation.afterResumedCompletion?.messages ?? [];
    const promptIndex = finalMessages.findIndex((message) =>
      message.serialized.includes(MERGED_PROMPT),
    );
    observation.outputAfterMergedPrompt =
      promptIndex >= 0 &&
      finalMessages.findIndex((message) =>
        message.serialized.includes(RESUMED_OUTPUT),
      ) > promptIndex;
    observation.outputRevisionAnchors = snapshotFromTrace(
      env.harness.recorder.events,
      env.target.chatId,
      RESUMED_OUTPUT,
    ).outputRevisionAnchors;
  } catch (error) {
    observation.setupError =
      error instanceof Error ? error.message : String(error);
  } finally {
    if (env) await disposeScenario(env);
  }

  return observation;
}

function assertLiveResumeMerged(observation: MergeObservation): void {
  expect(observation.setupError).toBeUndefined();
  expect(observation.sendError).toBeUndefined();
  expect(observation.turnStartRequestCount).toBe(2);
  expect({
    resumes: observation.resumeResponseCount,
    threadBefore: observation.beforeDestroy?.sdkSessionId,
    threadAfter: observation.afterDestroy?.sdkSessionId,
    operations: observation.resumeResponseCount
      ? []
      : observation.transportOperations,
  }).toEqual({
    resumes: 1,
    threadBefore: observation.beforeDestroy?.sdkSessionId,
    threadAfter: observation.beforeDestroy?.sdkSessionId,
    operations: [],
  });
  expect(observation.steerRequestCount).toBe(0);
  expect(observation.observedStartOrder).toBe(
    observation.startOrder === 'response-first'
      ? 'response:turn/start,notification:turn/started'
      : 'notification:turn/started,response:turn/start',
  );
  expect(observation.secondTurnId).toBe(observation.firstTurnId);
  expect(observation.beforeDestroy?.sdkSessionId).not.toBeNull();
  expect(observation.afterDestroy?.sdkSessionId).toBe(
    observation.beforeDestroy?.sdkSessionId,
  );
  expect({
    runningStatus: observation.afterResumedStart?.runtimeStatus,
    openTimers: observation.afterResumedStart?.openTimerCount,
    runningAnchor: observation.afterResumedStart?.activeTurnUserMessageId,
    outputStatus: observation.afterResumedOutput?.runtimeStatus,
    outputAnchor: observation.afterResumedOutput?.activeTurnUserMessageId,
    outputAnchors: Array.from(new Set(observation.outputRevisionAnchors)),
    outputAfterMergedPrompt: observation.outputAfterMergedPrompt,
    noticesBeforeCompletion: observation.afterResumedOutput?.errorNoticeCount,
    queueHeldBeforeCompletion: observation.queueHeldBeforeCompletion,
    completionFramesBefore: observation.completionFramesBefore,
    completionFramesAfter: observation.completionFramesAfter,
    settlementTransitions: observation.settlementTransitions,
    queueReleases: observation.queueReleases,
    queueReleasedAfterCompletion: observation.queueReleasedAfterCompletion,
    finalStatus: observation.afterResumedCompletion?.runtimeStatus,
    finalAnchor: observation.afterResumedCompletion?.activeTurnUserMessageId,
    finalOpenTimers: observation.afterResumedCompletion?.openTimerCount,
  }).toEqual({
    runningStatus: 'streaming',
    openTimers: 1,
    // The resumed turn ended canonically with its destroyed session, so the
    // merge is a fresh execution bound to the second prompt (phase 35c4d).
    runningAnchor: observation.secondUserMessageId,
    outputStatus: 'streaming',
    outputAnchor: observation.secondUserMessageId,
    // The output's row lands with its deferred item completion, after
    // turn/completed. Canonical runtime follows lifecycle receipts, so that
    // revision already shows the turn ended.
    outputAnchors: [],
    outputAfterMergedPrompt: true,
    noticesBeforeCompletion: 0,
    queueHeldBeforeCompletion: true,
    completionFramesBefore: 0,
    completionFramesAfter: 1,
    settlementTransitions: 1,
    queueReleases: 1,
    queueReleasedAfterCompletion: true,
    finalStatus: 'completed',
    finalAnchor: null,
    finalOpenTimers: 0,
  });
}

/** Called by the parent incident suite; every row uses the real Codex host. */
export function registerCodexMergedStartIncidentTests(): void {
  describe('Codex root lifecycle', () => {
    it.each(['response-first', 'started-first'] as const)(
      'merges a live resumed turn when turn/start is %s',
      async (startOrder) => {
        const observation = await runMergeObservation('inProgress', startOrder);
        assertLiveResumeMerged(observation);
      },
      SCENARIO_TEST_TIMEOUT_MS,
    );

    it(
      'starts the next send after its session was destroyed during a wake',
      async () => {
        const env = await createScenarioEnvironment('worktree', 'codex');
        try {
          const firstSend = env.host.send({ text: FIRST_PROMPT });
          const first = await env.driver.nextTurn({ timeoutMs: 10_000 });
          await first.complete();
          await firstSend;
          await env.host.drain();
          const wake = await env.driver.startTurnByItself({
            text: RESUMED_OUTPUT,
          });
          await wake.emitText(RESUMED_OUTPUT);
          await env.host.drain();
          const sessionManager = await import('../../agents/session-manager');
          // The wake's transport goes away without its turn/completed.
          await sessionManager.destroySession(
            env.target.projectId,
            env.target.worktreeId,
            env.target.chatId,
            { retainDelegations: true },
          );
          const nextSend = env.host.send({ text: MERGED_PROMPT });
          // No provider event follows, so the turn handoff's fallback commits
          // the wake's end (a wall-clock timer here); the queue then drains
          // the held send on its logical timer.
          const ownership = (
            await import('../../services/chat-turn-ownership')
          ).getChatTurnOwnership();
          for (
            let waitedMs = 0;
            ownership.getSnapshot(env.target).committed?.state.current &&
            waitedMs < 5_000;
            waitedMs += 50
          )
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          await env.harness.advanceLogicalClock(0);
          const next = await env.driver.nextTurn({ timeoutMs: 10_000 });
          expect(next.prompt).toContain(MERGED_PROMPT);
          await next.complete();
          await nextSend;
          await env.host.drain();
        } finally {
          await disposeScenario(env);
        }
      },
      SCENARIO_TEST_TIMEOUT_MS,
    );

    it(
      'dispatches a reused id when resume reported that id completed',
      async () => {
        const observation = await runMergeObservation(
          'completed',
          'response-first',
        );
        expect(observation.setupError).toBeUndefined();
        expect(observation.sendError).toBeUndefined();
        expect(observation.turnStartRequestCount).toBe(2);
        expect(observation.resumeResponseCount).toBe(1);
        expect(observation.steerRequestCount).toBe(0);
        expect(observation.secondTurnId).toBe(observation.firstTurnId);
        expect(observation.beforeDestroy?.sdkSessionId).not.toBeNull();
        expect(observation.afterDestroy?.sdkSessionId).toBe(
          observation.beforeDestroy?.sdkSessionId,
        );
        expect(observation.queueReleasedAfterCompletion).toBe(true);
        expect({
          status: observation.afterResumedOutput?.runtimeStatus,
          openTimerCount: observation.afterResumedOutput?.openTimerCount,
        }).toEqual({ status: 'streaming', openTimerCount: 1 });
        expect(observation.afterResumedOutput?.activeTurnUserMessageId).toBe(
          observation.secondUserMessageId,
        );
        expect(observation.outputAfterMergedPrompt).toBe(true);
      },
      SCENARIO_TEST_TIMEOUT_MS,
    );
  });
}
