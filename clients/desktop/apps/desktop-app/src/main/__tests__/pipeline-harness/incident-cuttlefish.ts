/** Phase 1 Cuttlefish proof: late native Codex command completion is durable and idempotent. */
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type {
  PipelineChatTarget,
  PipelineHost,
  ProviderTraceEvent,
} from './contracts';
import {
  createScenarioEnvironment,
  disposeScenario,
  finishScenario,
  SCENARIO_TEST_TIMEOUT_MS,
  startRoot,
} from './scenarios';
import { emitScriptedCodexCommand } from './scripted-codex';
import type { PipelineStorage } from './storage';

type CuttlefishEnvironment = Awaited<
  ReturnType<typeof createScenarioEnvironment>
>;

const CUTTLEFISH_HOSTS: readonly PipelineHost[] = [
  'worktree',
  'cowork',
  'app-advisor',
];
const COMMAND_ITEM_ID = 'cuttlefish-late-command';
const COMMAND_TOOL_USE_ID = `codex-${COMMAND_ITEM_ID}`;
const COMMAND_OUTPUT = 'cuttlefish-native-command-output';
const NEWER_PROMPT = 'cuttlefish newer root prompt';
const COMPLETION_TIMINGS = ['held', 'durable', 'newer-prompt'] as const;

const CUTTLEFISH_CASES = CUTTLEFISH_HOSTS.flatMap((host) =>
  COMPLETION_TIMINGS.map((timing) => ({ host, timing })),
);

const storageByEnvironment = new WeakMap<
  CuttlefishEnvironment,
  PipelineStorage
>();

async function createCuttlefishEnvironment(
  host: PipelineHost,
): Promise<CuttlefishEnvironment> {
  let capturedStorage: PipelineStorage | undefined;
  const env = await createScenarioEnvironment(host, 'codex', {
    prepareStorage: (storage): Promise<void> => {
      capturedStorage = storage;
      return Promise.resolve();
    },
  });
  if (!capturedStorage)
    throw new Error('Cuttlefish requires captured real pipeline storage');
  storageByEnvironment.set(env, capturedStorage);
  return env;
}

interface CodexEventEnvelope {
  event: Record<string, unknown>;
}

interface NativeCommandCompletion {
  turnId: string | null;
  itemId: string;
  aggregatedOutput: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function readCodexEvent(data: unknown): CodexEventEnvelope | null {
  if (!isRecord(data) || data.type !== 'codex' || !isRecord(data.event))
    return null;
  return { event: data.event };
}

function readNativeCommandCompletion(
  data: unknown,
): NativeCommandCompletion | null {
  const envelope = readCodexEvent(data);
  if (!envelope || envelope.event.type !== 'item.completed') return null;
  const item = envelope.event.item;
  if (!isRecord(item) || item.type !== 'command_execution') return null;
  const itemId = readString(item, 'id');
  const aggregatedOutput = readString(item, 'aggregated_output');
  if (itemId === null || aggregatedOutput === null) return null;
  return {
    turnId:
      readString(envelope.event, 'turn_id') ??
      readString(envelope.event, 'turnId'),
    itemId,
    aggregatedOutput,
  };
}

function latestRows(
  env: CuttlefishEnvironment,
  target: PipelineChatTarget,
): readonly PersistedChatMessage[] | undefined {
  const latest = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'revision' &&
        event.projectId === target.projectId &&
        event.worktreeId === target.worktreeId,
    );
  return latest?.kind === 'revision'
    ? latest.chats[target.chatId]?.rows
    : undefined;
}

function findCommandRow(
  rows: readonly PersistedChatMessage[] | undefined,
): PersistedChatMessage | undefined {
  return rows?.find((row) =>
    row.blocks.some(
      (block) =>
        block.type === 'tool_use' && block.toolUseId === COMMAND_TOOL_USE_ID,
    ),
  );
}

interface PersistedCommandResult {
  messageId: string;
  toolUseId: string;
  output: string;
  isError: boolean;
}

interface CuttlefishOutputManifest {
  stage: string;
  expected: {
    originalCommandRowId: string | null;
    toolUseId: string;
    output: string;
    nativeCompletionCount: number;
    persistedToolResultCount: 1;
  };
  emitted: {
    nativeCompletions: readonly NativeCommandCompletion[];
    persistedToolResults: readonly PersistedCommandResult[];
    durableTranscriptContainsAggregate: boolean;
  };
  missing: readonly string[];
}

function createOutputManifest(
  env: CuttlefishEnvironment,
  stage: string,
  expectedNativeCompletionCount: number,
  originalCommandRowId: string | null,
  nativeCompletions: readonly NativeCommandCompletion[],
): CuttlefishOutputManifest {
  const rows = latestRows(env, env.target);
  const persistedToolResults: PersistedCommandResult[] = [];
  for (const row of rows ?? []) {
    for (const block of row.blocks) {
      if (
        block.type === 'tool_result' &&
        block.toolUseId === COMMAND_TOOL_USE_ID
      ) {
        persistedToolResults.push({
          messageId: row.id,
          toolUseId: block.toolUseId,
          output: block.output,
          isError: block.isError,
        });
      }
    }
  }
  const storage = storageByEnvironment.get(env);
  const durableTranscriptContainsAggregate =
    storage
      ?.readCommittedTranscript(env.target)
      .toString('utf8')
      .includes(COMMAND_OUTPUT) ?? false;
  const missing: string[] = [];
  if (originalCommandRowId === null)
    missing.push('original native command row captured before terminal');
  if (nativeCompletions.length !== expectedNativeCompletionCount)
    missing.push(
      `native item.completed count ${expectedNativeCompletionCount}`,
    );
  if (
    persistedToolResults.length !== 1 ||
    persistedToolResults[0]?.messageId !== originalCommandRowId ||
    persistedToolResults[0]?.output !== COMMAND_OUTPUT ||
    persistedToolResults[0]?.isError !== false
  ) {
    missing.push(
      'exactly one aggregate tool_result on the original command row',
    );
  }
  if (!durableTranscriptContainsAggregate)
    missing.push('aggregate in committed durable transcript');
  return {
    stage,
    expected: {
      originalCommandRowId,
      toolUseId: COMMAND_TOOL_USE_ID,
      output: COMMAND_OUTPUT,
      nativeCompletionCount: expectedNativeCompletionCount,
      persistedToolResultCount: 1,
    },
    emitted: {
      nativeCompletions,
      persistedToolResults,
      durableTranscriptContainsAggregate,
    },
    missing,
  };
}

function assertOutputManifest(manifest: CuttlefishOutputManifest): void {
  const correctNativeCompletions =
    manifest.emitted.nativeCompletions.length ===
      manifest.expected.nativeCompletionCount &&
    manifest.emitted.nativeCompletions.every(
      (completion) =>
        completion.itemId === COMMAND_ITEM_ID &&
        completion.aggregatedOutput === COMMAND_OUTPUT,
    );
  if (manifest.missing.length > 0 || !correctNativeCompletions) {
    throw new Error(
      `Cuttlefish output manifest mismatch before production assertions:\n${JSON.stringify(manifest, null, 2)}`,
    );
  }
}

async function emitNativeCommandCompletion(
  env: CuttlefishEnvironment,
  turnKey: string,
  ledger: NativeCommandCompletion[],
): Promise<void> {
  // Record the native transport emission after the scripted stdio write has
  // resolved. Admission may reject the late event, which is the red proof.
  await emitScriptedCodexCommand(env.driver, turnKey, {
    itemId: COMMAND_ITEM_ID,
    output: COMMAND_OUTPUT,
    completed: true,
  });
  ledger.push({
    turnId: turnKey,
    itemId: COMMAND_ITEM_ID,
    aggregatedOutput: COMMAND_OUTPUT,
  });
}

function matchingCommandDropCalls(env: CuttlefishEnvironment): number {
  return env.harness.dropDiagnosticCalls.filter((drop) => {
    if (
      drop.projectId !== env.target.projectId ||
      drop.worktreeId !== env.target.worktreeId ||
      drop.chatId !== env.target.chatId
    ) {
      return false;
    }
    const completion = readNativeCommandCompletion(drop.data);
    return completion?.itemId === COMMAND_ITEM_ID;
  }).length;
}

function matchingCommandDropDiagnostics(
  env: CuttlefishEnvironment,
  turnKey: string,
): number {
  return env.harness.dropDiagnostics.filter(
    (record) =>
      record.kind === 'chat_event_dropped' &&
      record.projectId === env.target.projectId &&
      record.worktreeId === env.target.worktreeId &&
      record.chatId === env.target.chatId &&
      record.eventType === 'codex/item.completed' &&
      record.providerTurnId === turnKey,
  ).length;
}

function targetRevisionCount(env: CuttlefishEnvironment): number {
  return env.harness.recorder.events.filter(
    (event) =>
      event.kind === 'revision' &&
      event.projectId === env.target.projectId &&
      event.worktreeId === env.target.worktreeId,
  ).length;
}

function targetQueueGateSnapshot(env: CuttlefishEnvironment): unknown {
  const latest = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'queue' &&
        event.event.projectId === env.target.projectId &&
        event.event.worktreeId === env.target.worktreeId &&
        event.event.chatId === env.target.chatId,
    );
  return latest?.kind === 'queue'
    ? { queue: latest.event.queue, turnActive: latest.turnActive }
    : null;
}

interface CuttlefishStabilitySnapshot {
  runtime: unknown;
  queueGate: {
    latestBroadcast: unknown;
    queueTurnActive: boolean | null;
    sessionTurnActive: boolean | null;
    liveness: { foreground: boolean; background: boolean } | null;
  };
  settledTimers: readonly unknown[];
  terminalEffectCounts: readonly CuttlefishTerminalEffectCount[];
}

interface CuttlefishTerminalEffectCount {
  subkind: 'turn-diff' | 'code-review';
  identity: string;
  count: number;
}

async function stabilitySnapshot(
  env: CuttlefishEnvironment,
): Promise<CuttlefishStabilitySnapshot> {
  await env.harness.checkpoint('cuttlefish-stability', env.target);
  const rows = latestRows(env, env.target) ?? [];
  const settledTimers = rows.flatMap((row) =>
    row.blocks
      .filter(
        (block) => block.type === 'turn_timer' && block.completedAt !== null,
      )
      .map((block) => ({ messageId: row.id, timer: block })),
  );
  const latestRevision = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'revision' &&
        event.projectId === env.target.projectId &&
        event.worktreeId === env.target.worktreeId,
    );
  const latestCheckpoint = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'checkpoint' &&
        event.target !== undefined &&
        event.target.projectId === env.target.projectId &&
        event.target.worktreeId === env.target.worktreeId &&
        event.target.chatId === env.target.chatId,
    );
  const terminalEffectCounts: CuttlefishTerminalEffectCount[] = [];
  for (const event of env.harness.recorder.events) {
    if (event.kind !== 'effect' || event.effect.name !== 'terminal-effect') {
      continue;
    }
    const { effect: subkind, identity } = event.effect;
    const existingIndex = terminalEffectCounts.findIndex(
      (count) => count.subkind === subkind && count.identity === identity,
    );
    const existing =
      existingIndex === -1 ? undefined : terminalEffectCounts[existingIndex];
    const next: CuttlefishTerminalEffectCount = {
      subkind,
      identity,
      count: (existing?.count ?? 0) + 1,
    };
    if (existingIndex === -1) terminalEffectCounts.push(next);
    else terminalEffectCounts[existingIndex] = next;
  }
  return {
    runtime:
      latestRevision?.kind === 'revision'
        ? (latestRevision.chats[env.target.chatId]?.runtime ?? null)
        : null,
    queueGate: {
      latestBroadcast: targetQueueGateSnapshot(env),
      queueTurnActive:
        latestCheckpoint?.kind === 'checkpoint'
          ? (latestCheckpoint.queueTurnActive ?? null)
          : null,
      sessionTurnActive:
        latestCheckpoint?.kind === 'checkpoint'
          ? (latestCheckpoint.sessionTurnActive ?? null)
          : null,
      liveness:
        latestCheckpoint?.kind === 'checkpoint'
          ? (latestCheckpoint.liveness ?? null)
          : null,
    },
    settledTimers,
    terminalEffectCounts,
  };
}

function assertNoFalseLateCompletionDrop(
  env: CuttlefishEnvironment,
  turnKey: string,
): void {
  expect(matchingCommandDropCalls(env)).toBe(0);
  expect(matchingCommandDropDiagnostics(env, turnKey)).toBe(0);
}

/** Called by the parent incident suite; every row uses its real host adapter. */
export function registerCuttlefishIncidentTests(): void {
  it.each(CUTTLEFISH_CASES)(
    'cuttlefish: native Codex command completion at $timing is durable and idempotent on $host',
    async ({ host: hostKind, timing }) => {
      const env = await createCuttlefishEnvironment(hostKind);
      const completionLedger: NativeCommandCompletion[] = [];
      try {
        const root = await startRoot(env, 'cuttlefish native command root');
        // Synthetic native Codex item/started + outputDelta make the command
        // row visible before its intentionally delayed item/completed frame.
        await emitScriptedCodexCommand(env.driver, root.turnKey, {
          itemId: COMMAND_ITEM_ID,
          output: COMMAND_OUTPUT,
        });
        await env.host.drain();
        const originalCommandRowId =
          findCommandRow(latestRows(env, env.target))?.id ?? null;
        const revisionsBeforeHeldTerminal = targetRevisionCount(env);
        let newerRoot: Awaited<ReturnType<typeof startRoot>> | undefined;
        let revisionsWhileHeld = -1;
        let stableBeforeFirstCompletion:
          | CuttlefishStabilitySnapshot
          | undefined;

        if (timing === 'held') {
          env.harness.holdCommits();
          try {
            await root.complete();
            await emitNativeCommandCompletion(
              env,
              root.turnKey,
              completionLedger,
            );
            await env.harness.advanceLogicalClock(50);
            await new Promise<void>((resolve) => setImmediate(resolve));
            revisionsWhileHeld = targetRevisionCount(env);
          } finally {
            env.harness.releaseCommits();
          }
          await env.host.drain();
        } else {
          await root.complete();
          await env.host.drain();
          if (timing === 'newer-prompt') {
            newerRoot = await startRoot(env, NEWER_PROMPT);
          }
          stableBeforeFirstCompletion = await stabilitySnapshot(env);
          await emitNativeCommandCompletion(
            env,
            root.turnKey,
            completionLedger,
          );
          await env.host.drain();
        }

        const heldCommitManifest = createOutputManifest(
          env,
          `first completion at ${timing}`,
          1,
          originalCommandRowId,
          completionLedger,
        );
        assertOutputManifest(heldCommitManifest);
        if (stableBeforeFirstCompletion) {
          expect(await stabilitySnapshot(env)).toEqual(
            stableBeforeFirstCompletion,
          );
        }
        if (timing === 'held') {
          const targetFrames = env.harness.recorder.events.filter(
            (event): event is ProviderTraceEvent =>
              event.kind === 'provider' &&
              event.direction === 'to-canopy' &&
              event.target.chatId === env.target.chatId &&
              event.turnKey === root.turnKey,
          );
          const terminalSequence =
            targetFrames.find(
              (event) => event.type === 'notification:turn/completed',
            )?.seq ?? -1;
          const firstLateCompletionSequence =
            targetFrames.find(
              (event) =>
                event.type === 'notification:item/completed' &&
                event.seq > terminalSequence,
            )?.seq ?? -1;
          expect(revisionsWhileHeld).toBe(revisionsBeforeHeldTerminal);
          expect(terminalSequence).toBeGreaterThan(-1);
          expect(firstLateCompletionSequence).toBeGreaterThan(terminalSequence);
        }
        const firstStableState = await stabilitySnapshot(env);
        if (hostKind === 'worktree') {
          expect(firstStableState.terminalEffectCounts.length).toBeGreaterThan(
            0,
          );
        }
        if (timing === 'held') {
          expect(firstStableState.runtime).toMatchObject({
            status: 'completed',
          });
          expect(firstStableState.queueGate.sessionTurnActive).toBe(false);
          expect(firstStableState.queueGate.queueTurnActive).toBe(false);
        }
        assertNoFalseLateCompletionDrop(env, root.turnKey);

        let stableBeforeRepeat = await stabilitySnapshot(env);
        await emitNativeCommandCompletion(env, root.turnKey, completionLedger);
        await env.host.drain();
        const durableRepeatManifest = createOutputManifest(
          env,
          'duplicate completion after the terminal is durable',
          2,
          originalCommandRowId,
          completionLedger,
        );
        assertOutputManifest(durableRepeatManifest);
        expect(await stabilitySnapshot(env)).toEqual(stableBeforeRepeat);
        assertNoFalseLateCompletionDrop(env, root.turnKey);

        if (!newerRoot) newerRoot = await startRoot(env, NEWER_PROMPT);
        stableBeforeRepeat = await stabilitySnapshot(env);
        await emitNativeCommandCompletion(env, root.turnKey, completionLedger);
        await env.host.drain();
        const newerPromptRepeatManifest = createOutputManifest(
          env,
          'duplicate old completion after a newer root prompt starts',
          3,
          originalCommandRowId,
          completionLedger,
        );
        assertOutputManifest(newerPromptRepeatManifest);
        expect(await stabilitySnapshot(env)).toEqual(stableBeforeRepeat);
        assertNoFalseLateCompletionDrop(env, root.turnKey);

        await newerRoot.complete();
        await env.host.drain();
        await finishScenario(env, [11, 17]);
        const finalCheckpoint = [...env.harness.recorder.events]
          .reverse()
          .find(
            (event) =>
              event.kind === 'checkpoint' &&
              event.target !== undefined &&
              event.target.projectId === env.target.projectId &&
              event.target.worktreeId === env.target.worktreeId &&
              event.target.chatId === env.target.chatId,
          );
        expect(finalCheckpoint?.kind).toBe('checkpoint');
        if (finalCheckpoint?.kind === 'checkpoint') {
          expect(finalCheckpoint.sessionTurnActive).toBe(false);
          expect(finalCheckpoint.queueTurnActive).toBe(false);
        }
      } finally {
        env.harness.releaseCommits();
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );
}
