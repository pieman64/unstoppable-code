/** Real-host Codex root lifecycle incident regressions. */
import type {
  ChatRuntimeState,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type { PipelineTraceEvent, ProviderTraceEvent } from './contracts';
import {
  createScenarioEnvironment,
  disposeScenario,
  SCENARIO_TEST_TIMEOUT_MS,
  startRoot,
} from './scenarios';

type CodexRootEnvironment = Awaited<
  ReturnType<typeof createScenarioEnvironment>
>;

const ORIGINAL_FATAL_DETAIL =
  'Codex root fatal detail must survive the matching failed completion';
const COMPLETION_ERROR_DETAIL = 'Scripted Codex turn failed';
const CHILD_THREAD_ID = 'incident-codex-root-child-thread';

interface RootSnapshot {
  runtime: ChatRuntimeState | undefined;
  foreground: boolean | null;
  background: boolean | null;
  sessionTurnActive: boolean | null;
  queueTurnActive: boolean | null;
  openTimerCount: number;
  settledTimerCount: number;
  errorNotices: readonly string[];
}

function isTarget(
  env: CodexRootEnvironment,
  event: PipelineTraceEvent,
): boolean {
  if (event.kind === 'revision') {
    return (
      event.projectId === env.target.projectId &&
      event.worktreeId === env.target.worktreeId
    );
  }
  if (event.kind === 'queue') {
    return (
      event.event.projectId === env.target.projectId &&
      event.event.worktreeId === env.target.worktreeId &&
      event.event.chatId === env.target.chatId
    );
  }
  if (event.kind === 'checkpoint' || event.kind === 'transcript') {
    return (
      event.target?.projectId === env.target.projectId &&
      event.target.worktreeId === env.target.worktreeId &&
      event.target.chatId === env.target.chatId
    );
  }
  return (
    event.target?.projectId === env.target.projectId &&
    event.target?.worktreeId === env.target.worktreeId &&
    event.target?.chatId === env.target.chatId
  );
}

function latestRevision(
  env: CodexRootEnvironment,
): Extract<PipelineTraceEvent, { kind: 'revision' }> | undefined {
  return [...env.harness.recorder.events]
    .reverse()
    .find(
      (event): event is Extract<PipelineTraceEvent, { kind: 'revision' }> =>
        event.kind === 'revision' && isTarget(env, event),
    );
}

function textOf(row: PersistedChatMessage): string {
  return row.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

async function snapshot(
  env: CodexRootEnvironment,
  label: string,
): Promise<RootSnapshot> {
  await env.harness.checkpoint(label, env.target);
  const revision = latestRevision(env);
  const rows = revision?.chats[env.target.chatId]?.rows ?? [];
  const timerBlocks = rows.flatMap((row) =>
    row.blocks.filter((block) => block.type === 'turn_timer'),
  );
  const checkpoint = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'checkpoint' &&
        isTarget(env, event) &&
        event.label === label,
    );
  return {
    runtime: revision?.chats[env.target.chatId]?.runtime,
    foreground:
      checkpoint?.kind === 'checkpoint'
        ? (checkpoint.liveness?.foreground ?? null)
        : null,
    background:
      checkpoint?.kind === 'checkpoint'
        ? (checkpoint.liveness?.background ?? null)
        : null,
    sessionTurnActive:
      checkpoint?.kind === 'checkpoint'
        ? (checkpoint.sessionTurnActive ?? null)
        : null,
    queueTurnActive:
      checkpoint?.kind === 'checkpoint'
        ? (checkpoint.queueTurnActive ?? null)
        : null,
    openTimerCount: timerBlocks.filter(
      (block) => block.type === 'turn_timer' && block.completedAt === null,
    ).length,
    settledTimerCount: timerBlocks.filter(
      (block) => block.type === 'turn_timer' && block.completedAt !== null,
    ).length,
    errorNotices: rows
      .filter(
        (row) => row.role === 'system' && textOf(row).startsWith('Error:'),
      )
      .map(textOf),
  };
}

function providerFrames(
  env: CodexRootEnvironment,
  turnKey: string,
  type: string,
): ProviderTraceEvent[] {
  return env.harness.recorder.events.filter(
    (event): event is ProviderTraceEvent =>
      event.kind === 'provider' &&
      event.direction === 'to-canopy' &&
      event.type === type &&
      event.turnKey === turnKey &&
      isTarget(env, event),
  );
}

function queueReleaseCount(env: CodexRootEnvironment): number {
  const queueEvents = env.harness.recorder.events.filter(
    (event): event is Extract<PipelineTraceEvent, { kind: 'queue' }> =>
      event.kind === 'queue' && isTarget(env, event),
  );
  let previous: boolean | undefined;
  let releases = 0;
  for (const event of queueEvents) {
    if (previous === true && event.turnActive === false) releases += 1;
    if (event.turnActive !== undefined) previous = event.turnActive;
  }
  return releases;
}

function failedRuntimeTransitionCount(env: CodexRootEnvironment): number {
  let previousStatus: ChatRuntimeState['status'] | undefined;
  let transitions = 0;
  for (const event of env.harness.recorder.events) {
    if (event.kind !== 'revision' || !isTarget(env, event)) continue;
    const status = event.chats[env.target.chatId]?.runtime?.status;
    if (status === 'failed' && previousStatus !== 'failed') transitions += 1;
    if (status !== undefined) previousStatus = status;
  }
  return transitions;
}

export function registerCodexRootIncidentTests(): void {
  describe('Codex root lifecycle', () => {
    it(
      'does not settle a fatal root error until its matching failed completion',
      async () => {
        const env = await createScenarioEnvironment('worktree', 'codex');
        let before: RootSnapshot | undefined;
        let after: RootSnapshot | undefined;
        let completionWasHeld = false;
        let completionFramesBeforeRelease = -1;
        let matchingErrorFrames = -1;
        let matchingCompletionFrames = -1;
        let failedRuntimeTransitionsBeforeCompletion = -1;
        let failedRuntimeTransitionsAfterCompletion = -1;
        let releasesBeforeCompletion = -1;
        let releasesAfterCompletion = -1;
        try {
          const root = await startRoot(env, 'Codex fatal root lifecycle');
          await root.emitError?.({
            message: ORIGINAL_FATAL_DETAIL,
            willRetry: false,
          });
          await env.host.drain();

          root.hold();
          let completionFinished = false;
          const completing = root.complete({ isError: true }).finally(() => {
            completionFinished = true;
          });
          await env.host.drain();
          before = await snapshot(env, 'codex-root-before-failed-completion');
          completionWasHeld = !completionFinished;
          completionFramesBeforeRelease = providerFrames(
            env,
            root.turnKey,
            'notification:turn/completed',
          ).length;
          matchingErrorFrames = providerFrames(
            env,
            root.turnKey,
            'notification:error',
          ).length;
          failedRuntimeTransitionsBeforeCompletion =
            failedRuntimeTransitionCount(env);
          releasesBeforeCompletion = queueReleaseCount(env);

          await root.release();
          await completing;
          await env.host.drain();
          after = await snapshot(env, 'codex-root-after-failed-completion');
          matchingCompletionFrames = providerFrames(
            env,
            root.turnKey,
            'notification:turn/completed',
          ).length;
          failedRuntimeTransitionsAfterCompletion =
            failedRuntimeTransitionCount(env);
          releasesAfterCompletion = queueReleaseCount(env);
        } finally {
          await disposeScenario(env);
        }

        expect({
          completionWasHeld,
          completionFramesBeforeRelease,
          matchingErrorFrames,
          before: before && {
            status: before.runtime?.status,
            hasActiveTurn: before.runtime?.activeTurn !== undefined,
            foreground: before.foreground,
            sessionTurnActive: before.sessionTurnActive,
            queueTurnActive: before.queueTurnActive,
            openTimerCount: before.openTimerCount,
            settledTimerCount: before.settledTimerCount,
            errorNotices: before.errorNotices,
            releases: releasesBeforeCompletion,
          },
          matchingCompletionFrames,
          after: after && {
            status: after.runtime?.status,
            hasActiveTurn: after.runtime?.activeTurn !== undefined,
            foreground: after.foreground,
            sessionTurnActive: after.sessionTurnActive,
            queueTurnActive: after.queueTurnActive,
            openTimerCount: after.openTimerCount,
            settledTimerCount: after.settledTimerCount,
            errorNotices: after.errorNotices,
          },
          failedRuntimeTransitionsBeforeCompletion,
          failedRuntimeTransitionsAfterCompletion,
          releasesAfterCompletion,
        }).toEqual({
          completionWasHeld: true,
          completionFramesBeforeRelease: 0,
          matchingErrorFrames: 1,
          before: {
            status: 'streaming',
            hasActiveTurn: true,
            foreground: true,
            sessionTurnActive: true,
            queueTurnActive: true,
            openTimerCount: 1,
            settledTimerCount: 0,
            errorNotices: [],
            releases: 0,
          },
          matchingCompletionFrames: 1,
          after: {
            status: 'failed',
            hasActiveTurn: false,
            foreground: false,
            sessionTurnActive: false,
            queueTurnActive: false,
            openTimerCount: 0,
            settledTimerCount: 1,
            errorNotices: [`Error: ${ORIGINAL_FATAL_DETAIL}`],
          },
          failedRuntimeTransitionsBeforeCompletion: 0,
          failedRuntimeTransitionsAfterCompletion: 1,
          releasesAfterCompletion: 1,
        });
        expect(after?.errorNotices).not.toContain(
          `Error: ${COMPLETION_ERROR_DETAIL}`,
        );
      },
      SCENARIO_TEST_TIMEOUT_MS,
    );

    it(
      'keeps retry errors and root or child thread-status updates from settling the root',
      async () => {
        const env = await createScenarioEnvironment('worktree', 'codex');
        let rootTurnKey = '';
        const guardSnapshots: RootSnapshot[] = [];
        let retryErrorFrames: ProviderTraceEvent[] = [];
        let statusFrames: ProviderTraceEvent[] = [];
        let childStatusFrames: ProviderTraceEvent[] = [];
        let finalSnapshot: RootSnapshot | undefined;
        try {
          const root = await startRoot(env, 'Codex nonterminal root lifecycle');
          rootTurnKey = root.turnKey;

          await root.emitError?.({
            message: 'Codex retryable root error',
            willRetry: true,
          });
          await env.host.drain();
          guardSnapshots.push(
            await snapshot(env, 'codex-root-after-retryable-error'),
          );

          await root.emitThreadStatus?.({ status: 'active' });
          await env.host.drain();
          guardSnapshots.push(await snapshot(env, 'codex-root-after-active'));

          await root.emitThreadStatus?.({ status: 'waitingOnApproval' });
          await env.host.drain();
          // The pending decision commits through the turn handoff's fallback
          // (a wall-clock timer here); no provider event follows it.
          const ownership = (
            await import('../../services/chat-turn-ownership')
          ).getChatTurnOwnership();
          for (
            let waitedMs = 0;
            ownership.getSnapshot(env.target).committed?.state
              .decisionPending !== true && waitedMs < 5_000;
            waitedMs += 50
          )
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          guardSnapshots.push(
            await snapshot(env, 'codex-root-after-waiting-approval'),
          );

          await root.emitThreadStatus?.({ status: 'idle' });
          await env.host.drain();
          guardSnapshots.push(await snapshot(env, 'codex-root-after-idle'));

          await root.startNativeTask({
            taskId: CHILD_THREAD_ID,
            toolUseId: 'incident-codex-root-child-tool',
            kind: 'agent',
          });
          await root.emitThreadStatus?.({ status: 'active', child: true });
          await env.host.drain();
          guardSnapshots.push(
            await snapshot(env, 'codex-root-after-child-active'),
          );
          await root.emitThreadStatus?.({ status: 'idle', child: true });
          await env.host.drain();
          guardSnapshots.push(
            await snapshot(env, 'codex-root-after-child-idle'),
          );
          await root.endNativeTask(CHILD_THREAD_ID, 'completed');
          await root.complete();
          await env.host.drain();
          finalSnapshot = await snapshot(
            env,
            'codex-root-after-normal-completion',
          );

          retryErrorFrames = providerFrames(
            env,
            rootTurnKey,
            'notification:error',
          );
          statusFrames = providerFrames(
            env,
            rootTurnKey,
            'notification:thread/status/changed',
          );
          childStatusFrames = statusFrames.filter(
            (event) => event.ids?.taskId === CHILD_THREAD_ID,
          );
        } finally {
          await disposeScenario(env);
        }

        expect({
          retryErrorFrames: retryErrorFrames.map((event) => ({
            type: event.type,
            target: event.target,
            turnKey: event.turnKey,
          })),
          statusFrames: statusFrames.map((event) => ({
            type: event.type,
            target: event.target,
            turnKey: event.turnKey,
            taskId: event.ids?.taskId,
          })),
          childStatusFrames: childStatusFrames.length,
          guardStates: guardSnapshots.map((state) => ({
            status: state.runtime?.status,
            hasActiveTurn: state.runtime?.activeTurn !== undefined,
            foreground: state.foreground,
            sessionTurnActive: state.sessionTurnActive,
            queueTurnActive: state.queueTurnActive,
            openTimerCount: state.openTimerCount,
            settledTimerCount: state.settledTimerCount,
            errorNotices: state.errorNotices,
          })),
          finalStatus: finalSnapshot?.runtime?.status,
        }).toEqual({
          retryErrorFrames: [
            {
              type: 'notification:error',
              target: env.target,
              turnKey: rootTurnKey,
            },
          ],
          statusFrames: [
            {
              type: 'notification:thread/status/changed',
              target: env.target,
              turnKey: rootTurnKey,
              taskId: undefined,
            },
            {
              type: 'notification:thread/status/changed',
              target: env.target,
              turnKey: rootTurnKey,
              taskId: undefined,
            },
            {
              type: 'notification:thread/status/changed',
              target: env.target,
              turnKey: rootTurnKey,
              taskId: undefined,
            },
            {
              type: 'notification:thread/status/changed',
              target: env.target,
              turnKey: rootTurnKey,
              taskId: CHILD_THREAD_ID,
            },
            {
              type: 'notification:thread/status/changed',
              target: env.target,
              turnKey: rootTurnKey,
              taskId: CHILD_THREAD_ID,
            },
          ],
          childStatusFrames: 2,
          // A root approval wait shows awaiting input until the thread runs
          // again; `idle` is a turn-over signal and doesn't clear it (phase
          // 35c4d decision).
          guardStates: Array.from({ length: 6 }, (_, index) => ({
            status: index < 2 ? 'streaming' : 'awaiting_input',
            hasActiveTurn: true,
            foreground: true,
            sessionTurnActive: true,
            queueTurnActive: true,
            openTimerCount: 1,
            settledTimerCount: 0,
            errorNotices: [],
          })),
          finalStatus: 'completed',
        });
      },
      SCENARIO_TEST_TIMEOUT_MS,
    );
  });
}
