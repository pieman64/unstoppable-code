/** Real-host incident regressions composed from the scripted provider APIs. */
import type { ChatRuntimeState } from '@canopy/desktop-shared/types';
import type {
  PipelineChatTarget,
  PipelineHost,
  PipelineTraceEvent,
  PipelineProvider,
  ScriptedProviderTurn,
} from './pipeline-harness/contracts';
import { runCoreScenario } from './pipeline-harness/scenarios-core';
import {
  bindNextScriptedCodexThreadTarget,
  emitScriptedCodexCommand,
} from './pipeline-harness/scripted-codex';
import {
  emitCancelledResultOnNextScriptedClaudeAbort,
  emitScriptedClaudeAbortedStreamingResult,
  emitScriptedClaudeAssistantMessage,
  getScriptedClaudeAssistantCorrelations,
  getScriptedClaudeLiveNativeTaskIds,
  getScriptedClaudeResultObservations,
  holdNextScriptedClaudeInterruptReceipt,
} from './pipeline-harness/scripted-claude';
import { registerCuttlefishIncidentTests } from './pipeline-harness/incident-cuttlefish';
import { registerCodexRootIncidentTests } from './pipeline-harness/incident-codex-root';
import { registerCodexMergedStartIncidentTests } from './pipeline-harness/incident-codex-merge';
import { registerCodexBackgroundIncidentTests } from './pipeline-harness/incident-codex-background';
import { registerCodexResolvedIncidentTests } from './pipeline-harness/incident-codex-resolved';
import { registerCodexDelegatedResolvedIncidentTests } from './pipeline-harness/incident-codex-delegated-resolved';
import { registerCodexTransportIncidentTests } from './pipeline-harness/incident-codex-transport';
import {
  createScenarioEnvironment,
  disposeScenario,
  finishScenario,
  pumpUntil,
  SCENARIO_TEST_TIMEOUT_MS,
  startRoot,
} from './pipeline-harness/scenarios';
import {
  runMessageAndQuestionAnswerComposition,
  runRootEndGeneratedComposition,
  runWatcherMidTurnComposition,
} from './pipeline-harness/fixture-replay-compositions';
import {
  RAT_VARIANTS,
  runPortScenario,
} from './pipeline-harness/scenarios-ports';
import type { PipelineStorage } from './pipeline-harness/storage';
import { seedLatencyHistory } from './pipeline-harness/scenarios-latency';

type IncidentEnvironment = Awaited<
  ReturnType<typeof createScenarioEnvironment>
>;
const incidentStorage = new WeakMap<IncidentEnvironment, PipelineStorage>();
async function createIncidentEnvironment(
  ...args: Parameters<typeof createScenarioEnvironment>
): Promise<IncidentEnvironment> {
  let captured: PipelineStorage | undefined;
  const options = args[2] ?? {};
  const env = await createScenarioEnvironment(args[0], args[1], {
    ...options,
    prepareStorage: async (storage, target): Promise<void> => {
      captured = storage;
      await options.prepareStorage?.(storage, target);
    },
  });
  if (!captured) throw new Error('Incident requires real V2 storage');
  incidentStorage.set(env, captured);
  return env;
}
function traceText(
  env: IncidentEnvironment,
  target: PipelineChatTarget,
): string {
  const storage = incidentStorage.get(env);
  if (!storage) throw new Error('Missing incident storage capture');
  return storage.readCommittedTranscript(target).toString('utf8');
}

function latestRuntime(env: IncidentEnvironment): ChatRuntimeState | undefined {
  const revision = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'revision' &&
        event.chats[env.target.chatId]?.runtime !== undefined,
    );
  return revision?.kind === 'revision'
    ? revision.chats[env.target.chatId]?.runtime
    : undefined;
}

function isPerRowStopTaskApi(
  value: unknown,
): value is (
  projectId: string,
  worktreeId: string,
  chatId: string,
  taskId: string,
) => Promise<unknown> {
  return typeof value === 'function';
}

async function runHostStopFenceRace(newerWork: 'send' | 'wake'): Promise<void> {
  const env = await createIncidentEnvironment('worktree', 'claude');
  let receiptHold:
    | ReturnType<typeof holdNextScriptedClaudeInterruptReceipt>
    | undefined;
  let stopping: Promise<void> | undefined;
  let pendingDelivery: Promise<void> | undefined;
  try {
    const root = await startRoot(env, `stop fence ${newerWork} root`);
    const pendingSteer = env.host.deliverGenerated({
      kind: 'watcher',
      text: `stop fence ${newerWork} pending steer`,
      watcherId: `stop-fence-${newerWork}`,
      deliveryId: `stop-fence-${newerWork}`,
    });
    pendingDelivery = pendingSteer;
    const steer = await root.nextSteer({ timeoutMs: 5000 });
    expect(steer.text).toContain(`stop fence ${newerWork} pending steer`);

    receiptHold = holdNextScriptedClaudeInterruptReceipt(env.driver);
    emitCancelledResultOnNextScriptedClaudeAbort(env.driver);
    stopping = env.host.stop();
    await env.driver.nextInterrupt({ timeoutMs: 5000 });
    await receiptHold.entered;

    // The result is provider-owned and arrives while Stop is still waiting on
    // the actual SDK interrupt receipt; the newer work is consumed before the
    // held receipt is released below.
    await emitScriptedClaudeAbortedStreamingResult(root);
    await env.host.drain();
    let newerTurnKey: string;
    if (newerWork === 'send') {
      // Send-lifecycle variant: drive a new turn and its pickup receipt at the
      // SDK boundary while real host Stop is still pending on the earlier
      // interrupt receipt. No production cancel method is intercepted.
      const turn = await env.driver.startTurnByItself();
      expect(turn.prompt).toBe('');
      if (!hasCommandLifecycle(turn))
        throw new Error('Claude command_lifecycle scripting was unavailable');
      await turn.emitCommandLifecycle('stop-fence-new-send-command', 'started');
      await emitScriptedClaudeAssistantMessage(turn, {
        id: 'stop-fence-new-send-assistant',
        text: 'new send output before Stop returns',
        userMessageUuids: ['stop-fence-new-send-user-message'],
      });
      newerTurnKey = turn.turnKey;
    } else {
      const wake = await env.driver.startTurnByItself({
        text: 'new self-started wake during pending stop receipt',
      });
      expect(wake.prompt).toBe('');
      await wake.emitText('new wake output before Stop returns');
      newerTurnKey = wake.turnKey;
    }
    await env.host.drain();

    let stopFinished = false;
    void stopping.then(
      () => {
        stopFinished = true;
      },
      () => {
        stopFinished = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stopPendingBeforeReceiptRelease = !stopFinished;

    receiptHold.release();
    await stopping;
    await pendingSteer.catch(() => undefined);
    await env.host.drain();
    const cancelledNewerTurnKeys = getScriptedClaudeResultObservations(
      env.driver,
    )
      .filter(
        (result) =>
          result.terminalReason === 'aborted_streaming' &&
          result.turnKey === newerTurnKey,
      )
      .map((result) => result.turnKey);

    expect({
      stopPendingBeforeReceiptRelease,
      cancelledNewerTurnKeys,
    }).toEqual({
      stopPendingBeforeReceiptRelease: true,
      cancelledNewerTurnKeys: [],
    });
  } finally {
    receiptHold?.release();
    if (stopping) await stopping.catch(() => undefined);
    await pendingDelivery?.catch(() => undefined);
    await disposeScenario(env);
  }
}

const LIZARD_HOSTS = [
  'worktree',
  'cowork',
  'app-advisor',
] as const satisfies readonly PipelineHost[];
const LIZARD_PROVIDERS = [
  'claude',
  'codex',
] as const satisfies readonly PipelineProvider[];

const LIZARD_MARKERS = [
  {
    shape: 'generated ordinary',
    marker: 'lizard-generated-segment-one',
  },
  { shape: 'fresh wake', marker: 'lizard-wake-segment-two' },
  { shape: 'pickup-started', marker: 'lizard-generated-segment-three' },
  { shape: 'fresh wake', marker: 'lizard-wake-segment-four' },
] as const;

function assertMarkerManifest(
  env: IncidentEnvironment,
  expectedMarker: string,
  emittedMarkers: readonly string[],
): void {
  const expected = [expectedMarker];
  const durable = traceText(env, env.target);
  const manifest = {
    expected,
    emitted: [...emittedMarkers],
    // A delivery not emitted by the scripted transport is not evidence of a drop.
    missing: expected.filter(
      (marker) => emittedMarkers.includes(marker) && !durable.includes(marker),
    ),
  };
  expect(manifest).toEqual({
    expected,
    emitted: [expectedMarker],
    missing: [],
  });
}

function hasProviderInput(
  env: IncidentEnvironment,
  text: string,
  direction: 'prompt' | 'steer',
): boolean {
  return env.harness.recorder.events.some(
    (event) =>
      event.kind === 'provider' &&
      event.direction === 'to-provider' &&
      (event.type === direction ||
        (direction === 'prompt' && event.type === 'client:turn/start') ||
        (direction === 'steer' && event.type === 'client:turn/steer')) &&
      event.text?.includes(text),
  );
}

function assistantRowText(row: {
  role: string;
  blocks: readonly { type: string; text?: string }[];
}): string {
  if (row.role !== 'assistant') return '';
  return row.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

async function assertLizardTerminal(
  env: IncidentEnvironment,
  label: string,
  marker: string,
): Promise<void> {
  await env.host.drain();
  await env.harness.checkpoint(label, env.target);
  const terminal = [...env.harness.recorder.events]
    .reverse()
    .find((event) => event.kind === 'checkpoint' && event.label === label);
  const revision = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'revision' &&
        event.chats[env.target.chatId] !== undefined,
    );
  const transcript = traceText(env, env.target);
  const transcriptCount =
    transcript.match(new RegExp(marker, 'g'))?.length ?? 0;
  const view =
    revision?.kind === 'revision'
      ? revision.chats[env.target.chatId]
      : undefined;
  const checkpoint = terminal?.kind === 'checkpoint' ? terminal : undefined;
  const manifest = {
    marker,
    expected: [marker],
    // The scripted emitText call has resolved before this terminal checkpoint.
    emitted: [marker],
    missing: transcriptCount === 0 ? [marker] : [],
    logicalRowCount:
      view?.rows?.filter((row) => assistantRowText(row).includes(marker))
        .length ?? 0,
    transcriptCount,
    runtimeStatus: view?.runtime?.status,
    queuedIds: view?.runtime?.queuedMessageIds,
    sessionTurnActive: checkpoint?.sessionTurnActive,
    queueTurnActive: checkpoint?.queueTurnActive,
    foreground: checkpoint?.liveness?.foreground,
  };
  expect(manifest).toEqual({
    marker,
    expected: [marker],
    emitted: [marker],
    missing: [],
    logicalRowCount: 1,
    transcriptCount: 1,
    runtimeStatus: 'completed',
    queuedIds: [],
    sessionTurnActive: false,
    queueTurnActive: false,
    foreground: false,
  });
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function emitSyntheticRatBash(
  turn: ScriptedProviderTurn,
  callId: string,
  output: string,
): Promise<void> {
  // Synthetic native SDK frames exercise transcript identity; no shell command runs.
  await turn.emitToolCall({
    callId,
    name: 'Bash',
    input: { command: `printf '%s\\n' ${JSON.stringify(output)}` },
  });
  await turn.emitToolResult(callId, output);
}

interface ClaudeCommandLifecycleTurn extends ScriptedProviderTurn {
  emitCommandLifecycle(
    messageUuid: string,
    state: 'queued' | 'started' | 'cancelled',
  ): Promise<void>;
}

function hasCommandLifecycle(
  turn: ScriptedProviderTurn,
): turn is ClaudeCommandLifecycleTurn {
  return typeof Reflect.get(turn, 'emitCommandLifecycle') === 'function';
}

async function advanceWithoutBlockedStorage(
  env: Awaited<ReturnType<typeof createScenarioEnvironment>>,
  predicate: () => boolean,
  boundMs = 2000,
): Promise<void> {
  for (let elapsed = 0; !predicate() && elapsed < boundMs; elapsed += 25) {
    await env.harness.advanceLogicalClock(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!predicate()) {
    throw new Error(
      `Logical deadline ${boundMs}ms exceeded without storage drain`,
    );
  }
}

describe('provider-turn incident reproductions', () => {
  it(
    'phase 1 native Stop preserves live agents and reuses their Claude process',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'claude');
      try {
        const root = await startRoot(env, 'native stop foreground');
        await root.startNativeTask({
          taskId: 'native-stop-agent-one',
          toolUseId: 'native-stop-call-one',
          kind: 'agent',
        });
        await root.startNativeTask({
          taskId: 'native-stop-agent-two',
          toolUseId: 'native-stop-call-two',
          kind: 'agent',
        });
        await env.host.drain();

        const launchCountBeforeStop =
          env.driver.getLaunchInputs?.().length ?? 0;
        // The provider answers the interrupt with its own cancelled result; an
        // abort fallback would end the process and fail the launch count.
        const stopping = env.host.stop();
        await env.driver.nextInterrupt({ timeoutMs: 5000 });
        await emitScriptedClaudeAbortedStreamingResult(root);
        await stopping;
        await env.host.drain();
        const foregroundCancellation = getScriptedClaudeResultObservations(
          env.driver,
        ).filter((result) => result.terminalReason === 'aborted_streaming');
        const liveNativeTaskIds = getScriptedClaudeLiveNativeTaskIds(
          env.driver,
        );

        const sendAfterStop = env.host.send({ text: 'send after native Stop' });
        const next = await env.driver.nextTurn({ timeoutMs: 5000 });
        await sendAfterStop;
        const launchCountAfterNextSend =
          env.driver.getLaunchInputs?.().length ?? 0;
        await next.emitText('after-stop response');

        const stopOutcome: string = await (async (): Promise<string> => {
          try {
            const stopTaskModule: unknown =
              await import('../agents/session-manager');
            if (typeof stopTaskModule !== 'object' || stopTaskModule === null)
              throw new Error('Session manager module was unavailable');
            const stopTaskForSession: unknown = Reflect.get(
              stopTaskModule,
              'stopTaskForSession',
            );
            if (!isPerRowStopTaskApi(stopTaskForSession))
              throw new Error('Existing per-row task stop API was unavailable');
            const result: unknown = await stopTaskForSession(
              env.target.projectId,
              env.target.worktreeId,
              env.target.chatId,
              'native-stop-agent-one',
            );
            return result === 'stopped' || result === 'already-finished'
              ? result
              : `Unexpected per-row stop result: ${String(result)}`;
          } catch (error: unknown) {
            return error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
          }
        })();
        const stoppedTaskIds = env.harness.recorder.events
          .filter(
            (event) =>
              event.kind === 'provider' &&
              event.direction === 'to-provider' &&
              event.type === 'control:stopTask',
          )
          .map((event) =>
            event.kind === 'provider' ? event.ids?.taskId : undefined,
          );
        await next.complete();
        await env.host.drain();

        expect({
          foregroundCancellation,
          liveNativeTaskIds,
          launchCountBeforeStop,
          launchCountAfterNextSend,
          stopOutcome,
          stoppedTaskIds,
        }).toEqual({
          foregroundCancellation: [
            {
              turnKey: root.turnKey,
              subtype: 'success',
              terminalReason: 'aborted_streaming',
            },
          ],
          liveNativeTaskIds: ['native-stop-agent-one', 'native-stop-agent-two'],
          launchCountBeforeStop,
          launchCountAfterNextSend: launchCountBeforeStop,
          stopOutcome: 'stopped',
          stoppedTaskIds: ['native-stop-agent-one'],
        });
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it(
    'phase 1 queued send after a self-started wake uses provider message identity, not queue order',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'claude');
      try {
        const root = await startRoot(env, 'wake attribution setup');
        await root.complete();
        await env.host.drain();

        const wake = await env.driver.startTurnByItself({
          text: 'wake segment before queued send',
        });
        expect(wake.prompt).toBe('');
        await wake.emitText('wake owns this autonomous segment');
        const send = await env.host.send({
          text: 'queued send after wake starts',
          userMessageId: 'queued-after-wake-user-message',
        });
        await env.host.drain();
        await wake.complete();
        for (let elapsed = 0; elapsed < 250; elapsed += 25) {
          if (hasProviderInput(env, 'queued send after wake starts', 'prompt'))
            break;
          await env.harness.advanceLogicalClock(25);
          await new Promise<void>((resolve) => setImmediate(resolve));
          await env.host.drain();
        }
        await env.host.drain();
        const queuedTurn = await env.driver.nextTurn({ timeoutMs: 5000 });
        expect(queuedTurn.turnKey).not.toBe(wake.turnKey);
        expect(queuedTurn.prompt).toContain('queued send after wake starts');
        const promptFrame = env.harness.recorder.events.find(
          (event) =>
            event.kind === 'provider' &&
            event.direction === 'to-provider' &&
            event.type === 'prompt' &&
            event.turnKey === queuedTurn.turnKey,
        );
        const commandUuid =
          promptFrame?.kind === 'provider'
            ? promptFrame.ids?.messageUuid
            : undefined;
        if (!commandUuid)
          throw new Error(
            'Queued provider prompt did not retain its command_uuid',
          );
        if (!hasCommandLifecycle(queuedTurn))
          throw new Error('Claude command_lifecycle scripting was unavailable');
        await queuedTurn.emitCommandLifecycle(commandUuid, 'started');
        await emitScriptedClaudeAssistantMessage(queuedTurn, {
          id: 'queued-after-wake-assistant',
          text: 'the queued send response belongs to its own row',
          userMessageUuids: [send.userMessageId],
        });
        await env.host.drain();
        const latest = latestRuntime(env);
        const correlation = getScriptedClaudeAssistantCorrelations(
          env.driver,
        ).at(-1);
        const queuedPromptContainsSend = queuedTurn.prompt.includes(
          'queued send after wake starts',
        );
        const startedCommands = env.harness.recorder.events
          .filter(
            (event) =>
              event.kind === 'provider' &&
              event.direction === 'to-canopy' &&
              event.type === 'sdk:command_lifecycle' &&
              event.turnKey === queuedTurn.turnKey,
          )
          .map((event) =>
            event.kind === 'provider' ? event.ids?.messageUuid : undefined,
          );
        await queuedTurn.complete();
        await env.host.drain();

        expect({
          wakePrompt: wake.prompt,
          queuedPromptContainsSend,
          commandUuid,
          startedCommands,
          correlation,
          attributedActiveMessage: latest?.activeTurn?.userMessageId,
        }).toEqual({
          wakePrompt: '',
          queuedPromptContainsSend: true,
          commandUuid,
          startedCommands: [commandUuid],
          correlation: {
            turnKey: queuedTurn.turnKey,
            assistantMessageId: 'queued-after-wake-assistant',
            userMessageUuid: send.userMessageId,
            userMessageUuids: [send.userMessageId],
          },
          attributedActiveMessage: send.userMessageId,
        });
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it(
    'phase 1 result terminal settles without session_state_changed',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'claude');
      try {
        const turn = await startRoot(env, 'result-only terminal guard');
        await turn.complete();
        await env.host.drain();

        const statusChanges = env.harness.recorder.events.filter(
          (event) =>
            event.kind === 'provider' &&
            event.direction === 'to-canopy' &&
            event.type === 'sdk:system:session_state_changed',
        );
        expect({
          statusChanges,
          runtimeStatus: latestRuntime(env)?.status,
          activeTurn: latestRuntime(env)?.activeTurn,
        }).toEqual({
          statusChanges: [],
          runtimeStatus: 'completed',
          activeTurn: undefined,
        });
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it(
    'phase 1 host Stop fences a newer send consumed before the held SDK receipt returns',
    async () => {
      await runHostStopFenceRace('send');
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it(
    'phase 1 host Stop fences a newer wake consumed before the held SDK receipt returns',
    async () => {
      await runHostStopFenceRace('wake');
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it(
    'ocelot: four native child wakes after more than 500 durable rows',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'claude', {
        prepareStorage: (storage, target) =>
          seedLatencyHistory(storage, target, 501),
      });
      try {
        const root = await startRoot(env, 'ocelot native-child root');
        for (let index = 1; index <= 4; index += 1) {
          const callId = `ocelot-agent-${index}`;
          await root.emitToolCall({ callId, name: 'Agent' });
          await root.startNativeTask({
            taskId: `ocelot-task-${index}`,
            toolUseId: callId,
            kind: 'agent',
          });
        }
        await root.complete();
        await env.host.drain();
        const durableWakes: string[] = [];
        for (let index = 1; index <= 4; index += 1) {
          await root.endNativeTask(`ocelot-task-${index}`);
          const output = `ocelot-child-wake-output-${index}`;
          const wake = await env.driver.startTurnByItself({
            text: `ocelot-child-wake-${index}`,
          });
          await wake.emitText(output);
          await wake.complete();
          await env.host.drain();
          expect(traceText(env, env.target)).toContain(output);
          durableWakes.push(output);
        }
        expect(durableWakes).toHaveLength(4);
        await finishScenario(env, [11, 17]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS * 3,
  );

  it(
    'scorpion: two children outlive root; delayed terminal admission preserves generated output',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'claude');
      try {
        const root = await startRoot(env, 'scorpion delayed-terminal root');
        for (let index = 1; index <= 2; index += 1) {
          const callId = `scorpion-agent-${index}`;
          await root.emitToolCall({ callId, name: 'Agent' });
          await root.startNativeTask({
            taskId: `scorpion-task-${index}`,
            toolUseId: callId,
            kind: 'agent',
          });
          await root.emitText(`scorpion-child-output-${index}`);
        }
        const revisionsBeforeTerminal = env.harness.recorder.events.filter(
          (event) => event.kind === 'revision',
        ).length;
        env.harness.holdCommits();
        try {
          await root.complete();
          await advanceWithoutBlockedStorage(env, () =>
            env.harness.recorder.events.some(
              (event) =>
                event.kind === 'provider' &&
                event.direction === 'to-canopy' &&
                event.target.chatId === env.target.chatId &&
                event.type === 'sdk:result:success',
            ),
          );
          const delivery = env.host.deliverGenerated({
            kind: 'delegation-notice',
            text: 'scorpion-generated-followup',
            deliveryId: 'scorpion-generated-delivery',
          });
          await env.harness.advanceLogicalClock(50);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(
            env.harness.recorder.events.filter(
              (event) => event.kind === 'revision',
            ),
          ).toHaveLength(revisionsBeforeTerminal);
          env.harness.releaseCommits();
          await delivery;
        } finally {
          env.harness.releaseCommits();
        }
        await pumpUntil(env, () =>
          env.harness.recorder.events.some(
            (event) =>
              event.kind === 'provider' &&
              event.direction === 'to-provider' &&
              event.type === 'prompt' &&
              event.text?.includes('scorpion-generated-followup'),
          ),
        );
        const followup = await env.driver.nextTurn({ timeoutMs: 5000 });
        expect(followup.prompt).toContain('scorpion-generated-followup');
        await followup.emitText('scorpion-followup-output');
        await followup.complete();
        for (let index = 1; index <= 2; index += 1) {
          await root.endNativeTask(`scorpion-task-${index}`);
        }
        await env.host.drain();
        const durable = traceText(env, env.target);
        expect(durable).toContain('scorpion-child-output-1');
        expect(durable).toContain('scorpion-child-output-2');
        expect(durable).toContain('scorpion-followup-output');
        await finishScenario(env, [11, 17]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  for (const host of LIZARD_HOSTS) {
    for (const provider of LIZARD_PROVIDERS) {
      for (const scenario of LIZARD_MARKERS) {
        it(
          `lizard: ${host}/${provider} ${scenario.shape} marker ${scenario.marker} has durable transcript evidence`,
          async () => {
            const env = await createIncidentEnvironment(host, provider);
            const emittedMarkers: string[] = [];
            let pickupObserved = false;
            let freshWakeTurnKey: string | undefined;
            try {
              if (scenario.shape === 'generated ordinary') {
                const root = await startRoot(
                  env,
                  'lizard generated ordinary root',
                );
                const generatedText = 'lizard generated ordinary input';
                const delivery = env.host.deliverGenerated({
                  kind: 'watcher',
                  text: generatedText,
                  watcherId: 'lizard-generated-ordinary',
                  deliveryId: 'lizard-generated-ordinary',
                });
                await pumpUntil(env, () =>
                  hasProviderInput(env, generatedText, 'steer'),
                );
                const steer = await root.nextSteer({ timeoutMs: 5000 });
                await steer.refuse();
                await delivery;
                await root.complete();
                await env.host.drain();
                await pumpUntil(env, () =>
                  hasProviderInput(env, generatedText, 'prompt'),
                );
                const turn = await env.driver.nextTurn({ timeoutMs: 5000 });
                await turn.emitText(scenario.marker);
                emittedMarkers.push(scenario.marker);
                await turn.complete();
              } else if (scenario.shape === 'fresh wake') {
                const root = await startRoot(env, 'lizard fresh wake root');
                await root.complete();
                await env.host.drain();
                const turn = await env.driver.startTurnByItself();
                freshWakeTurnKey = turn.turnKey;
                await turn.emitText(scenario.marker);
                emittedMarkers.push(scenario.marker);
                await turn.complete();
              } else {
                const root = await startRoot(env, 'lizard pickup-started root');
                const generatedText = 'lizard pickup-started input';
                const delivery = env.host.deliverGenerated({
                  kind: 'watcher',
                  text: generatedText,
                  watcherId: 'lizard-pickup-started',
                  deliveryId: 'lizard-pickup-started',
                });
                await pumpUntil(env, () =>
                  hasProviderInput(env, generatedText, 'steer'),
                );
                const steer = await root.nextSteer({ timeoutMs: 5000 });
                await steer.acknowledge();
                await steer.pickUp?.();
                await delivery;
                await root.complete();
                await env.host.drain();
                const turn = await env.driver.startTurnByItself();
                await turn.emitText(scenario.marker);
                emittedMarkers.push(scenario.marker);
                await turn.complete();
                await env.host.drain();
                pickupObserved = env.harness.recorder.events.some(
                  (event) =>
                    event.kind === 'revision' &&
                    event.chats[env.target.chatId]?.inputDelivery?.rows.some(
                      (row) =>
                        row.id === 'watcher-lizard-pickup-started' &&
                        row.attempts.some(
                          (attempt) => attempt.pickedUpAt !== undefined,
                        ),
                    ),
                );
              }

              await env.host.drain();
              // Synthetic provider output is counted as dropped only after emitText resolves.
              assertMarkerManifest(env, scenario.marker, emittedMarkers);
              if (provider === 'codex' && freshWakeTurnKey !== undefined) {
                const nativeWakeDrops = env.harness.dropDiagnosticCalls.filter(
                  (drop) =>
                    drop.projectId === env.target.projectId &&
                    drop.worktreeId === env.target.worktreeId &&
                    drop.chatId === env.target.chatId &&
                    drop.providerTurnId === freshWakeTurnKey &&
                    (drop.gate === 'codex_root_completion_stale' ||
                      drop.gate === 'codex_root_output_stale'),
                );
                expect(nativeWakeDrops).toEqual([]);
              }
              if (scenario.shape === 'pickup-started')
                expect(pickupObserved).toBe(true);
              await finishScenario(env, []);
            } finally {
              await disposeScenario(env);
            }
          },
          SCENARIO_TEST_TIMEOUT_MS,
        );
      }
    }
  }

  for (const provider of LIZARD_PROVIDERS) {
    it(
      `lizard: worktree/${provider} uninterrupted four-segment integration settles each terminal before an ordinary send`,
      async () => {
        const env = await createIncidentEnvironment('worktree', provider);
        try {
          const first = await runWatcherMidTurnComposition(env);
          await first.emitText('lizard-generated-segment-one');
          await first.complete();
          await assertLizardTerminal(
            env,
            'lizard-integration-segment-one',
            'lizard-generated-segment-one',
          );
          assertMarkerManifest(env, 'lizard-generated-segment-one', [
            'lizard-generated-segment-one',
          ]);

          const second = await env.driver.startTurnByItself();
          await second.emitText('lizard-wake-segment-two');
          await second.complete();
          await assertLizardTerminal(
            env,
            'lizard-integration-segment-two',
            'lizard-wake-segment-two',
          );
          assertMarkerManifest(env, 'lizard-wake-segment-two', [
            'lizard-wake-segment-two',
          ]);

          const generatedText = 'lizard integration generated delivery';
          const generated = env.host.deliverGenerated({
            kind: 'watcher',
            text: generatedText,
            watcherId: 'lizard-integration-third-watcher',
            deliveryId: 'lizard-integration-third-delivery',
          });
          await pumpUntil(env, () =>
            hasProviderInput(env, generatedText, 'prompt'),
          );
          const third = await env.driver.nextTurn({ timeoutMs: 5000 });
          await generated;
          await third.emitText('lizard-generated-segment-three');
          await third.complete();
          await assertLizardTerminal(
            env,
            'lizard-integration-segment-three',
            'lizard-generated-segment-three',
          );
          assertMarkerManifest(env, 'lizard-generated-segment-three', [
            'lizard-generated-segment-three',
          ]);

          const fourth = await env.driver.startTurnByItself();
          await fourth.emitText('lizard-wake-segment-four');
          await fourth.complete();
          await assertLizardTerminal(
            env,
            'lizard-integration-segment-four',
            'lizard-wake-segment-four',
          );
          assertMarkerManifest(env, 'lizard-wake-segment-four', [
            'lizard-wake-segment-four',
          ]);

          const ordinaryText = 'lizard subsequent ordinary send';
          const ordinarySend = env.host.send({ text: ordinaryText });
          await pumpUntil(env, () =>
            hasProviderInput(env, ordinaryText, 'prompt'),
          );
          const ordinary = await env.driver.nextTurn({ timeoutMs: 5000 });
          await ordinarySend;
          expect(ordinary.prompt).toContain(ordinaryText);
          await ordinary.emitText('lizard-subsequent-ordinary-output');
          await ordinary.complete();
          await env.host.drain();
          expect(traceText(env, env.target)).toContain(
            'lizard-subsequent-ordinary-output',
          );
          await finishScenario(env, [11, 17]);
        } finally {
          await disposeScenario(env);
        }
      },
      SCENARIO_TEST_TIMEOUT_MS,
    );
  }

  it.each(['claude', 'codex'] as const)(
    'cuttlefish: user message and pending question answer coexist during %s turn',
    async (provider: PipelineProvider) => {
      const env = await createIncidentEnvironment('worktree', provider);
      try {
        const userMessageId = await runMessageAndQuestionAnswerComposition(env);
        expect(userMessageId.length).toBeGreaterThan(0);
        const durable = traceText(env, env.target);
        expect(durable).toContain(
          'The user message and question answer were handled.',
        );
        await finishScenario(env, [11, 17]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it(
    'cuttlefish: late completed command and held terminal admit the queued message afterward',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'claude');
      try {
        const root = await startRoot(env, 'cuttlefish command root');
        if (!hasCommandLifecycle(root))
          throw new Error(
            'Claude scripted turn lacks command lifecycle frames',
          );
        await root.emitCommandLifecycle('cuttlefish-command', 'queued');
        await root.emitCommandLifecycle('cuttlefish-command', 'started');
        await root.emitText('cuttlefish-command-output');
        const revisionsBeforeTerminal = env.harness.recorder.events.filter(
          (event) => event.kind === 'revision',
        ).length;
        env.harness.holdCommits();
        try {
          await root.complete();
          await advanceWithoutBlockedStorage(env, () =>
            env.harness.recorder.events.some(
              (event) =>
                event.kind === 'provider' &&
                event.direction === 'to-canopy' &&
                event.type === 'sdk:result:success',
            ),
          );
          const lateSend = env.host.send({
            text: 'cuttlefish-late-user-message',
          });
          await env.harness.advanceLogicalClock(50);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(
            env.harness.recorder.events.filter(
              (event) => event.kind === 'revision',
            ),
          ).toHaveLength(revisionsBeforeTerminal);
          env.harness.releaseCommits();
          await lateSend;
        } finally {
          env.harness.releaseCommits();
        }
        await env.host.drain();
        await pumpUntil(env, () =>
          env.harness.recorder.events.some(
            (event) =>
              event.kind === 'provider' &&
              event.direction === 'to-provider' &&
              event.type === 'prompt' &&
              event.text?.includes('cuttlefish-late-user-message'),
          ),
        );
        const followup = await env.driver.nextTurn({ timeoutMs: 5000 });
        expect(followup.prompt).toContain('cuttlefish-late-user-message');
        await followup.emitText('cuttlefish-late-output');
        await followup.complete();
        await env.host.drain();
        const durable = traceText(env, env.target);
        expect(durable).toContain('cuttlefish-command-output');
        expect(durable).toContain('cuttlefish-late-output');
        await finishScenario(env, [11, 17]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it.each(['claude', 'codex'] as const)(
    'cuttlefish: refused watcher remains a single ordinary delivery for %s',
    async (provider: PipelineProvider) => {
      const env = await createIncidentEnvironment('worktree', provider);
      try {
        await runCoreScenario(3, env);
        const refused = env.harness.recorder.events.filter(
          (event) =>
            event.kind === 'effect' &&
            event.effect.name === 'steer-settled' &&
            event.effect.outcome === 'refused',
        );
        expect(refused).toHaveLength(1);
        await finishScenario(env, [21]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  registerCuttlefishIncidentTests();
  registerCodexRootIncidentTests();
  registerCodexMergedStartIncidentTests();
  registerCodexBackgroundIncidentTests();
  registerCodexResolvedIncidentTests();
  registerCodexDelegatedResolvedIncidentTests();
  registerCodexTransportIncidentTests();

  it(
    'cuttlefish: cancelled dynamic tool never performs its delayed watcher side effect',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'codex');
      try {
        await runCoreScenario(10, env);
        await finishScenario(env, [11, 17, 18]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it(
    'cuttlefish: Codex peer owner progresses while another owner exceeds its byte admission cap',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'codex');
      const targetB: PipelineChatTarget = {
        ...env.target,
        chatId: 'scenario-owner-b',
      };
      const held = deferred();
      const entered = deferred();
      let admissionHeld = false;
      let hostB: Awaited<ReturnType<typeof env.harness.host>> | undefined;
      try {
        env.harness.registerChat(targetB, {
          captureRows: true,
          captureTranscript: 'revision',
        });
        hostB = await env.harness.host('worktree', 'codex', targetB);
        const sendA = env.host.send({ text: 'owner A root' });
        const turnA = await env.driver.nextTurn({ timeoutMs: 5000 });
        await turnA.emitText('owner A root output');
        await sendA;
        bindNextScriptedCodexThreadTarget(env.driver, targetB);
        const sendB = hostB.send({ text: 'owner B root' });
        const turnB = await env.driver.nextTurn({ timeoutMs: 5000 });
        await turnB.emitText('owner B root output');
        await sendB;

        const { getChatStateService } =
          await import('../services/chat-state-service');
        const service = getChatStateService();
        const original = service.ingestProviderEventWithResult.bind(service);
        const admissionSpy = jest
          .spyOn(service, 'ingestProviderEventWithResult')
          .mockImplementation(async (input) => {
            if (
              input.chatId === env.target.chatId &&
              JSON.stringify(input.data).length > 128 * 1024
            ) {
              admissionHeld = true;
              entered.release();
              await held.promise;
            }
            return original(input);
          });
        const heldDelta = `owner-a-held-${'x'.repeat(300 * 1024)}`;
        const ownerAFrame = emitScriptedCodexCommand(
          env.driver,
          turnA.turnKey,
          { itemId: 'owner-a-command', output: heldDelta },
        );
        void ownerAFrame.catch(() => undefined);
        try {
          // This bounds transport arrival, not a product deadline; queue
          // deadlines below still run on the harness clock.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              entered.promise,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Owner A admission was not reached; held=${String(admissionHeld)}`,
                      ),
                    ),
                  10_000,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          const { getRoutedSessionPressureSnapshot } =
            await import('../agents/session-event-router');
          const pressure = getRoutedSessionPressureSnapshot(env.target);
          expect(pressure.estimatedChargedBytes).toBeGreaterThan(128 * 1024);
          await turnB.emitText('owner-b-progress-before-release');
          await turnB.complete();
          const { drainCurrentSessionEvents } =
            await import('../agents/session-event-router');
          await drainCurrentSessionEvents(targetB);
          expect(traceText(env, targetB)).toContain(
            'owner-b-progress-before-release',
          );
        } finally {
          held.release();
          await ownerAFrame;
          admissionSpy.mockRestore();
        }
        await turnA.complete();
        await env.host.drain();
        await finishScenario(env, [11, 17]);
      } finally {
        held.release();
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS * 2,
  );

  it(
    'scorpion composition starts a new root only after terminal admission releases',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'claude');
      try {
        await runRootEndGeneratedComposition(env);
        expect(traceText(env, env.target)).toContain(
          'The delayed terminal did not lose delegation output.',
        );
        await finishScenario(env, [11, 17]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it.each(RAT_VARIANTS)(
    'rat: extends the existing %s terminal/stop race with a durable wake segment',
    async (variant) => {
      const env = await createIncidentEnvironment('worktree', 'claude');
      try {
        await runPortScenario(6, env, variant);
        const wake = await env.driver.startTurnByItself({
          text: `rat-extension-${variant}`,
        });
        await wake.emitText(`rat-wake-output-${variant}`);
        await wake.complete();
        await env.host.drain();
        expect(traceText(env, env.target)).toContain(
          `rat-wake-output-${variant}`,
        );
        await finishScenario(env, [13, 15, 19, 21]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  it(
    'rat: two notice-owned turns cross the root terminal boundary without borrowing a queued ordinary prompt',
    async () => {
      const env = await createIncidentEnvironment('worktree', 'claude');
      const assistantIdentities: {
        id: string;
        marker: string;
        notice: 'notice-one' | 'notice-two';
        turnKey: string;
      }[] = [];
      let boundaryDeliveries:
        | readonly [Promise<void>, Promise<void>]
        | undefined;
      let queuedOrdinarySend: ReturnType<typeof env.host.send> | undefined;
      const bashCalls = [
        {
          id: 'rat-bash-notice-one',
          output: 'rat-bash-result-notice-one',
        },
        {
          id: 'rat-bash-notice-two-one',
          output: 'rat-bash-result-notice-two-one',
        },
        {
          id: 'rat-bash-notice-two-two',
          output: 'rat-bash-result-notice-two-two',
        },
      ] as const;
      try {
        const rootPrompt = 'rat boundary root prompt';
        const rootSend = env.host.send({ text: rootPrompt });
        await pumpUntil(env, () => hasProviderInput(env, rootPrompt, 'prompt'));
        const root = await env.driver.nextTurn({ timeoutMs: 5000 });
        expect(root.prompt).toContain(rootPrompt);
        await rootSend;
        await env.host.drain();

        const revisionsBeforeTerminal = env.harness.recorder.events.filter(
          (event) => event.kind === 'revision',
        ).length;
        env.harness.holdCommits();
        try {
          await root.complete();
          await advanceWithoutBlockedStorage(env, () =>
            env.harness.recorder.events.some(
              (event) =>
                event.kind === 'provider' &&
                event.direction === 'to-canopy' &&
                event.turnKey === root.turnKey &&
                event.type === 'sdk:result:success',
            ),
          );
          boundaryDeliveries = [
            env.host.deliverGenerated({
              kind: 'delegation-notice',
              text: 'rat boundary notice one',
              deliveryId: 'rat-boundary-notice-one',
            }),
            env.host.deliverGenerated({
              kind: 'delegation-notice',
              text: 'rat boundary notice two',
              deliveryId: 'rat-boundary-notice-two',
            }),
          ];
          queuedOrdinarySend = env.host.send({
            text: 'rat queued ordinary prompt',
          });
          await env.harness.advanceLogicalClock(50);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(
            env.harness.recorder.events.filter(
              (event) => event.kind === 'revision',
            ),
          ).toHaveLength(revisionsBeforeTerminal);
        } finally {
          env.harness.releaseCommits();
        }
        if (
          boundaryDeliveries === undefined ||
          queuedOrdinarySend === undefined
        )
          throw new Error('Rat root-boundary work was not admitted');
        await Promise.all(boundaryDeliveries);
        const queuedOrdinaryReceipt = await queuedOrdinarySend;
        const queuedOrdinaryMessageId = queuedOrdinaryReceipt.userMessageId;

        const latestRuntime = (): ChatRuntimeState | undefined => {
          const runtimeRevision = [...env.harness.recorder.events]
            .reverse()
            .find(
              (event) =>
                event.kind === 'revision' &&
                event.chats[env.target.chatId]?.runtime !== undefined,
            );
          return runtimeRevision?.kind === 'revision'
            ? runtimeRevision.chats[env.target.chatId]?.runtime
            : undefined;
        };

        const noticeOneText = 'rat boundary notice one';
        const noticeTwoText = 'rat boundary notice two';
        await pumpUntil(
          env,
          () =>
            hasProviderInput(env, noticeOneText, 'prompt') ||
            hasProviderInput(env, 'rat queued ordinary prompt', 'prompt'),
        );
        const queuedMarker = 'rat-assistant-queued-ordinary';
        let queuedOrdinaryHandled = false;
        let readyNoticeOne: ScriptedProviderTurn | undefined;
        const firstBoundaryTurn = await env.driver.nextTurn({
          timeoutMs: 5000,
        });
        // Queue policy may prioritize an ordinary user send. That is not a
        // notice borrowing its root: consume that actual prompt first.
        if (firstBoundaryTurn.prompt.includes('rat queued ordinary prompt')) {
          await env.host.drain();
          expect(latestRuntime()?.activeTurn?.userMessageId).toBe(
            queuedOrdinaryMessageId,
          );
          await firstBoundaryTurn.emitText(queuedMarker);
          await firstBoundaryTurn.complete();
          await env.host.drain();
          queuedOrdinaryHandled = true;
          await pumpUntil(env, () =>
            hasProviderInput(env, noticeOneText, 'prompt'),
          );
        } else {
          readyNoticeOne = firstBoundaryTurn;
        }
        await env.host.drain();
        const waitingNoticeOneUserMessageId =
          latestRuntime()?.activeTurn?.userMessageId;
        expect({
          noticePromptObserved: hasProviderInput(env, noticeOneText, 'prompt'),
          activeTurnUserMessageId: waitingNoticeOneUserMessageId,
          queuedOrdinaryMessageId,
        }).toEqual({
          noticePromptObserved: true,
          activeTurnUserMessageId: 'rat-boundary-notice-one',
          queuedOrdinaryMessageId,
        });
        expect(waitingNoticeOneUserMessageId).not.toBe(queuedOrdinaryMessageId);
        const noticeOne =
          readyNoticeOne ?? (await env.driver.nextTurn({ timeoutMs: 5000 }));
        expect(noticeOne.prompt).toContain(noticeOneText);
        expect(noticeOne.prompt).not.toContain(noticeTwoText);
        expect(noticeOne.prompt).not.toContain('rat queued ordinary prompt');
        expect(noticeOne.turnKey).not.toBe(root.turnKey);
        await env.host.drain();
        const noticeOneUserMessageId =
          latestRuntime()?.activeTurn?.userMessageId;
        expect(noticeOneUserMessageId).toBe('rat-boundary-notice-one');
        expect(noticeOneUserMessageId).not.toBe(queuedOrdinaryMessageId);
        if (!queuedOrdinaryHandled)
          expect(latestRuntime()?.queuedMessageIds).toContain(
            queuedOrdinaryMessageId,
          );
        const noticeOneMessages = [
          {
            id: 'rat-notice-one-message-1',
            text: 'rat-assistant-notice-one-message-one',
          },
          {
            id: 'rat-notice-one-message-2',
            text: 'rat-assistant-notice-one-message-two',
          },
        ] as const;
        await emitScriptedClaudeAssistantMessage(
          noticeOne,
          noticeOneMessages[0],
        );
        await emitSyntheticRatBash(
          noticeOne,
          bashCalls[0].id,
          bashCalls[0].output,
        );
        await emitScriptedClaudeAssistantMessage(
          noticeOne,
          noticeOneMessages[1],
        );
        assistantIdentities.push(
          ...noticeOneMessages.map(({ id, text }) => ({
            id,
            marker: text,
            notice: 'notice-one' as const,
            turnKey: noticeOne.turnKey,
          })),
        );
        await noticeOne.complete();
        await env.host.drain();

        await pumpUntil(
          env,
          () =>
            hasProviderInput(env, noticeTwoText, 'prompt') ||
            (!queuedOrdinaryHandled &&
              hasProviderInput(env, 'rat queued ordinary prompt', 'prompt')),
        );
        let readyNoticeTwo: ScriptedProviderTurn | undefined;
        if (!queuedOrdinaryHandled) {
          const nextBoundaryTurn = await env.driver.nextTurn({
            timeoutMs: 5000,
          });
          if (nextBoundaryTurn.prompt.includes('rat queued ordinary prompt')) {
            await nextBoundaryTurn.emitText(queuedMarker);
            await nextBoundaryTurn.complete();
            await env.host.drain();
            queuedOrdinaryHandled = true;
            await pumpUntil(env, () =>
              hasProviderInput(env, noticeTwoText, 'prompt'),
            );
          } else readyNoticeTwo = nextBoundaryTurn;
        }
        await env.host.drain();
        const waitingNoticeTwoUserMessageId =
          latestRuntime()?.activeTurn?.userMessageId;
        expect({
          noticePromptObserved: hasProviderInput(env, noticeTwoText, 'prompt'),
          activeTurnUserMessageId: waitingNoticeTwoUserMessageId,
          queuedOrdinaryMessageId,
        }).toEqual({
          noticePromptObserved: true,
          activeTurnUserMessageId: 'rat-boundary-notice-two',
          queuedOrdinaryMessageId,
        });
        expect(waitingNoticeTwoUserMessageId).not.toBe(queuedOrdinaryMessageId);
        const noticeTwo =
          readyNoticeTwo ?? (await env.driver.nextTurn({ timeoutMs: 5000 }));
        expect(noticeTwo.prompt).toContain(noticeTwoText);
        expect(noticeTwo.prompt).not.toContain(noticeOneText);
        expect(noticeTwo.prompt).not.toContain('rat queued ordinary prompt');
        expect(noticeTwo.turnKey).not.toBe(root.turnKey);
        expect(noticeTwo.turnKey).not.toBe(noticeOne.turnKey);
        await env.host.drain();
        const noticeTwoUserMessageId =
          latestRuntime()?.activeTurn?.userMessageId;
        expect(noticeTwoUserMessageId).toBe('rat-boundary-notice-two');
        expect(noticeTwoUserMessageId).not.toBe(queuedOrdinaryMessageId);
        if (!queuedOrdinaryHandled)
          expect(latestRuntime()?.queuedMessageIds).toContain(
            queuedOrdinaryMessageId,
          );
        const noticeTwoMessages = [
          {
            id: 'rat-notice-two-message-1',
            text: 'rat-assistant-notice-two-message-one',
          },
          {
            id: 'rat-notice-two-message-2',
            text: 'rat-assistant-notice-two-message-two',
          },
          {
            id: 'rat-notice-two-message-3',
            text: 'rat-assistant-notice-two-message-three',
          },
        ] as const;
        await emitScriptedClaudeAssistantMessage(
          noticeTwo,
          noticeTwoMessages[0],
        );
        await emitSyntheticRatBash(
          noticeTwo,
          bashCalls[1].id,
          bashCalls[1].output,
        );
        await emitScriptedClaudeAssistantMessage(
          noticeTwo,
          noticeTwoMessages[1],
        );
        await emitSyntheticRatBash(
          noticeTwo,
          bashCalls[2].id,
          bashCalls[2].output,
        );
        await emitScriptedClaudeAssistantMessage(
          noticeTwo,
          noticeTwoMessages[2],
        );
        assistantIdentities.push(
          ...noticeTwoMessages.map(({ id, text }) => ({
            id,
            marker: text,
            notice: 'notice-two' as const,
            turnKey: noticeTwo.turnKey,
          })),
        );
        await noticeTwo.complete();
        await env.host.drain();

        if (!queuedOrdinaryHandled) {
          await pumpUntil(env, () =>
            hasProviderInput(env, 'rat queued ordinary prompt', 'prompt'),
          );
          const queuedOrdinary = await env.driver.nextTurn({ timeoutMs: 5000 });
          expect(queuedOrdinary.prompt).toContain('rat queued ordinary prompt');
          expect(queuedOrdinary.prompt).not.toContain(noticeOneText);
          expect(queuedOrdinary.prompt).not.toContain(noticeTwoText);
          await queuedOrdinary.emitText(queuedMarker);
          await queuedOrdinary.complete();
          await env.host.drain();
        }
        await env.harness.checkpoint('rat-generated-queue-drained', env.target);
        const generatedDrain = [...env.harness.recorder.events]
          .reverse()
          .find(
            (event) =>
              event.kind === 'checkpoint' &&
              event.label === 'rat-generated-queue-drained',
          );
        if (generatedDrain?.kind !== 'checkpoint')
          throw new Error('Missing rat generated-queue drain checkpoint');
        expect(generatedDrain.queueTurnActive).toBe(false);
        expect(generatedDrain.sessionTurnActive).toBe(false);

        const subsequentText = 'rat subsequent ordinary prompt';
        const subsequentSend = env.host.send({ text: subsequentText });
        await pumpUntil(env, () =>
          hasProviderInput(env, subsequentText, 'prompt'),
        );
        const subsequent = await env.driver.nextTurn({ timeoutMs: 5000 });
        await subsequentSend;
        expect(subsequent.prompt).toContain(subsequentText);
        expect(subsequent.prompt).not.toContain(noticeOneText);
        expect(subsequent.prompt).not.toContain(noticeTwoText);
        const subsequentMarker = 'rat-assistant-subsequent-ordinary';
        await subsequent.emitText(subsequentMarker);
        await subsequent.complete();
        await env.host.drain();

        const rows = [...env.harness.recorder.events]
          .reverse()
          .find(
            (event) =>
              event.kind === 'revision' &&
              event.chats[env.target.chatId] !== undefined,
          );
        if (rows?.kind !== 'revision')
          throw new Error('Missing rat assistant-message rows');
        const persistedRows = rows.chats[env.target.chatId]?.rows;
        if (!persistedRows)
          throw new Error('Rat revision did not capture transcript rows');
        const identifiedAssistantRows = assistantIdentities.map(
          ({ id, marker, notice, turnKey }) => {
            const matches = persistedRows.filter(
              (row) =>
                row.role === 'assistant' &&
                row.id === id &&
                assistantRowText(row).includes(marker),
            );
            return {
              id,
              marker,
              notice,
              turnKey,
              actualIds: matches.map((row) => row.id),
              count: matches.length,
            };
          },
        );
        expect(identifiedAssistantRows).toEqual(
          assistantIdentities.map(({ id, marker, notice, turnKey }) => ({
            id,
            marker,
            notice,
            turnKey,
            actualIds: [id],
            count: 1,
          })),
        );
        expect(assistantIdentities).toHaveLength(5);
        expect(
          assistantIdentities.filter(({ notice }) => notice === 'notice-one'),
        ).toHaveLength(2);
        expect(
          assistantIdentities.filter(({ notice }) => notice === 'notice-two'),
        ).toHaveLength(3);
        const durableTranscript = traceText(env, env.target);
        expect(
          assistantIdentities.map(({ marker }) => ({
            marker,
            count:
              durableTranscript.match(new RegExp(marker, 'g'))?.length ?? 0,
          })),
        ).toEqual(
          assistantIdentities.map(({ marker }) => ({ marker, count: 1 })),
        );
        expect(durableTranscript).toContain(queuedMarker);
        expect(durableTranscript).toContain(subsequentMarker);

        const callIds: readonly string[] = bashCalls.map(({ id }) => id);
        const toolCalls = persistedRows.flatMap((row) =>
          row.blocks.flatMap((block) => {
            if (block.type !== 'tool_use' || !callIds.includes(block.toolUseId))
              return [];
            return [{ id: block.toolUseId, name: block.toolName }];
          }),
        );
        expect(toolCalls).toEqual(callIds.map((id) => ({ id, name: 'Bash' })));
        const toolResults = persistedRows.flatMap((row) =>
          row.blocks.flatMap((block) => {
            if (
              block.type !== 'tool_result' ||
              !callIds.includes(block.toolUseId)
            )
              return [];
            return [
              {
                id: block.toolUseId,
                output: block.output,
                isError: block.isError,
              },
            ];
          }),
        );
        expect(toolResults).toEqual(
          bashCalls.map(({ id, output }) => ({
            id,
            output,
            isError: false,
          })),
        );

        const providerFrames = env.harness.recorder.events.filter(
          (event): event is Extract<PipelineTraceEvent, { kind: 'provider' }> =>
            event.kind === 'provider' && event.direction === 'to-canopy',
        );
        const callFrames = providerFrames.filter(
          (event) => event.type === 'sdk:assistant' && event.ids?.callId,
        );
        expect(
          callFrames.map((event) => ({
            id: event.ids?.callId,
            turnKey: event.turnKey,
          })),
        ).toEqual([
          { id: bashCalls[0].id, turnKey: noticeOne.turnKey },
          { id: bashCalls[1].id, turnKey: noticeTwo.turnKey },
          { id: bashCalls[2].id, turnKey: noticeTwo.turnKey },
        ]);
        const resultFrames = providerFrames.filter(
          (event) => event.type === 'sdk:user' && event.ids?.callId,
        );
        expect(
          resultFrames.map((event) => ({
            id: event.ids?.callId,
            turnKey: event.turnKey,
          })),
        ).toEqual([
          { id: bashCalls[0].id, turnKey: noticeOne.turnKey },
          { id: bashCalls[1].id, turnKey: noticeTwo.turnKey },
          { id: bashCalls[2].id, turnKey: noticeTwo.turnKey },
        ]);

        await env.host.drain();
        await env.harness.checkpoint('rat-final-drained', env.target);
        const finalDrain = [...env.harness.recorder.events]
          .reverse()
          .find(
            (event) =>
              event.kind === 'checkpoint' &&
              event.label === 'rat-final-drained',
          );
        if (finalDrain?.kind !== 'checkpoint')
          throw new Error('Missing rat final drain checkpoint');
        expect(finalDrain.queueTurnActive).toBe(false);
        expect(finalDrain.sessionTurnActive).toBe(false);
        const finalRuntime = [...env.harness.recorder.events]
          .reverse()
          .find(
            (event) =>
              event.kind === 'revision' &&
              event.chats[env.target.chatId]?.runtime !== undefined,
          );
        if (finalRuntime?.kind !== 'revision')
          throw new Error('Missing rat final runtime');
        expect(finalRuntime.chats[env.target.chatId]?.runtime).toMatchObject({
          status: 'completed',
          queuedMessageIds: [],
        });
        await finishScenario(env, []);
      } finally {
        env.harness.releaseCommits();
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );
});
