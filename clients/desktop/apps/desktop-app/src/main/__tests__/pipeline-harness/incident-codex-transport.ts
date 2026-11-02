/**
 * Real-host Codex app-server transport failures (integration decision D8).
 *
 * Develop's in-session recovery (a575ac07e0) runs first: a `thread/resume`
 * rejected while the thread closes is retried, and an unanswered thread
 * setup recycles an idle worker and retries once. Only a failed recovery
 * ends the turn canonically (phase 35c4c), with the structured retryable
 * marker, and the chat retry service then dispatches a new turn through the
 * chat queue's admission instead of reviving the ended one.
 */
import type { TurnEnded, TurnStarted } from '@canopy/protocol/canopy-core';
import type {
  ChatRuntimeState,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type {
  PipelineChatTarget,
  PipelineTraceEvent,
  ProviderTraceEvent,
} from './contracts';
import {
  createScenarioEnvironment,
  disposeScenario,
  SCENARIO_TEST_TIMEOUT_MS,
} from './scenarios';
import {
  bindNextScriptedCodexThreadTarget,
  queueScriptedCodexRequestFault,
} from './scripted-codex';
import type { PipelineStorage } from './storage';

// Matchers read as `unknown`, so object literals that hold them stay typed.
const anyString: unknown = expect.any(String);

function resultKind(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'kind' in value
    ? value.kind
    : undefined;
}

type TransportEnvironment = Awaited<
  ReturnType<typeof createScenarioEnvironment>
>;

interface TurnLifecycleView {
  starts: Array<Pick<TurnStarted, 'turnId' | 'origin' | 'userMessageIds'>>;
  ends: Array<Pick<TurnEnded, 'turnId' | 'outcome' | 'source'>>;
}

function isChat(
  chat: PipelineChatTarget,
  target: PipelineChatTarget | undefined,
): boolean {
  return (
    target?.projectId === chat.projectId &&
    target.worktreeId === chat.worktreeId &&
    target.chatId === chat.chatId
  );
}

/** The canonical lifecycle events that name one user message's turn. */
function turnLifecycle(
  env: TransportEnvironment,
  userMessageId: string,
  chat: PipelineChatTarget = env.target,
): TurnLifecycleView {
  const view: TurnLifecycleView = { starts: [], ends: [] };
  for (const event of env.harness.recorder.events) {
    if (event.kind !== 'turn-lifecycle' || !isChat(chat, event.target))
      continue;
    const lifecycle = event.event;
    if (
      lifecycle.type === 'TurnStarted' &&
      lifecycle.phase === 'start' &&
      lifecycle.userMessageIds.includes(userMessageId)
    )
      view.starts.push({
        turnId: lifecycle.turnId,
        origin: lifecycle.origin,
        userMessageIds: [...lifecycle.userMessageIds],
      });
    if (
      lifecycle.type === 'TurnEnded' &&
      lifecycle.userMessageIds.includes(userMessageId)
    )
      view.ends.push({
        turnId: lifecycle.turnId,
        outcome: lifecycle.outcome,
        source: lifecycle.source,
      });
  }
  return view;
}

function clientRequests(
  env: TransportEnvironment,
  method: string,
  since = 0,
  chat: PipelineChatTarget = env.target,
): ProviderTraceEvent[] {
  return env.harness.recorder.events
    .slice(since)
    .filter(
      (event): event is ProviderTraceEvent =>
        event.kind === 'provider' &&
        event.direction === 'to-provider' &&
        event.type === `client:${method}` &&
        isChat(chat, event.target),
    );
}

function latestRuntime(
  env: TransportEnvironment,
  chat: PipelineChatTarget = env.target,
): ChatRuntimeState | undefined {
  const revision = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event): event is Extract<PipelineTraceEvent, { kind: 'revision' }> =>
        event.kind === 'revision' &&
        event.projectId === chat.projectId &&
        event.worktreeId === chat.worktreeId &&
        event.chats[chat.chatId]?.runtime !== undefined,
    );
  return revision?.chats[chat.chatId]?.runtime;
}

/** Runtime revisions that moved the chat into `failed`, in trace order. */
function failedTransitions(
  env: TransportEnvironment,
  chat: PipelineChatTarget = env.target,
): number {
  let previous: ChatRuntimeState['status'] | undefined;
  let transitions = 0;
  for (const event of env.harness.recorder.events) {
    if (
      event.kind !== 'revision' ||
      event.projectId !== chat.projectId ||
      event.worktreeId !== chat.worktreeId
    )
      continue;
    const status = event.chats[chat.chatId]?.runtime?.status;
    if (status === 'failed' && previous !== 'failed') transitions += 1;
    if (status !== undefined) previous = status;
  }
  return transitions;
}

async function turnOutcome(
  chat: PipelineChatTarget,
  userMessageId: string,
): Promise<string> {
  const { getChatStateService } =
    await import('../../services/chat-state-service');
  return getChatStateService().turnOutcome({ ...chat, userMessageId });
}

/**
 * Ends the live session and restores the thread id, so the next send makes a
 * fresh app-server client that resumes the same thread (`thread/resume`).
 */
async function forceResumeOnNextSend(
  env: TransportEnvironment,
  storage: PipelineStorage,
): Promise<void> {
  const sessionManager = await import('../../agents/session-manager');
  const threadId = sessionManager
    .getSession(env.target.projectId, env.target.worktreeId, env.target.chatId)
    ?.getProviderSessionId?.();
  if (!threadId) throw new Error('Expected a live Codex thread id');
  await storage.repository.transact(
    env.target,
    [
      {
        type: 'tab.metadata_patched',
        tabId: env.target.chatId,
        patch: { sdkSessionId: threadId },
      },
    ],
    { source: 'renderer-command' },
  );
  await sessionManager.destroySession(
    env.target.projectId,
    env.target.worktreeId,
    env.target.chatId,
    { retainDelegations: true },
  );
  await env.host.drain();
}

// The thread setup deadline (`DEFAULT_CODEX_THREAD_MUTATION_TIMEOUT_MS`).
const THREAD_SETUP_TIMEOUT_MS = 2 * 60_000;
// The first chat retry delay (`CHAT_TRANSIENT_RETRY_DELAYS_MS[0]`).
const FIRST_CHAT_RETRY_DELAY_MS = 30_000;

// Captured before any test installs fake timers, so every awaited host
// boundary keeps a real-time bound.
const scheduleRealTimeout = globalThis.setTimeout.bind(globalThis);
const clearRealTimeout = globalThis.clearTimeout.bind(globalThis);

function bounded<T>(
  promise: Promise<T>,
  operation: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = scheduleRealTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms: ${operation}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearRealTimeout(timer);
  });
}

/** Steps the fake clock in short slices, with real I/O between, until true. */
async function advanceUntil(
  env: TransportEnvironment,
  predicate: () => boolean,
  description: string,
  maxMs = 5_000,
): Promise<void> {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += 25) {
    await bounded(env.host.drain(), `${description}: drain`);
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await bounded(jest.advanceTimersByTimeAsync(25), `${description}: clock`);
  }
  throw new Error(
    `Timed out waiting for ${description}: ${JSON.stringify(env.harness.recorder.events.slice(-12))}`,
  );
}

async function advanceClock(ms: number, description: string): Promise<void> {
  await bounded(jest.advanceTimersByTimeAsync(ms), description, 30_000);
}

/** Replaces user message ids in lifecycle starts with readable labels. */
function labelStarts(
  view: TurnLifecycleView,
  label: (id: string) => string,
): TurnLifecycleView {
  return {
    ...view,
    starts: view.starts.map((start) => ({
      ...start,
      userMessageIds: start.userMessageIds.map(label),
    })),
  };
}

/** Failed terminal events the Codex session reported to the retry service. */
function resultErrorEvents(
  calls: ReadonlyArray<readonly unknown[]>,
  chatId?: string,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const call of calls) {
    const chat = call[0];
    if (
      chatId !== undefined &&
      (typeof chat !== 'object' ||
        chat === null ||
        Reflect.get(chat, 'chatId') !== chatId)
    )
      continue;
    const data = call[2];
    if (
      typeof data === 'object' &&
      data !== null &&
      Reflect.get(data, 'type') === 'result' &&
      Reflect.get(data, 'is_error') === true
    )
      events.push({
        canopy_turn_user_message_id: Reflect.get(
          data,
          'canopy_turn_user_message_id',
        ),
        subtype: Reflect.get(data, 'subtype'),
        codex_error_code: Reflect.get(data, 'codex_error_code'),
        codex_error_method: Reflect.get(data, 'codex_error_method'),
      });
  }
  return events;
}

interface FailedRecoveryObservation {
  failure: Record<string, unknown>;
  failedRecord: Record<string, unknown>;
  retry: Record<string, unknown>;
}

/**
 * Two unanswered `thread/start` requests: the first recycles the idle worker,
 * the second fails the turn. The chat retry service then retries it once
 * (user message ids are reported as `failed` and `retry`).
 */
async function runFailedRecovery(): Promise<FailedRecoveryObservation> {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  let env: TransportEnvironment | undefined;
  let storage: PipelineStorage | undefined;
  let resetRetryService: (() => void) | undefined;
  try {
    env = await bounded(
      createScenarioEnvironment('worktree', 'codex', {
        prepareStorage: (prepared): Promise<void> => {
          storage = prepared;
          return Promise.resolve();
        },
      }),
      'create Codex transport scenario',
      60_000,
    );
    const current = env;
    const repository = storage?.repository;
    if (!repository) throw new Error('Expected real pipeline storage');
    const retryService =
      await import('../../lib/transient-error-retry-service');
    resetRetryService = retryService.resetTransientRetryServiceForTests;
    retryService.initTransientErrorRetryService(() => null, {
      readPreferences: () =>
        Promise.resolve({ autoRetryTransientErrorsChats: true }),
    });
    const notedEvents = jest.spyOn(retryService, 'noteChatSessionEvent');
    const { getChatDispatchAuthorization } =
      await import('../../services/chat-dispatch-authorization');
    const consumed = jest.spyOn(getChatDispatchAuthorization(), 'consume');
    const { getChatQueueService } =
      await import('../../services/chat-queue-service');
    const submitted = jest.spyOn(getChatQueueService(), 'submit');
    const readTab = async (): Promise<PersistedChatTab | undefined> => {
      const state = await repository.getState(current.target, {
        chatIds: [current.target.chatId],
      });
      return state.tabsFile.tabs.find(
        (tab) => tab.id === current.target.chatId,
      );
    };

    queueScriptedCodexRequestFault(current.driver, {
      method: 'thread/start',
      kind: 'stall',
      count: 2,
    });
    const failedSend = current.host.send({ text: 'D8 doubly stalled' });
    await advanceUntil(
      current,
      () => clientRequests(current, 'thread/start').length === 1,
      'the first thread/start',
    );
    await advanceClock(
      THREAD_SETUP_TIMEOUT_MS,
      'the first thread/start deadline',
    );
    await advanceUntil(
      current,
      () => clientRequests(current, 'thread/start').length === 2,
      'thread/start on the recycled worker',
    );
    await advanceClock(
      THREAD_SETUP_TIMEOUT_MS,
      'the second thread/start deadline',
    );
    await advanceUntil(
      current,
      () => latestRuntime(current)?.status === 'failed',
      'the failed turn to settle',
    );
    const { userMessageId: failedId } = await bounded(
      failedSend,
      'the failed send',
    );
    const retry: { id?: string } = {};
    const label = (id: unknown): string =>
      id === failedId ? 'failed' : id === retry.id ? 'retry' : String(id);
    const failedTab = await readTab();
    const failure = {
      workers: current.harness.recorder.events.filter(
        (event) =>
          event.kind === 'provider' && event.type === 'client:initialize',
      ).length,
      turnStarts: clientRequests(current, 'turn/start').length,
      terminals: resultErrorEvents(notedEvents.mock.calls).map((event) => ({
        ...event,
        canopy_turn_user_message_id: label(event.canopy_turn_user_message_id),
      })),
      lifecycle: turnLifecycle(current, failedId),
      runtime: {
        status: latestRuntime(current)?.status,
        retryable: latestRuntime(current)?.error?.retryable,
      },
      failedTransitions: failedTransitions(current),
    };
    const failedRecord: Record<string, unknown> = {
      runtimeStatus: latestRuntime(current)?.status,
      lastAccepted: label(failedTab?.lastAcceptedUserMessageId),
      turnEnd: failedTab?.turnEnds?.[failedId]?.outcome,
      outcome: await turnOutcome(current.target, failedId),
    };

    // The chat retry service's first attempt.
    await advanceClock(FIRST_CHAT_RETRY_DELAY_MS, 'the retry delay');
    await advanceUntil(
      current,
      () => clientRequests(current, 'turn/start').length === 1,
      'the retried turn/start',
    );
    const retried = await bounded(
      current.driver.nextTurn({ timeoutMs: 60_000 }),
      'the retried turn',
    );
    await retried.emitText('retried output');
    await retried.complete();
    await advanceUntil(
      current,
      () => latestRuntime(current)?.status === 'completed',
      'the retried turn to complete',
    );
    retry.id = submitted.mock.calls
      .map(([request]) => request.userMessageId)
      .find((id) => id !== failedId);
    const retryId = retry.id;
    if (!retryId) throw new Error('The retry was not submitted');
    const retryLifecycle = turnLifecycle(current, retryId);
    failedRecord.outcomeAfterRetry = await turnOutcome(
      current.target,
      failedId,
    );
    return {
      failure,
      failedRecord,
      retry: {
        prompt: retried.prompt.includes('D8 doubly stalled'),
        submitted: submitted.mock.calls.map(([request, origin]) => ({
          userMessageId: label(request.userMessageId),
          origin,
          initiationSource: request.initiationSource,
        })),
        authorizations: consumed.mock.calls.map(([, target], index) => ({
          userMessageId: label(target.userMessageId),
          kind: resultKind(consumed.mock.results[index]?.value),
        })),
        retryLifecycle: labelStarts(retryLifecycle, label),
        failedLifecycle: turnLifecycle(current, failedId),
        terminals: resultErrorEvents(notedEvents.mock.calls).length,
        retryOutcome: await turnOutcome(current.target, retryId),
        retryEntries: retryService.getTransientRetryStateSnapshot().length,
      },
    };
  } finally {
    resetRetryService?.();
    if (!env) jest.restoreAllMocks();
    try {
      if (env) await bounded(disposeScenario(env), 'dispose', 30_000);
    } finally {
      jest.useRealTimers();
    }
  }
}

// Two bounded `turn/interrupt` attempts (`INTERRUPT_REQUEST_TIMEOUT_MS`).
const INTERRUPT_DEADLINES_MS = 5_000;
// A bystander's bounded recovery resumes (`CODEX_PROCESS_RECOVERY_MAX_ATTEMPTS`).
const RECOVERY_RESUME_ATTEMPTS = 3;

/**
 * Chat A's Stop finds its worker wedged (`turn/interrupt` is never answered),
 * which forces a shared restart. Chat B's running turn on the same worker
 * goes to recovery, whose every `thread/resume` fails. The chat retry
 * service then retries B once (user message ids are reported as `failed`
 * and `retry`).
 */
async function runSharedRestartRecoveryFailure(): Promise<FailedRecoveryObservation> {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  let env: TransportEnvironment | undefined;
  let storage: PipelineStorage | undefined;
  let resetRetryService: (() => void) | undefined;
  try {
    env = await bounded(
      createScenarioEnvironment('worktree', 'codex', {
        prepareStorage: (prepared): Promise<void> => {
          storage = prepared;
          return Promise.resolve();
        },
      }),
      'create Codex shared restart scenario',
      60_000,
    );
    const current = env;
    const repository = storage?.repository;
    if (!repository) throw new Error('Expected real pipeline storage');
    const bystander: PipelineChatTarget = {
      ...current.target,
      chatId: 'd8-bystander',
    };
    current.harness.registerChat(bystander, {
      captureRows: true,
      captureTranscript: 'revision',
    });
    const bystanderHost = await bounded(
      current.harness.host('worktree', 'codex', bystander),
      'create the bystander host',
    );
    const retryService =
      await import('../../lib/transient-error-retry-service');
    resetRetryService = retryService.resetTransientRetryServiceForTests;
    retryService.initTransientErrorRetryService(() => null, {
      readPreferences: () =>
        Promise.resolve({ autoRetryTransientErrorsChats: true }),
    });
    const notedEvents = jest.spyOn(retryService, 'noteChatSessionEvent');
    const { getChatDispatchAuthorization } =
      await import('../../services/chat-dispatch-authorization');
    const consumed = jest.spyOn(getChatDispatchAuthorization(), 'consume');
    const { getChatQueueService } =
      await import('../../services/chat-queue-service');
    const submitted = jest.spyOn(getChatQueueService(), 'submit');

    const ownerSend = current.host.send({ text: 'D8 restart owner' });
    await advanceUntil(
      current,
      () => clientRequests(current, 'turn/start').length === 1,
      "the owner's turn/start",
    );
    const owner = await bounded(
      current.driver.nextTurn({ timeoutMs: 60_000 }),
      "the owner's turn",
    );
    await owner.emitText('owner output');
    await bounded(ownerSend, "the owner's send");
    bindNextScriptedCodexThreadTarget(current.driver, bystander);
    const bystanderSend = bystanderHost.send({ text: 'D8 bystander' });
    await advanceUntil(
      current,
      () => clientRequests(current, 'turn/start', 0, bystander).length === 1,
      "the bystander's turn/start",
    );
    const running = await bounded(
      current.driver.nextTurn({ timeoutMs: 60_000 }),
      "the bystander's turn",
    );
    await running.emitText('bystander output');
    const { userMessageId: failedId } = await bounded(
      bystanderSend,
      "the bystander's send",
    );
    await bounded(current.host.drain(), 'drain both running turns');
    const failedStartsBeforeRestart = turnLifecycle(
      current,
      failedId,
      bystander,
    ).starts.length;

    queueScriptedCodexRequestFault(current.driver, {
      method: 'turn/interrupt',
      kind: 'stall',
      count: 2,
    });
    queueScriptedCodexRequestFault(current.driver, {
      method: 'thread/resume',
      kind: 'error',
      count: RECOVERY_RESUME_ATTEMPTS,
    });
    const stopping = current.host.stop();
    await advanceUntil(
      current,
      () => clientRequests(current, 'turn/interrupt').length === 1,
      "the owner's turn/interrupt",
    );
    await advanceClock(INTERRUPT_DEADLINES_MS, 'the interrupt deadlines');
    await advanceUntil(
      current,
      () => latestRuntime(current, bystander)?.status === 'failed',
      "the bystander's failed recovery",
    );
    await bounded(stopping, "the owner's Stop");
    const retry: { id?: string } = {};
    const label = (id: unknown): string =>
      id === failedId ? 'failed' : id === retry.id ? 'retry' : String(id);
    const readTab = async (): Promise<PersistedChatTab | undefined> => {
      const state = await repository.getState(bystander, {
        chatIds: [bystander.chatId],
      });
      return state.tabsFile.tabs.find((tab) => tab.id === bystander.chatId);
    };
    const failedTab = await readTab();
    const failure = {
      startedBeforeRestart: failedStartsBeforeRestart,
      recoveryResumes: clientRequests(current, 'thread/resume', 0, bystander)
        .length,
      terminals: resultErrorEvents(
        notedEvents.mock.calls,
        bystander.chatId,
      ).map((event) => ({
        ...event,
        canopy_turn_user_message_id: label(event.canopy_turn_user_message_id),
      })),
      lifecycle: turnLifecycle(current, failedId, bystander),
      runtime: {
        status: latestRuntime(current, bystander)?.status,
        retryable: latestRuntime(current, bystander)?.error?.retryable,
      },
      failedTransitions: failedTransitions(current, bystander),
    };
    const failedRecord: Record<string, unknown> = {
      runtimeStatus: latestRuntime(current, bystander)?.status,
      lastAccepted: label(failedTab?.lastAcceptedUserMessageId),
      turnEnd: failedTab?.turnEnds?.[failedId]?.outcome,
      outcome: await turnOutcome(bystander, failedId),
    };

    // The chat retry service's first attempt for the bystander.
    const turnStartsBeforeRetry = clientRequests(
      current,
      'turn/start',
      0,
      bystander,
    ).length;
    await advanceClock(FIRST_CHAT_RETRY_DELAY_MS, 'the retry delay');
    await advanceUntil(
      current,
      () =>
        clientRequests(current, 'turn/start', 0, bystander).length ===
        turnStartsBeforeRetry + 1,
      'the retried turn/start',
    );
    const retried = await bounded(
      current.driver.nextTurn({ timeoutMs: 60_000 }),
      'the retried turn',
    );
    await retried.emitText('retried output');
    await retried.complete();
    await advanceUntil(
      current,
      () => latestRuntime(current, bystander)?.status === 'completed',
      'the retried turn to complete',
    );
    retry.id = submitted.mock.calls
      .map(([request]) => request)
      .find(
        (request) =>
          request.chatId === bystander.chatId &&
          request.userMessageId !== failedId,
      )?.userMessageId;
    const retryId = retry.id;
    if (!retryId) throw new Error('The retry was not submitted');
    const retryLifecycle = turnLifecycle(current, retryId, bystander);
    failedRecord.outcomeAfterRetry = await turnOutcome(bystander, failedId);
    return {
      failure,
      failedRecord,
      retry: {
        submitted: submitted.mock.calls
          .filter(([request]) => request.chatId === bystander.chatId)
          .map(([request, origin]) => ({
            userMessageId: label(request.userMessageId),
            origin,
            initiationSource: request.initiationSource,
          })),
        authorizations: consumed.mock.calls
          .map(([, target], index) => ({
            target,
            kind: resultKind(consumed.mock.results[index]?.value),
          }))
          .filter(({ target }) => target.chatId === bystander.chatId)
          .map(({ target, kind }) => ({
            userMessageId: label(target.userMessageId),
            kind,
          })),
        retryLifecycle: labelStarts(retryLifecycle, label),
        failedLifecycle: labelStarts(
          turnLifecycle(current, failedId, bystander),
          label,
        ),
        terminals: resultErrorEvents(notedEvents.mock.calls, bystander.chatId)
          .length,
        retryOutcome: await turnOutcome(bystander, retryId),
        retryEntries: retryService.getTransientRetryStateSnapshot().length,
      },
    };
  } finally {
    resetRetryService?.();
    if (!env) jest.restoreAllMocks();
    try {
      if (env) await bounded(disposeScenario(env), 'dispose', 30_000);
    } finally {
      jest.useRealTimers();
    }
  }
}

export function registerCodexTransportIncidentTests(): void {
  describe('Codex app-server transport failures (D8)', () => {
    it(
      'recovers a resume rejected while the thread closes inside the session, with no lost-turn end',
      async () => {
        let storage: PipelineStorage | undefined;
        const env = await createScenarioEnvironment('worktree', 'codex', {
          prepareStorage: (prepared): Promise<void> => {
            storage = prepared;
            return Promise.resolve();
          },
        });
        let observation: Record<string, unknown> = {};
        try {
          if (!storage) throw new Error('Expected real pipeline storage');
          const firstSend = env.host.send({ text: 'D8 closing first turn' });
          const first = await env.driver.nextTurn({ timeoutMs: 10_000 });
          await first.emitText('first output');
          await firstSend;
          await first.complete();
          await env.host.drain();

          await forceResumeOnNextSend(env, storage);
          queueScriptedCodexRequestFault(env.driver, {
            method: 'thread/resume',
            kind: 'closing',
          });
          const traceStart = env.harness.recorder.events.length;
          const resumedSend = env.host.send({
            text: 'D8 closing resumed turn',
            resume: true,
          });
          const resumed = await env.driver.nextTurn({ timeoutMs: 15_000 });
          const { userMessageId } = await resumedSend;
          await resumed.emitText('resumed output');
          await env.host.drain();
          const beforeCompletion = turnLifecycle(env, userMessageId);
          await resumed.complete();
          await env.host.drain();

          const resumeResponses = env.harness.recorder.events
            .slice(traceStart)
            .filter(
              (event) =>
                event.kind === 'provider' &&
                event.direction === 'to-canopy' &&
                event.type === 'response:thread/resume',
            ).length;
          observation = {
            prompt: resumed.prompt.includes('D8 closing resumed turn'),
            resumeRequests: clientRequests(env, 'thread/resume', traceStart)
              .length,
            resumeResponses,
            rebuiltThreads: clientRequests(env, 'thread/start', traceStart)
              .length,
            turnStarts: clientRequests(env, 'turn/start', traceStart).length,
            endsBeforeCompletion: beforeCompletion.ends,
            lifecycle: turnLifecycle(env, userMessageId),
            runtime: {
              status: latestRuntime(env)?.status,
              error: latestRuntime(env)?.error,
            },
            failedTransitions: failedTransitions(env),
            outcome: await turnOutcome(env.target, userMessageId),
          };
        } finally {
          await disposeScenario(env);
        }

        expect(observation).toEqual({
          prompt: true,
          // The closing rejection, then the same resume again: never a
          // rebuild onto a new thread (`thread/start`).
          resumeRequests: 2,
          resumeResponses: 2,
          rebuiltThreads: 0,
          turnStarts: 1,
          // The turn kept running: no lost-turn end while it ran.
          endsBeforeCompletion: [],
          lifecycle: {
            starts: [
              {
                turnId: anyString,
                origin: 'user',
                userMessageIds: [anyString],
              },
            ],
            ends: [
              {
                turnId: anyString,
                outcome: 'completed',
                source: 'turn-completed',
              },
            ],
          },
          runtime: { status: 'completed', error: undefined },
          failedTransitions: 0,
          outcome: 'completed',
        });
      },
      SCENARIO_TEST_TIMEOUT_MS,
    );

    it(
      'recycles an idle worker after an unanswered thread/start and keeps the turn, with no lost-turn end',
      async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        let env: TransportEnvironment | undefined;
        let observation: Record<string, unknown> = {};
        try {
          env = await bounded(
            createScenarioEnvironment('worktree', 'codex'),
            'create Codex transport scenario',
            60_000,
          );
          const current = env;
          const retryService =
            await import('../../lib/transient-error-retry-service');
          const notedEvents = jest.spyOn(retryService, 'noteChatSessionEvent');
          queueScriptedCodexRequestFault(current.driver, {
            method: 'thread/start',
            kind: 'stall',
          });
          const sending = current.host.send({ text: 'D8 stalled start' });
          await advanceUntil(
            current,
            () => clientRequests(current, 'thread/start').length === 1,
            'the first thread/start',
          );
          await advanceClock(
            THREAD_SETUP_TIMEOUT_MS,
            'the thread/start deadline',
          );
          await advanceUntil(
            current,
            () => clientRequests(current, 'turn/start').length === 1,
            'turn/start on the recycled worker',
          );
          const turn = await bounded(
            current.driver.nextTurn({ timeoutMs: 60_000 }),
            'the recovered turn',
          );
          const { userMessageId } = await bounded(sending, 'the send');
          await turn.emitText('recovered output');
          await bounded(current.host.drain(), 'drain recovered output');
          const beforeCompletion = turnLifecycle(current, userMessageId);
          await turn.complete();
          await advanceUntil(
            current,
            () => latestRuntime(current)?.status === 'completed',
            'the recovered turn to complete',
          );
          observation = {
            prompt: turn.prompt.includes('D8 stalled start'),
            workers: current.harness.recorder.events.filter(
              (event) =>
                event.kind === 'provider' && event.type === 'client:initialize',
            ).length,
            threadStarts: clientRequests(current, 'thread/start').length,
            turnStarts: clientRequests(current, 'turn/start').length,
            endsBeforeCompletion: beforeCompletion.ends,
            lifecycle: turnLifecycle(current, userMessageId),
            failures: resultErrorEvents(notedEvents.mock.calls),
            runtime: {
              status: latestRuntime(current)?.status,
              error: latestRuntime(current)?.error,
            },
            failedTransitions: failedTransitions(current),
            outcome: await turnOutcome(current.target, userMessageId),
          };
        } finally {
          if (!env) jest.restoreAllMocks();
          try {
            if (env) await bounded(disposeScenario(env), 'dispose', 30_000);
          } finally {
            jest.useRealTimers();
          }
        }

        expect(observation).toEqual({
          prompt: true,
          // The stalled worker was replaced and thread/start retried once on
          // a fresh one; the user's input was sent once.
          workers: 2,
          threadStarts: 2,
          turnStarts: 1,
          endsBeforeCompletion: [],
          lifecycle: {
            starts: [
              {
                turnId: anyString,
                origin: 'user',
                userMessageIds: [anyString],
              },
            ],
            ends: [
              {
                turnId: anyString,
                outcome: 'completed',
                source: 'turn-completed',
              },
            ],
          },
          failures: [],
          runtime: { status: 'completed', error: undefined },
          failedTransitions: 0,
          outcome: 'completed',
        });
      },
      SCENARIO_TEST_TIMEOUT_MS * 2,
    );

    it(
      'ends a turn whose recovery timed out again once, failed and marked, then retries it as a new admitted turn',
      async () => {
        const observation = await runFailedRecovery();

        expect(observation.failure).toEqual({
          // Recovery ran first: the stalled worker was replaced once, and the
          // second timeout surfaced instead of recycling again. The input was
          // never sent (no turn/start), so the retry may resend it.
          workers: 2,
          turnStarts: 0,
          terminals: [
            {
              canopy_turn_user_message_id: 'failed',
              subtype: 'codex_error',
              codex_error_code: 'app_server_request_timeout',
              codex_error_method: 'thread/start',
            },
          ],
          // No native turn ever started, so there is no lost turn to end.
          lifecycle: { starts: [], ends: [] },
          runtime: { status: 'failed', retryable: true },
          failedTransitions: 1,
        });
        expect(observation.retry).toEqual({
          prompt: true,
          // The retry is a new send under a new user message id, through
          // the chat queue and its dispatch authorization.
          submitted: [
            {
              userMessageId: 'failed',
              origin: 'portal',
              initiationSource: 'user',
            },
            {
              userMessageId: 'retry',
              origin: 'portal',
              initiationSource: 'automation',
            },
          ],
          authorizations: [
            { userMessageId: 'failed', kind: 'authorized' },
            { userMessageId: 'retry', kind: 'authorized' },
          ],
          // A fresh user turn, never a restart or revival of the failed one.
          retryLifecycle: {
            starts: [
              {
                turnId: anyString,
                origin: 'user',
                userMessageIds: ['retry'],
              },
            ],
            ends: [
              {
                turnId: anyString,
                outcome: 'completed',
                source: 'turn-completed',
              },
            ],
          },
          failedLifecycle: { starts: [], ends: [] },
          terminals: 1,
          retryOutcome: 'completed',
          retryEntries: 0,
        });
      },
      SCENARIO_TEST_TIMEOUT_MS * 2,
    );

    it(
      "reports a failed recovery's turn as failed in turnOutcome, as its runtime does",
      async () => {
        const observation = await runFailedRecovery();

        expect(observation.failedRecord).toEqual({
          runtimeStatus: 'failed',
          lastAccepted: 'failed',
          turnEnd: 'failed',
          outcome: 'failed',
          outcomeAfterRetry: 'failed',
        });
      },
      SCENARIO_TEST_TIMEOUT_MS * 2,
    );

    it(
      "ends a bystander's turn once, failed and marked, when its shared-restart recovery fails, then retries it as a new admitted turn",
      async () => {
        const observation = await runSharedRestartRecoveryFailure();

        expect(observation.failure).toEqual({
          startedBeforeRestart: 1,
          // Recovery ran first, within its bound, before the turn ended.
          recoveryResumes: RECOVERY_RESUME_ATTEMPTS,
          terminals: [
            {
              canopy_turn_user_message_id: 'failed',
              subtype: 'codex_error',
              codex_error_code: 'app_server_shared_restart',
              codex_error_method: undefined,
            },
          ],
          // The lost turn ends canonically once, from the session's terminal
          // (35c4c): its native turn/completed never arrived.
          lifecycle: {
            starts: [
              {
                turnId: anyString,
                origin: 'user',
                userMessageIds: [anyString],
              },
            ],
            ends: [
              {
                turnId: anyString,
                outcome: 'failed',
                source: 'result',
              },
            ],
          },
          runtime: { status: 'failed', retryable: true },
          failedTransitions: 1,
        });
        expect(observation.failedRecord).toEqual({
          runtimeStatus: 'failed',
          lastAccepted: 'failed',
          turnEnd: 'failed',
          outcome: 'failed',
          outcomeAfterRetry: 'failed',
        });
        expect(observation.retry).toEqual({
          submitted: [
            {
              userMessageId: 'failed',
              origin: 'portal',
              initiationSource: 'user',
            },
            {
              userMessageId: 'retry',
              origin: 'portal',
              initiationSource: 'automation',
            },
          ],
          authorizations: [
            { userMessageId: 'failed', kind: 'authorized' },
            { userMessageId: 'retry', kind: 'authorized' },
          ],
          retryLifecycle: {
            starts: [
              {
                turnId: anyString,
                origin: 'user',
                userMessageIds: ['retry'],
              },
            ],
            ends: [
              {
                turnId: anyString,
                outcome: 'completed',
                source: 'turn-completed',
              },
            ],
          },
          // The ended turn is never revived: no later start names it.
          failedLifecycle: {
            starts: [
              {
                turnId: anyString,
                origin: 'user',
                userMessageIds: ['failed'],
              },
            ],
            ends: [
              {
                turnId: anyString,
                outcome: 'failed',
                source: 'result',
              },
            ],
          },
          terminals: 1,
          retryOutcome: 'completed',
          retryEntries: 0,
        });
      },
      SCENARIO_TEST_TIMEOUT_MS * 2,
    );
  });
}
