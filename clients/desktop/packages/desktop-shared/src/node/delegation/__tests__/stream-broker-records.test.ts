import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentDelegationEvent,
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  AgentDelegationBroker,
  type StoredDelegateOutput,
  type StoredDelegationControl,
  type StoredDelegationLegacy,
} from '../broker';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import { createDelegationRunState, reduceDelegationEvent } from '../lifecycle';
import {
  LocalDelegationRunner,
  type LocalDelegationContext,
  type LocalDelegationOutcome,
} from '../local-runner';
import { AgentRunnerRegistry } from '../runner-registry';
import {
  DELEGATION_STORAGE_RECORD_MAX_BYTES,
  FileDelegationStorage,
} from '../storage';
import type { DelegationTranscriptTarget } from '../transcript-port';
import type { AgentRunnerAdapter } from '../types';
import { baseTask, rootParent, waitForLaunch } from './broker-harness';
import { FakeRunner, routeFixture } from './fixtures';

const MIB = 1024 * 1024;
const KIB = 1024;

function localAdapter(
  streamBacked: boolean,
  outcome: LocalDelegationOutcome,
  previews?: { readonly partialText: string; readonly transcriptText: string },
): AgentRunnerAdapter {
  const local = new LocalDelegationRunner(
    'third-harness',
    'local-sdk',
    () => Promise.resolve({ available: true }),
    async (
      context: LocalDelegationContext,
    ): Promise<LocalDelegationOutcome> => {
      await context.emit({
        type: 'started',
        nativeSessionId: 'retained-native-session',
      });
      if (previews) {
        await context.emit({ type: 'progress', text: previews.partialText });
        await context.emit({
          type: 'transcript',
          items: [
            {
              id: 'preview',
              sequence: 1,
              occurredAt: 1,
              type: 'text',
              text: previews.transcriptText,
            },
          ],
        });
      }
      return outcome;
    },
    jest.fn(),
    {
      transcriptPort: new InMemoryDelegationTranscriptPort({
        owns: (): boolean => true,
      }),
    },
  );
  return {
    harnessId: local.harnessId,
    runtimeKind: local.runtimeKind,
    adapterVersion: local.adapterVersion,
    canRun: (route) => local.canRun(route),
    start: (request, sink): ReturnType<AgentRunnerAdapter['start']> => {
      if (!streamBacked) return local.start(request, sink);
      const target: DelegationTranscriptTarget = {
        kind: 'delegation',
        chatId: request.parent.chatId,
        delegationId: request.delegationId,
        runGeneration: request.runGeneration,
      };
      return local.start({ ...request, transcriptStream: { target } }, sink);
    },
    stop: (handle, reason) => local.stop(handle, reason),
    close: (handle) => local.close(handle),
  };
}

function createBroker(
  storage: FileDelegationStorage,
  adapter: AgentRunnerAdapter,
  onActivity?: jest.Mock,
): AgentDelegationBroker {
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter,
  });
  return new AgentDelegationBroker({
    storage,
    registry,
    cwd: '/test/worktree',
    capacity: 8,
    maxDepthForParent: (): number => 5,
    resolveRoute: (): Promise<{
      ok: true;
      value: ReturnType<typeof routeFixture>;
    }> =>
      Promise.resolve({
        ok: true,
        value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
      }),
    authorize: (): Promise<{ ok: true; value: undefined }> =>
      Promise.resolve({ ok: true, value: undefined }),
    ...(onActivity === undefined ? {} : { onActivity }),
  });
}

async function seedCompletedRecord(
  recordsDirectory: string,
  streamBacked: boolean,
  finalText: string,
  previews?: { readonly partialText: string; readonly transcriptText: string },
): Promise<{
  readonly storage: FileDelegationStorage;
  readonly record: StoredDelegationLegacy;
  readonly transcript: AgentDelegationTranscript;
}> {
  const storage = new FileDelegationStorage(recordsDirectory);
  const broker = createBroker(
    storage,
    localAdapter(streamBacked, { status: 'completed', finalText }, previews),
  );
  await broker.initialize();
  try {
    const spawned = await broker.spawn(rootParent, baseTask);
    if (!spawned.ok) throw new Error(spawned.error.message);
    const waited = await broker.wait(rootParent, {
      delegationIds: [spawned.value.delegationId],
      timeoutMs: 30_000,
    });
    if (!waited.ok) throw new Error(waited.error.message);
    if (waited.value.timedOut) throw new Error('Broker run did not settle');
    const record = await storage.loadOne(spawned.value.delegationId);
    if (!record) throw new Error('Expected the retained broker record');
    if (record.version === 3) throw new Error();
    const transcripts = await broker.transcripts(
      rootParent,
      spawned.value.delegationId,
    );
    const transcript = transcripts[0];
    if (!transcript) throw new Error('Expected a retained run transcript');
    return { storage, record, transcript };
  } finally {
    await broker.close();
  }
}

function fullBoundedRecord(
  record: StoredDelegationLegacy,
  transcript: AgentDelegationTranscript,
  finalText: string,
  partialText: string,
  transcriptPreview: string,
): StoredDelegationLegacy {
  const results: StoredDelegateOutput[] = Array.from(
    { length: 17 },
    (_, index): StoredDelegateOutput => {
      const runGeneration = index + 1;
      return {
        resultIndex: runGeneration,
        runGeneration,
        status: 'completed',
        settledAt: record.createdAt + runGeneration,
        finalText:
          runGeneration === 17
            ? finalText
            : `small exact result ${runGeneration}`,
        partialText,
        outputTruncated: false,
      };
    },
  );
  const history: AgentDelegationTranscript[] = [];
  for (let index = 0; index < 16; index += 1) {
    const runGeneration = index + 1;
    const transcriptItem: AgentDelegationTranscriptItem = {
      id: `history-${runGeneration}`,
      sequence: 1,
      occurredAt: runGeneration,
      type: 'text',
      text: `small history transcript ${runGeneration}`,
    };
    history.push({
      ...transcript,
      runGeneration,
      sequence: runGeneration,
      snapshot: {
        ...transcript.snapshot,
        runGeneration,
        resultIndex: runGeneration,
        finalText: `small exact history result ${runGeneration}`,
        partialText,
        outputTruncated: false,
      },
      transcript: [transcriptItem],
    });
  }
  const controls: StoredDelegationControl[] = Array.from(
    { length: 64 },
    (): StoredDelegationControl => ({
      operationId: randomUUID(),
      key: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      operation: 'follow_up',
      message: 'Small retained control receipt',
      status: 'completed',
    }),
  );
  const stopRequests: NonNullable<StoredDelegationLegacy['stopRequests']> =
    Array.from(
      { length: 64 },
      (): {
        operationId: string;
        key: string;
        runGeneration: number;
        status: 'completed';
      } => ({
        operationId: randomUUID(),
        key: 'c'.repeat(64),
        runGeneration: 17,
        status: 'completed',
      }),
    );
  const previewItem: AgentDelegationTranscriptItem = {
    id: 'one-mebibyte-preview',
    sequence: 1,
    occurredAt: 1,
    type: 'text',
    text: transcriptPreview,
  };
  return {
    ...record,
    history,
    results,
    controls,
    stopRequests,
    launch: { ...record.launch, runGeneration: 17 },
    state: {
      ...record.state,
      runGeneration: 17,
      transcript: [previewItem],
      partialText,
      finalText,
      outputTruncated: false,
    },
  };
}

describe('stream-backed broker record budgets', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(os.tmpdir(), 'delegation-stream-records-'),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps receipt-only broker events identity-preserving without commits or notifications', async () => {
    const storage = new FileDelegationStorage(
      path.join(directory, 'receipt-records'),
    );
    const runner = new FakeRunner('local-sdk');
    const onActivity = jest.fn();
    const broker = createBroker(storage, runner, onActivity);
    await broker.initialize();
    try {
      const spawned = await broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error(spawned.error.message);
      await waitForLaunch(runner, spawned.value.delegationId);
      const sink = runner.sinks.get(spawned.value.delegationId);
      if (!sink) throw new Error('Expected a broker event sink');
      const receiptEnvelope: AgentDelegationEvent = {
        delegationId: spawned.value.delegationId,
        runGeneration: 1,
        sequence: 1,
        occurredAt: Date.now(),
        event: {
          type: 'transcript_receipt',
          streamRevision: 1,
          mutationKey: 'a'.repeat(64),
          replayed: false,
          items: [{ id: 'receipt-row', itemRevision: 0, final: false }],
        },
      };
      const state = createDelegationRunState(spawned.value.delegationId, 1);
      expect(reduceDelegationEvent(state, receiptEnvelope)).toBe(state);
      const before = broker.inspect(rootParent, spawned.value.delegationId);
      const commits = jest.spyOn(storage, 'commit');
      commits.mockClear();
      onActivity.mockClear();

      await sink(receiptEnvelope);

      expect(commits).not.toHaveBeenCalled();
      expect(onActivity).not.toHaveBeenCalled();
      expect(broker.inspect(rootParent, spawned.value.delegationId)).toEqual(
        before,
      );
    } finally {
      await broker.close();
    }
  });

  it('commits and reloads the owned preview budget with capped result/history/receipt counts', async () => {
    const exactFinalText = '\u0000漢'.repeat(MIB / 4);
    const partialPreview = 'p'.repeat(64 * KIB);
    const transcriptPreview = 't'.repeat(MIB);
    const { storage, record, transcript } = await seedCompletedRecord(
      path.join(directory, 'bounded-records'),
      true,
      exactFinalText,
      { partialText: partialPreview, transcriptText: transcriptPreview },
    );
    const candidate = fullBoundedRecord(
      record,
      transcript,
      exactFinalText,
      partialPreview,
      transcriptPreview,
    );
    const serializedBytes = Buffer.byteLength(
      JSON.stringify(candidate),
      'utf8',
    );
    const finalTextBytes = Buffer.byteLength(exactFinalText, 'utf8');
    const escapedFinalTextBytes = Buffer.byteLength(
      JSON.stringify(exactFinalText),
      'utf8',
    );

    expect(finalTextBytes).toBe(MIB);
    expect(escapedFinalTextBytes).toBeGreaterThan(finalTextBytes);
    expect(candidate.results).toHaveLength(17);
    expect(candidate.history).toHaveLength(16);
    expect(candidate.controls).toHaveLength(64);
    expect(candidate.stopRequests).toHaveLength(64);
    expect(
      candidate.results?.every(
        (result) => result.partialText === partialPreview,
      ),
    ).toBe(true);
    expect(serializedBytes).toBeLessThan(DELEGATION_STORAGE_RECORD_MAX_BYTES);
    process.stdout.write(
      `S3 accepted record bytes=${serializedBytes}; exact-answer UTF-8=${finalTextBytes}; JSON-escaped answer=${escapedFinalTextBytes}; transcript preview=${Buffer.byteLength(transcriptPreview, 'utf8')}; partial copies=${17 * Buffer.byteLength(partialPreview, 'utf8')}\n`,
    );

    await storage.commit(candidate);

    const reloaded = await storage.loadOne(record.state.delegationId);
    if (reloaded?.version === 3) throw new Error();
    expect(reloaded?.state.finalText).toBe(exactFinalText);
    expect(reloaded?.state.outputTruncated).toBe(false);
    expect(reloaded?.results?.[16]?.finalText).toBe(exactFinalText);
    expect(reloaded?.results?.[16]?.outputTruncated).toBe(false);
    const firstTranscriptItem = reloaded?.state.transcript?.[0];
    if (firstTranscriptItem?.type !== 'text') {
      throw new Error('Expected the persisted text transcript preview');
    }
    expect(firstTranscriptItem.text).toBe(transcriptPreview);
    expect(
      reloaded?.results?.every(
        (result) => result.partialText === partialPreview,
      ),
    ).toBe(true);
  });

  it('refuses cumulative exact answers above the record limit in marked and legacy runs without shortening', async () => {
    const largeExactAnswer = 'x'.repeat(2 * MIB);
    for (const streamBacked of [true, false]) {
      const mode = streamBacked ? 'stream-backed' : 'legacy';
      const { storage, record } = await seedCompletedRecord(
        path.join(directory, `${mode}-cumulative-records`),
        streamBacked,
        largeExactAnswer,
      );
      const results: StoredDelegateOutput[] = Array.from(
        { length: 17 },
        (_, index): StoredDelegateOutput => ({
          resultIndex: index + 1,
          runGeneration: index + 1,
          status: 'completed',
          settledAt: record.createdAt + index + 1,
          finalText: largeExactAnswer,
          outputTruncated: false,
        }),
      );
      const candidate: StoredDelegationLegacy = {
        ...record,
        launch: { ...record.launch, runGeneration: 17 },
        results,
        state: {
          ...record.state,
          runGeneration: 17,
          finalText: largeExactAnswer,
          outputTruncated: false,
        },
      };
      const answerCopiesBytes =
        Buffer.byteLength(candidate.state.finalText ?? '', 'utf8') +
        results.reduce(
          (total, result) =>
            total + Buffer.byteLength(result.finalText ?? '', 'utf8'),
          0,
        );
      const serializedBytes = Buffer.byteLength(
        JSON.stringify(candidate),
        'utf8',
      );

      expect(answerCopiesBytes).toBeGreaterThan(
        DELEGATION_STORAGE_RECORD_MAX_BYTES,
      );
      expect(serializedBytes).toBeGreaterThan(
        DELEGATION_STORAGE_RECORD_MAX_BYTES,
      );
      expect(candidate.state.finalText).toBe(largeExactAnswer);
      expect(
        candidate.results?.every(
          (result) => result.finalText === largeExactAnswer,
        ),
      ).toBe(true);
      process.stdout.write(
        `S3 refused ${mode} cumulative record: exact-answer copies=${answerCopiesBytes}; serialized=${serializedBytes}; limit=${DELEGATION_STORAGE_RECORD_MAX_BYTES}\n`,
      );

      await expect(storage.commit(candidate)).rejects.toThrow(
        /record exceeds its byte bound/i,
      );
      const reloaded = await storage.loadOne(record.state.delegationId);
      if (reloaded?.version === 3) throw new Error();
      expect(reloaded?.state.finalText).toBe(largeExactAnswer);
      expect(reloaded?.state.outputTruncated).toBe(false);
      expect(reloaded?.results).toHaveLength(1);
      expect(reloaded?.results?.[0]?.finalText).toBe(largeExactAnswer);
      expect(reloaded?.results?.[0]?.outputTruncated).toBe(false);
    }
  });
});
