/** Real-host Codex background-task lifecycle incident regressions. */
import type {
  ChatRuntimeState,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import type {
  PipelineChatTarget,
  PipelineTraceEvent,
  ProviderTraceEvent,
} from './contracts';
import type * as SessionManagerModule from '../../agents/session-manager';
import {
  createScenarioEnvironment,
  disposeScenario,
  SCENARIO_TEST_TIMEOUT_MS,
  startRoot,
} from './scenarios';
import {
  configureScriptedCodexBackgroundTerminals,
  emitScriptedCodexCommand,
  exitScriptedCodexUnexpectedly,
} from './scripted-codex';
import type { PipelineStorage } from './storage';

type CodexBackgroundEnvironment = Awaited<
  ReturnType<typeof createScenarioEnvironment>
>;
type SessionManager = typeof SessionManagerModule;

const BACKGROUND_AGENT_TASK_ID = 'codex-background-agent-child';
const BACKGROUND_AGENT_TOOL_USE_ID = 'codex-background-agent-tool-use';
const BACKGROUND_COMMAND_ITEM_ID = 'codex-background-command-item';
const BACKGROUND_COMMAND_PROCESS_ID = 'codex-background-process';
const BACKGROUND_COMMAND_OUTPUT = 'codex-background-terminal-completed-output';

// The test-level Jest deadline is the outer guard. Capture the native timer
// functions before the per-test fake-clock setup so each awaited host boundary
// also has a real-time bound.
const scheduleRealTimeout = globalThis.setTimeout.bind(globalThis);
const clearRealTimeout = globalThis.clearTimeout.bind(globalThis);

const storageByEnvironment = new WeakMap<
  CodexBackgroundEnvironment,
  PipelineStorage
>();

function bounded<T>(
  promise: Promise<T>,
  operation: string,
  timeoutMs = 5_000,
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

async function createCodexBackgroundEnvironment(): Promise<CodexBackgroundEnvironment> {
  let capturedStorage: PipelineStorage | undefined;
  const env = await createScenarioEnvironment('worktree', 'codex', {
    prepareStorage: (storage): Promise<void> => {
      capturedStorage = storage;
      return Promise.resolve();
    },
  });
  if (!capturedStorage)
    throw new Error('Codex background incident requires real V2 storage');
  storageByEnvironment.set(env, capturedStorage);
  return env;
}

function isTargetRevision(
  target: PipelineChatTarget,
  event: PipelineTraceEvent,
): event is Extract<PipelineTraceEvent, { kind: 'revision' }> {
  return (
    event.kind === 'revision' &&
    event.projectId === target.projectId &&
    event.worktreeId === target.worktreeId
  );
}

function latestRuntime(
  env: CodexBackgroundEnvironment,
): ChatRuntimeState | undefined {
  const revision = [...env.harness.recorder.events]
    .reverse()
    .find((event) => isTargetRevision(env.target, event));
  return revision?.kind === 'revision'
    ? revision.chats[env.target.chatId]?.runtime
    : undefined;
}

function latestRows(
  env: CodexBackgroundEnvironment,
): readonly PersistedChatMessage[] | undefined {
  const revision = [...env.harness.recorder.events]
    .reverse()
    .find((event) => isTargetRevision(env.target, event));
  return revision?.kind === 'revision'
    ? revision.chats[env.target.chatId]?.rows
    : undefined;
}

function providerFrames(env: CodexBackgroundEnvironment): ProviderTraceEvent[] {
  return env.harness.recorder.events.filter(
    (event): event is ProviderTraceEvent =>
      event.kind === 'provider' &&
      event.provider === 'codex' &&
      event.target.projectId === env.target.projectId &&
      event.target.worktreeId === env.target.worktreeId &&
      event.target.chatId === env.target.chatId,
  );
}

function countProviderFrames(
  env: CodexBackgroundEnvironment,
  direction: ProviderTraceEvent['direction'],
  type: string,
): number {
  return providerFrames(env).filter(
    (event) => event.direction === direction && event.type === type,
  ).length;
}

function rootSettlementCount(env: CodexBackgroundEnvironment): number {
  let rootWasActive = false;
  let settlements = 0;
  for (const event of env.harness.recorder.events) {
    if (!isTargetRevision(env.target, event)) continue;
    const runtime = event.chats[env.target.chatId]?.runtime;
    if (runtime?.activeTurn !== undefined) rootWasActive = true;
    if (
      rootWasActive &&
      runtime?.status === 'completed' &&
      runtime.activeTurn === undefined
    ) {
      settlements += 1;
      rootWasActive = false;
    }
  }
  return settlements;
}

function liveTaskSnapshot(
  env: CodexBackgroundEnvironment,
  sessionManager: SessionManager,
): { count: number | null; types: (string | null)[] | null } {
  const tasks = sessionManager.getLiveBackgroundTasksForChat(
    env.target.projectId,
    env.target.worktreeId,
    env.target.chatId,
  );
  if (tasks === undefined) return { count: null, types: null };
  return {
    count: tasks.length,
    types: tasks.map((task) => task.taskType ?? null).sort(),
  };
}

function commandRow(
  rows: readonly PersistedChatMessage[] | undefined,
): PersistedChatMessage | undefined {
  return rows?.find((row) =>
    row.blocks.some((block) => block.type === 'tool_use'),
  );
}

function commandToolUseId(
  row: PersistedChatMessage | undefined,
): string | undefined {
  for (const block of row?.blocks ?? []) {
    if (block.type === 'tool_use') return block.toolUseId;
  }
  return undefined;
}

function commandToolResults(
  rows: readonly PersistedChatMessage[] | undefined,
  toolUseId: string | undefined,
): Array<{ messageId: string; output: string; isError: boolean }> {
  if (!toolUseId) return [];
  return (rows ?? []).flatMap((row) =>
    row.blocks.flatMap((block) =>
      block.type === 'tool_result' && block.toolUseId === toolUseId
        ? [{ messageId: row.id, output: block.output, isError: block.isError }]
        : [],
    ),
  );
}

async function setShortSessionIdleTimeout(
  sessionManager: SessionManager,
): Promise<void> {
  await bounded(
    Promise.resolve().then(() =>
      sessionManager.updateCodexSessionIdleTimeoutMinutes(1),
    ),
    'set one-minute Codex app-server idle timeout',
  );
}

async function advanceIdleTimeout(): Promise<void> {
  const idleTimeoutMs = 60_000;
  await bounded(
    jest.advanceTimersByTimeAsync(idleTimeoutMs),
    'advance Codex app-server idle timeout',
  );
}

async function probeUntil(
  env: CodexBackgroundEnvironment,
  predicate: (current: CodexBackgroundEnvironment) => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<boolean> {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 25) {
    await bounded(env.host.drain(), `${description}: host drain`);
    if (predicate(env)) return true;
    await bounded(
      new Promise<void>((resolve) => setImmediate(resolve)),
      `${description}: event-loop turn`,
    );
    await bounded(
      jest.advanceTimersByTimeAsync(25),
      `${description}: advance short clock slice`,
    );
  }
  await bounded(env.host.drain(), `${description}: final host drain`);
  return predicate(env);
}

async function pumpUntilSessionIdle(
  env: CodexBackgroundEnvironment,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 25) {
    await bounded(env.host.drain(), `${description}: host drain`);
    await bounded(
      env.harness.checkpoint('codex-background-session-idle', env.target),
      `${description}: session checkpoint`,
    );
    const checkpoint = env.harness.recorder.events.at(-1);
    if (
      checkpoint?.kind === 'checkpoint' &&
      checkpoint.sessionTurnActive === false
    ) {
      return;
    }
    await bounded(
      new Promise<void>((resolve) => setImmediate(resolve)),
      `${description}: event-loop turn`,
    );
    await bounded(
      jest.advanceTimersByTimeAsync(25),
      `${description}: advance short clock slice`,
    );
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function makeBackgroundTerminal(data: { itemId: string; processId: string }): {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
} {
  return {
    ...data,
    command: 'scripted background command',
    cwd: '/tmp/scripted-codex-background',
    osPid: null,
    cpuPercent: null,
    rssKb: null,
  };
}

function configureBackgroundTerminalList(
  env: CodexBackgroundEnvironment,
  data: readonly ReturnType<typeof makeBackgroundTerminal>[],
): void {
  configureScriptedCodexBackgroundTerminals(env.driver, {
    listPages: [{ cursor: null, data, nextCursor: null }],
  });
}

function rootIsCompleted(env: CodexBackgroundEnvironment): boolean {
  const runtime = latestRuntime(env);
  return runtime?.status === 'completed' && runtime.activeTurn === undefined;
}

function countRootCompletionFrames(
  env: CodexBackgroundEnvironment,
  rootTurnKey: string,
): number {
  return providerFrames(env).filter(
    (event) =>
      event.direction === 'to-canopy' &&
      event.type === 'notification:turn/completed' &&
      event.turnKey === rootTurnKey,
  ).length;
}

export function registerCodexBackgroundIncidentTests(): void {
  describe('Codex background task lifecycle', () => {
    it(
      'holds the idle app-server client until a completed root child drains',
      async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        let env: CodexBackgroundEnvironment | undefined;
        try {
          env = await bounded(
            createCodexBackgroundEnvironment(),
            'create Codex child-task scenario',
            60_000,
          );
          const sessionManager = await bounded(
            import('../../agents/session-manager'),
            'load live session manager',
          );
          const { CodexAppServerClient } = await bounded(
            import('../../codex/app-server-client'),
            'load Codex app-server client',
          );
          const clientDisposeSpy = jest.spyOn(
            CodexAppServerClient.prototype,
            'dispose',
          );
          const root = await bounded(
            startRoot(env, 'Codex background child root'),
            'start Codex root turn',
            15_000,
          );
          await bounded(
            root.startNativeTask({
              taskId: BACKGROUND_AGENT_TASK_ID,
              toolUseId: BACKGROUND_AGENT_TOOL_USE_ID,
              kind: 'agent',
            }),
            'start Codex native agent task',
          );
          await bounded(env.host.drain(), 'drain live child task');
          await bounded(root.complete(), 'complete Codex root turn');
          await bounded(env.host.drain(), 'drain completed root turn');
          await pumpUntilSessionIdle(env, 'completed root session idle');

          const rootCompleted = rootIsCompleted(env);
          const tasksWhileChildLive = liveTaskSnapshot(env, sessionManager);
          const clientDisposalsWhileChildLive =
            clientDisposeSpy.mock.calls.length;
          await setShortSessionIdleTimeout(sessionManager);
          await advanceIdleTimeout();
          await bounded(env.host.drain(), 'drain after idle timeout');
          const clientDisposalsAfterIdleTimeout =
            clientDisposeSpy.mock.calls.length;
          const tasksAfterIdleTimeout = liveTaskSnapshot(env, sessionManager);

          let childCompletionDelivered = false;
          try {
            await bounded(
              root.endNativeTask(BACKGROUND_AGENT_TASK_ID, 'completed'),
              'finish child after root settlement',
            );
            childCompletionDelivered = true;
          } catch {
            // If the host unsubscribed while the child was live, the fake
            // process can no longer emit the provider-owned terminal. Record
            // that lost completion in the intended red observation below.
          }
          await bounded(env.host.drain(), 'drain child completion');
          const tasksAfterChildCompletion = liveTaskSnapshot(
            env,
            sessionManager,
          );
          await setShortSessionIdleTimeout(sessionManager);
          await advanceIdleTimeout();
          await bounded(env.host.drain(), 'drain after child idle timeout');
          const clientDisposalsAfterChildCompletion =
            clientDisposeSpy.mock.calls.length;

          expect({
            rootCompleted,
            tasksWhileChildLive,
            tasksAfterIdleTimeout,
            clientDisposalsWhileChildLive,
            clientDisposalsAfterIdleTimeout,
            childCompletionDelivered,
            tasksAfterChildCompletion,
            clientDisposalsAfterChildCompletion,
            rootStarts: countProviderFrames(
              env,
              'to-provider',
              'client:turn/start',
            ),
            rootCompletionFrames: countRootCompletionFrames(env, root.turnKey),
            rootSettlements: rootSettlementCount(env),
          }).toEqual({
            rootCompleted: true,
            tasksWhileChildLive: { count: 1, types: ['local_agent'] },
            tasksAfterIdleTimeout: { count: 1, types: ['local_agent'] },
            clientDisposalsWhileChildLive: 0,
            clientDisposalsAfterIdleTimeout: 0,
            childCompletionDelivered: true,
            tasksAfterChildCompletion: { count: 0, types: [] },
            clientDisposalsAfterChildCompletion: 1,
            rootStarts: 1,
            rootCompletionFrames: 1,
            rootSettlements: 1,
          });
        } finally {
          if (!env) jest.restoreAllMocks();
          try {
            if (env)
              await bounded(
                disposeScenario(env),
                'dispose Codex child scenario',
              );
          } finally {
            jest.useRealTimers();
          }
        }
      },
      SCENARIO_TEST_TIMEOUT_MS * 2,
    );

    it(
      'keeps a listed local shell live through root idle and commits its late result on the original command row',
      async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        let env: CodexBackgroundEnvironment | undefined;
        try {
          env = await bounded(
            createCodexBackgroundEnvironment(),
            'create Codex terminal scenario',
            60_000,
          );
          const sessionManager = await bounded(
            import('../../agents/session-manager'),
            'load live session manager',
          );
          const { CodexAppServerClient } = await bounded(
            import('../../codex/app-server-client'),
            'load Codex app-server client',
          );
          const clientDisposeSpy = jest.spyOn(
            CodexAppServerClient.prototype,
            'dispose',
          );
          configureBackgroundTerminalList(env, [
            makeBackgroundTerminal({
              itemId: BACKGROUND_COMMAND_ITEM_ID,
              processId: BACKGROUND_COMMAND_PROCESS_ID,
            }),
          ]);
          const root = await bounded(
            startRoot(env, 'Codex background terminal root'),
            'start Codex terminal root turn',
            15_000,
          );
          await bounded(
            emitScriptedCodexCommand(env.driver, root.turnKey, {
              itemId: BACKGROUND_COMMAND_ITEM_ID,
              processId: BACKGROUND_COMMAND_PROCESS_ID,
              output: 'background command still running',
            }),
            'emit live Codex command item',
          );
          await bounded(env.host.drain(), 'drain live Codex command item');
          const originalCommandRow = commandRow(latestRows(env));
          const originalCommandToolUseId = commandToolUseId(originalCommandRow);

          await bounded(root.complete(), 'complete Codex terminal root turn');
          await bounded(env.host.drain(), 'drain completed terminal root');
          await pumpUntilSessionIdle(env, 'completed terminal session idle');
          const rootCompleted = rootIsCompleted(env);
          const localShellWasObserved = await probeUntil(
            env,
            (current) =>
              liveTaskSnapshot(current, sessionManager).types?.includes(
                'local_bash',
              ) ?? false,
            'listed Codex local shell task',
          );
          const tasksWhileTerminalLive = liveTaskSnapshot(env, sessionManager);
          const clientDisposalsWhileTerminalLive =
            clientDisposeSpy.mock.calls.length;

          await setShortSessionIdleTimeout(sessionManager);
          await advanceIdleTimeout();
          await bounded(env.host.drain(), 'drain after terminal idle timeout');
          const clientDisposalsAfterIdleTimeout =
            clientDisposeSpy.mock.calls.length;
          const tasksAfterIdleTimeout = liveTaskSnapshot(env, sessionManager);

          configureBackgroundTerminalList(env, []);
          let lateCommandCompletionDelivered = false;
          try {
            await bounded(
              emitScriptedCodexCommand(env.driver, root.turnKey, {
                itemId: BACKGROUND_COMMAND_ITEM_ID,
                processId: BACKGROUND_COMMAND_PROCESS_ID,
                output: BACKGROUND_COMMAND_OUTPUT,
                completed: true,
              }),
              'emit late Codex command completion',
            );
            lateCommandCompletionDelivered = true;
          } catch {
            // A client retired while the terminal was live cannot deliver its
            // late native result. Keep the reproduction focused on the lost
            // provider completion and absent durable tool result.
          }
          await bounded(env.host.drain(), 'drain late command completion');
          const tasksDrainedAfterCompletion = await probeUntil(
            env,
            (current) => liveTaskSnapshot(current, sessionManager).count === 0,
            'Codex local shell task drain',
          );
          await setShortSessionIdleTimeout(sessionManager);
          await advanceIdleTimeout();
          await bounded(env.host.drain(), 'drain after terminal task drain');
          const clientDisposalsAfterCompletion =
            clientDisposeSpy.mock.calls.length;

          const rowsAfterCompletion = latestRows(env);
          const toolResults = commandToolResults(
            rowsAfterCompletion,
            originalCommandToolUseId,
          );
          const storage = storageByEnvironment.get(env);
          const durableText = storage
            ?.readCommittedTranscript(env.target)
            .toString('utf8');

          expect({
            rootCompleted,
            originalCommandRowCaptured: originalCommandRow !== undefined,
            localShellWasObserved,
            tasksWhileTerminalLive,
            tasksAfterIdleTimeout,
            clientDisposalsWhileTerminalLive,
            clientDisposalsAfterIdleTimeout,
            lateCommandCompletionDelivered,
            toolResults: toolResults.map((result) => ({
              anchoredToOriginalCommand:
                result.messageId === originalCommandRow?.id,
              output: result.output,
              isError: result.isError,
            })),
            durableOutput: durableText?.includes(BACKGROUND_COMMAND_OUTPUT),
            tasksDrainedAfterCompletion,
            tasksAfterCompletion: liveTaskSnapshot(env, sessionManager),
            clientDisposalsAfterCompletion,
            rootStarts: countProviderFrames(
              env,
              'to-provider',
              'client:turn/start',
            ),
            rootCompletionFrames: countRootCompletionFrames(env, root.turnKey),
            rootSettlements: rootSettlementCount(env),
          }).toEqual({
            rootCompleted: true,
            originalCommandRowCaptured: true,
            localShellWasObserved: true,
            tasksWhileTerminalLive: { count: 1, types: ['local_bash'] },
            tasksAfterIdleTimeout: { count: 1, types: ['local_bash'] },
            clientDisposalsWhileTerminalLive: 0,
            clientDisposalsAfterIdleTimeout: 0,
            lateCommandCompletionDelivered: true,
            toolResults: [
              {
                anchoredToOriginalCommand: true,
                output: BACKGROUND_COMMAND_OUTPUT,
                isError: false,
              },
            ],
            durableOutput: true,
            tasksDrainedAfterCompletion: true,
            tasksAfterCompletion: { count: 0, types: [] },
            clientDisposalsAfterCompletion: 1,
            rootStarts: 1,
            rootCompletionFrames: 1,
            rootSettlements: 1,
          });
        } finally {
          if (!env) jest.restoreAllMocks();
          try {
            if (env)
              await bounded(
                disposeScenario(env),
                'dispose Codex terminal scenario',
              );
          } finally {
            jest.useRealTimers();
          }
        }
      },
      SCENARIO_TEST_TIMEOUT_MS * 2,
    );

    it(
      'drains live Codex child tasks on unexpected app-server loss without reviving the completed root',
      async () => {
        let env: CodexBackgroundEnvironment | undefined;
        try {
          env = await bounded(
            createCodexBackgroundEnvironment(),
            'create Codex process-loss scenario',
            60_000,
          );
          const sessionManager = await bounded(
            import('../../agents/session-manager'),
            'load live session manager',
          );
          const root = await bounded(
            startRoot(env, 'Codex child process-loss root'),
            'start Codex process-loss root turn',
            15_000,
          );
          await bounded(
            root.startNativeTask({
              taskId: BACKGROUND_AGENT_TASK_ID,
              toolUseId: BACKGROUND_AGENT_TOOL_USE_ID,
              kind: 'agent',
            }),
            'start Codex process-loss child task',
          );
          await bounded(env.host.drain(), 'drain live process-loss child');
          await bounded(root.complete(), 'complete process-loss root turn');
          await bounded(env.host.drain(), 'drain completed process-loss root');
          await pumpUntilSessionIdle(
            env,
            'completed process-loss session idle',
          );
          const tasksBeforeExit = liveTaskSnapshot(env, sessionManager);
          const rootCompletedBeforeExit = rootIsCompleted(env);

          await bounded(
            exitScriptedCodexUnexpectedly(env.driver),
            'observe unexpected Codex app-server exit',
          );
          const tasksDrainedAfterExit = await probeUntil(
            env,
            (current) => liveTaskSnapshot(current, sessionManager).count === 0,
            'live Codex task drain after app-server loss',
          );

          expect({
            tasksBeforeExit,
            rootCompletedBeforeExit,
            tasksDrainedAfterExit,
            tasksAfterExit: liveTaskSnapshot(env, sessionManager),
            rootCompletedAfterExit: rootIsCompleted(env),
            rootStarts: countProviderFrames(
              env,
              'to-provider',
              'client:turn/start',
            ),
            rootCompletionFrames: countRootCompletionFrames(env, root.turnKey),
            rootSettlements: rootSettlementCount(env),
          }).toEqual({
            tasksBeforeExit: { count: 1, types: ['local_agent'] },
            rootCompletedBeforeExit: true,
            tasksDrainedAfterExit: true,
            tasksAfterExit: { count: 0, types: [] },
            rootCompletedAfterExit: true,
            rootStarts: 1,
            rootCompletionFrames: 1,
            rootSettlements: 1,
          });
        } finally {
          if (!env) jest.restoreAllMocks();
          if (env)
            await bounded(
              disposeScenario(env),
              'dispose Codex process-loss scenario',
            );
        }
      },
      SCENARIO_TEST_TIMEOUT_MS * 2,
    );
  });
}
