/**
 * Large-history provider-turn scenarios (64-byte text payload per row). History is migrated through the real
 * streaming ChatStorageV2 path once per size, then turns use the real host and
 * pipeline with only the scripted provider transport at the edge.
 */
import { TRANSCRIPT_PAGE_SIZE } from '@canopy/agent-transcript/transcript-storage';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { ChatMigrationEntry } from '../../lib/chat-storage-v2';
import type {
  PipelineHost,
  PipelineChatTarget,
  PipelineProvider,
  PipelineTraceEvent,
  RevisionTraceEvent,
  ScriptedProviderTurn,
} from './contracts';
import type { ScenarioEnvironment } from './scenarios';
import {
  createScenarioEnvironment,
  disposeScenario,
  finishScenario,
} from './scenarios';
import type { PipelineStorage } from './storage';

// Row count, not fixture payload inflation, is the scaling dimension here.
const HISTORY_TEXT_LENGTH = 64;
const PROVIDER_TURN_WAIT_MS = 30_000;
const MEASURED_TURNS = 9;
const PAGE_READ_ALLOWANCE_OVER_BASELINE = 2;
export const LATENCY_TEST_TIMEOUT_MS = 180_000;
export const ABSOLUTE_TIMING_OPT_IN = 'CANOPY_PIPELINE_ABSOLUTE';

export interface TranscriptReadProbeResult {
  committedRowsRead: number;
  fullReadRows: number;
  pageReads: number;
  maxPageRows: number;
}

export interface ProviderTurnLatencyMeasurement {
  turnNumber: number;
  handoffMs: number;
  reads: TranscriptReadProbeResult;
}

export interface ProviderTurnLatencyRun {
  host: PipelineHost;
  provider: PipelineProvider;
  historyRows: number;
  measurements: readonly ProviderTurnLatencyMeasurement[];
  /** Real rewrite diagnostics observed before provider consumption. */
  turnStartRewriteCount: number;
}

interface TranscriptReadProbe {
  begin(): void;
  finish(): TranscriptReadProbeResult;
  stop(): void;
}

function messageText(message: PersistedChatMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function historyRow(chatId: string, rowNumber: number): PersistedChatMessage {
  return {
    id: `${chatId}-history-${String(rowNumber).padStart(5, '0')}`,
    role: 'assistant',
    timestamp: 1_792_000_000_000 + rowNumber,
    blocks: [{ type: 'text', text: 'x'.repeat(HISTORY_TEXT_LENGTH) }],
  };
}

async function* historyRows(
  chatId: string,
  count: number,
): AsyncGenerator<PersistedChatMessage> {
  await Promise.resolve();
  for (let rowNumber = 0; rowNumber < count; rowNumber += 1)
    yield historyRow(chatId, rowNumber);
}

/** Migrate directly into the destination before the harness loads any scope. */
export async function seedLatencyHistory(
  storage: PipelineStorage,
  target: PipelineChatTarget,
  rowCount: number,
): Promise<void> {
  if (!Number.isSafeInteger(rowCount) || rowCount < 1)
    throw new Error(`Invalid latency history row count: ${rowCount}`);
  const { ChatStorageV2 } = await import('../../lib/chat-storage-v2');
  const source = ChatStorageV2.fromLegacyPaths(storage.pathsFor(target));
  await source.migrate(() =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: target.chatId, runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
        await Promise.resolve();
        yield {
          metadata: {
            id: target.chatId,
            title: `Latency history (${rowCount} rows)`,
            createdAt: '2026-10-17T00:00:00.000Z',
            providerType: 'claude',
          },
          messages: historyRows(target.chatId, rowCount),
        };
      })(),
    }),
  );
  const indexes = await source.indexes();
  const seeded = indexes.live.tabs.find((tab) => tab.id === target.chatId);
  if (seeded?.transcript.committedMessageCount !== rowCount)
    throw new Error(
      `Expected ${rowCount} migrated rows, got ${seeded?.transcript.committedMessageCount ?? 0}`,
    );
}

async function installTranscriptReadProbe(): Promise<TranscriptReadProbe> {
  // Load the prototype after createScenarioEnvironment resets modules so the
  // spies observe the same ChatTranscriptLog instance used by the harness.
  const { ChatTranscriptLog } = await import('../../lib/chat-transcript-log');
  type TranscriptLog = InstanceType<typeof ChatTranscriptLog>;
  let measuring = false;
  let committedRowsRead = 0;
  let fullReadRows = 0;
  let pageReads = 0;
  let maxPageRows = 0;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalIterate = ChatTranscriptLog.prototype.iterate;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalIterateLogical = ChatTranscriptLog.prototype.iterateLogical;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalPage = ChatTranscriptLog.prototype.pageWithActiveMessages;

  jest
    .spyOn(ChatTranscriptLog.prototype, 'iterate')
    .mockImplementation(async function* (
      this: TranscriptLog,
      chatId: string,
    ): AsyncGenerator<PersistedChatMessage> {
      for await (const message of originalIterate.call(this, chatId)) {
        if (measuring) {
          committedRowsRead += 1;
          fullReadRows += 1;
        }
        yield message;
      }
    });
  jest
    .spyOn(ChatTranscriptLog.prototype, 'iterateLogical')
    .mockImplementation(async function* (
      this: TranscriptLog,
      chatId: string,
    ): AsyncGenerator<PersistedChatMessage> {
      for await (const message of originalIterateLogical.call(this, chatId)) {
        if (measuring) {
          committedRowsRead += 1;
          fullReadRows += 1;
        }
        yield message;
      }
    });

  type PageArguments = Parameters<TranscriptLog['pageWithActiveMessages']>;
  type PageResult = Awaited<
    ReturnType<TranscriptLog['pageWithActiveMessages']>
  >;
  jest
    .spyOn(ChatTranscriptLog.prototype, 'pageWithActiveMessages')
    .mockImplementation(async function (
      this: TranscriptLog,
      ...args: PageArguments
    ): Promise<PageResult> {
      const result = await originalPage.apply(this, args);
      if (measuring) {
        committedRowsRead += result.page.messages.length;
        pageReads += 1;
        maxPageRows = Math.max(maxPageRows, result.page.messages.length);
      }
      return result;
    });

  return {
    begin(): void {
      committedRowsRead = 0;
      fullReadRows = 0;
      pageReads = 0;
      maxPageRows = 0;
      measuring = true;
    },
    finish(): TranscriptReadProbeResult {
      measuring = false;
      return { committedRowsRead, fullReadRows, pageReads, maxPageRows };
    },
    stop(): void {
      measuring = false;
    },
  };
}

function ordinaryPromptFrame(
  event: PipelineTraceEvent,
  env: ScenarioEnvironment,
  prompt: string,
): boolean {
  if (
    event.kind !== 'provider' ||
    event.provider !== env.host.provider ||
    event.direction !== 'to-provider' ||
    event.target.projectId !== env.target.projectId ||
    event.target.worktreeId !== env.target.worktreeId ||
    event.target.chatId !== env.target.chatId ||
    !event.text?.includes(prompt)
  )
    return false;
  return (
    (event.provider === 'claude' && event.type === 'prompt') ||
    (event.provider === 'codex' && event.type === 'client:turn/start')
  );
}

function promptCommit(
  event: PipelineTraceEvent,
  chatId: string,
  prompt: string,
): event is RevisionTraceEvent {
  if (event.kind !== 'revision') return false;
  const rows = event.chats[chatId]?.rows;
  return Boolean(
    rows?.some((row) => row.role === 'user' && messageText(row) === prompt),
  );
}

/** Observe the real compatibility writer without selecting an unselected transcript.
 * Cowork's prompt commit publishes metadata only. Bind its real listener event
 * to the exact prompt passed to that writer, rather than timing a later capture.
 */
async function observeCoworkPromptCommits(env: ScenarioEnvironment): Promise<{
  commits: Map<string, RevisionTraceEvent>;
  stop: () => void;
}> {
  const commits = new Map<string, RevisionTraceEvent>();
  const tabs = await import('../../lib/chat-tabs');
  const original = tabs.writeChatTabsFile;
  const spy = jest
    .spyOn(tabs, 'writeChatTabsFile')
    .mockImplementation(async (...args) => {
      const [projectId, worktreeId, data] = args;
      const tab = data.tabs.find((item) => item.id === env.target.chatId);
      const descriptor =
        tab && Object.getOwnPropertyDescriptor(tab, 'messages');
      const messages: readonly PersistedChatMessage[] =
        descriptor && 'value' in descriptor && Array.isArray(descriptor.value)
          ? descriptor.value
          : [];
      const prompts = messages
        .filter((row) => row.role === 'user')
        .map(messageText);
      const firstEvent = env.harness.recorder.events.length;
      await original(...args);
      if (
        projectId !== env.target.projectId ||
        worktreeId !== env.target.worktreeId
      )
        return;
      const revisions = env.harness.recorder.events
        .slice(firstEvent)
        .filter(
          (event): event is RevisionTraceEvent =>
            event.kind === 'revision' &&
            event.projectId === projectId &&
            event.worktreeId === worktreeId,
        );
      const committed = revisions[revisions.length - 1];
      if (committed)
        for (const prompt of prompts) {
          if (!commits.has(prompt)) commits.set(prompt, committed);
        }
    });
  return {
    commits,
    stop: (): void => {
      spy.mockRestore();
    },
  };
}

/** Seed once, then measure commit-to-provider handoff for each completed root turn. */
export async function runLatencyScenario(
  env: ScenarioEnvironment,
  historyRowCount: number,
  measuredTurns: number,
): Promise<ProviderTurnLatencyRun> {
  if (!Number.isSafeInteger(measuredTurns) || measuredTurns < 1)
    throw new Error(`Invalid measured turn count: ${measuredTurns}`);

  await env.host.drain();
  await env.harness.checkpoint('latency-seeded', env.target);
  const probe = await installTranscriptReadProbe();
  const measurements: ProviderTurnLatencyMeasurement[] = [];
  let turnStartRewriteCount = 0;
  const coworkObserver =
    env.host.host === 'cowork'
      ? await observeCoworkPromptCommits(env)
      : undefined;

  try {
    for (let turnNumber = 1; turnNumber <= measuredTurns; turnNumber += 1) {
      const prompt = `provider latency probe ${turnNumber}`;
      const firstEvent = env.harness.recorder.events.length;
      probe.begin();
      let turn: ScriptedProviderTurn | undefined;
      try {
        const sending = env.host.send({ text: prompt });
        turn = await env.driver.nextTurn({
          timeoutMs: PROVIDER_TURN_WAIT_MS,
        });
        if (!turn.prompt.includes(prompt))
          throw new Error(`Provider did not receive ${prompt}`);

        const trace = env.harness.recorder.events.slice(firstEvent);
        const reads = probe.finish();
        // Settle the actual root send before assertions, including failure paths.
        // Response generation and all byte/prefix captures remain unmeasured.
        await turn.emitText(`latency response ${turnNumber}`);
        const sent = await sending;
        await turn.complete();
        await env.host.drain();
        const committed =
          coworkObserver?.commits.get(prompt) ??
          trace.find((event) => promptCommit(event, env.target.chatId, prompt));
        const handedOff = trace.find((event) =>
          ordinaryPromptFrame(event, env, prompt),
        );
        if (!committed || !handedOff)
          throw new Error(
            `Missing committed prompt or provider handoff for ${prompt}: ${JSON.stringify(trace.slice(-12))}`,
          );
        if (handedOff.at < committed.at)
          throw new Error(
            `Provider handoff preceded the prompt commit for ${prompt}`,
          );

        const rewritesBeforeHandoff = trace.filter(
          (event) =>
            event.kind === 'effect' &&
            event.effect.name === 'transcript-rewrite' &&
            event.seq <= handedOff.seq,
        );
        turnStartRewriteCount += rewritesBeforeHandoff.length;

        measurements.push({
          turnNumber,
          handoffMs: handedOff.at - committed.at,
          reads,
        });

        const committedRows = committed.chats[env.target.chatId]?.rows;
        if (
          env.host.host !== 'cowork' &&
          !committedRows?.some(
            (row) =>
              row.id === sent.userMessageId && messageText(row) === prompt,
          )
        )
          throw new Error(`Committed prompt identity mismatch for ${prompt}`);
      } finally {
        probe.stop();
      }
    }
  } finally {
    probe.stop();
    coworkObserver?.stop();
  }

  return {
    host: env.host.host,
    provider: env.host.provider,
    historyRows: historyRowCount,
    measurements,
    turnStartRewriteCount,
  };
}

export function percentile(
  measurements: readonly ProviderTurnLatencyMeasurement[],
  quantile: number,
): number {
  if (measurements.length === 0) return 0;
  if (quantile < 0 || quantile > 1)
    throw new Error(`Invalid percentile quantile: ${quantile}`);
  const values = measurements
    .map((measurement) => measurement.handoffMs)
    .sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(values.length * quantile));
  return values[rank - 1] ?? 0;
}

export function maxReadCount(
  run: ProviderTurnLatencyRun,
  field: keyof TranscriptReadProbeResult,
): number {
  return run.measurements.reduce(
    (maximum, measurement) => Math.max(maximum, measurement.reads[field]),
    0,
  );
}

/** Ensure each measured prompt was joined to a later ordinary provider handoff. */
export function assertLatencyTracePairing(run: ProviderTurnLatencyRun): void {
  for (const measurement of run.measurements) {
    if (!Number.isFinite(measurement.handoffMs) || measurement.handoffMs < 0)
      throw new Error(
        `Invalid prompt handoff latency for turn ${measurement.turnNumber}`,
      );
  }
}

export async function runLatencyAndFinish(
  host: PipelineHost,
  historyRows: number,
): Promise<ProviderTurnLatencyRun> {
  const env = await createScenarioEnvironment(host, 'claude', {
    captureRows: true,
    captureTranscript: 'checkpoint',
    prepareStorage: (storage, target) =>
      seedLatencyHistory(storage, target, historyRows),
  });
  try {
    const run = await runLatencyScenario(env, historyRows, MEASURED_TURNS);
    expect(run.measurements).toHaveLength(MEASURED_TURNS);
    logLatencyRun(run);
    // Keep diagnostics strict, but collect all nine samples even for the
    // documented Advisor expected failure so its measurements remain visible.
    expect(run.turnStartRewriteCount).toBe(0);
    await finishScenario(env, [11, 17]);
    assertLatencyTracePairing(run);
    assertTranscriptPrefixPreserved(env);
    assertReadProbeBounds(run);
    assertOptionalAbsoluteTiming(run);
    return run;
  } finally {
    await disposeScenario(env);
  }
}

function assertTranscriptPrefixPreserved(env: ScenarioEnvironment): void {
  const captures = env.harness.recorder.events.filter(
    (event) =>
      event.kind === 'transcript' &&
      event.target.projectId === env.target.projectId &&
      event.target.worktreeId === env.target.worktreeId &&
      event.target.chatId === env.target.chatId,
  );
  expect(captures).toHaveLength(2);
  const seeded = captures[0];
  const final = captures[1];
  if (seeded?.kind !== 'transcript' || final?.kind !== 'transcript')
    throw new Error('Expected seeded and final transcript captures');
  expect(seeded.committedBytes).toBeGreaterThan(0);
  expect(seeded.previous).toBeUndefined();
  expect(final.previous?.committedBytes).toBe(seeded.committedBytes);
  expect(final.previous?.sha256).toBe(seeded.sha256);
  expect(final.previous?.prefixSha256).toBe(seeded.sha256);
  expect(final.committedBytes).toBeGreaterThan(seeded.committedBytes);
}

function assertReadProbeBounds(run: ProviderTurnLatencyRun): void {
  expect(maxReadCount(run, 'fullReadRows')).toBe(0);
  expect(maxReadCount(run, 'maxPageRows')).toBeLessThanOrEqual(
    TRANSCRIPT_PAGE_SIZE + 16,
  );
}

export function assertNoReadGrowth(
  run: ProviderTurnLatencyRun,
  baseline: ProviderTurnLatencyRun | undefined,
): void {
  if (!baseline) return;
  expect(maxReadCount(run, 'pageReads')).toBeLessThanOrEqual(
    maxReadCount(baseline, 'pageReads') + PAGE_READ_ALLOWANCE_OVER_BASELINE,
  );
}

function assertOptionalAbsoluteTiming(run: ProviderTurnLatencyRun): void {
  if (process.env[ABSOLUTE_TIMING_OPT_IN] !== '1') return;
  expect(percentile(run.measurements, 0.95)).toBeLessThan(2_000);
}

function logLatencyRun(run: ProviderTurnLatencyRun): void {
  process.stdout.write(
    `[provider-turn-latency] ${JSON.stringify({
      host: run.host,
      provider: run.provider,
      historyRows: run.historyRows,
      measuredTurns: run.measurements.length,
      p50Ms: percentile(run.measurements, 0.5),
      p95Ms: percentile(run.measurements, 0.95),
      maxCommittedRowsRead: maxReadCount(run, 'committedRowsRead'),
      maxFullReadRows: maxReadCount(run, 'fullReadRows'),
      maxPageReads: maxReadCount(run, 'pageReads'),
      maxPageRows: maxReadCount(run, 'maxPageRows'),
      turnStartRewriteCount: run.turnStartRewriteCount,
      absoluteTiming: process.env[ABSOLUTE_TIMING_OPT_IN] === '1',
    })}\n`,
  );
}
