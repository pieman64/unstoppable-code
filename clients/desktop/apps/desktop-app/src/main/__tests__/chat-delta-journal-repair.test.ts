import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type {
  DelegationTranscriptReceiptEntry,
  DelegationTranscriptSettleRequest,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { fitDelegationStopReceipt } from '@canopy/desktop-shared/node/delegation/receipt-reply';
import { delegationTranscriptSettlementDigest } from '@canopy/desktop-shared/node/delegation/settlement-identity';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  promoteToFormat4Journal,
  type ChatDeltaJournalWriterOptions,
  type DeltaJournalBoundary,
} from '../lib/chat-delta-journal/writer';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';

const target: DelegationTranscriptTarget = {
  kind: 'delegation',
  chatId: 'chat',
  delegationId: 'repair',
  runGeneration: 0,
};

const openRow: DelegationChildRow = {
  ...message('repair:item', 'stored open content', 'assistant', 42),
  parentBlockId: 'repair',
  delegationSequence: 0,
  itemRevision: 0,
  final: false,
};

async function seedRows(
  writer: ChatDeltaJournalWriter,
  rows: readonly DelegationChildRow[],
  mutationId: string,
  registerStream = true,
): Promise<void> {
  const current = writer.indexes();
  const revision = current.live.revision + 1;
  await writer.commit({
    expectedRevision: current.live.revision,
    next: {
      live: { ...current.live, revision },
      archive: { ...current.archive, revision },
      recovery: {
        ...current.recovery,
        mutationIds: [...current.recovery.mutationIds, mutationId],
      },
    },
    writes: [],
    mutationIds: [mutationId],
    ...(registerStream
      ? {
          streamRegistrations: [
            { target, streamKey: delegationStreamKey(target), openedAt: 3 },
          ],
        }
      : {}),
    childWrites: [{ target, rows: [...rows] }],
  });
}

async function seedOpenRow(
  writer: ChatDeltaJournalWriter,
  row: DelegationChildRow = openRow,
  mutationId = 'seed-open',
  registerStream = true,
): Promise<void> {
  return seedRows(writer, [row], mutationId, registerStream);
}

async function finalizeMutation(
  writer: ChatDeltaJournalWriter,
  finalRows: readonly DelegationChildRow[] = [],
): ReturnType<ChatDeltaJournalWriter['settleDelegationResult']> {
  const descriptor = await writer.childDescriptor(target);
  if (!descriptor) throw new Error('The repair stream was not registered.');
  const request: DelegationTranscriptSettleRequest = {
    target,
    settlementKey: 'repair-settlement',
    resultIndex: 1,
    outcome: { status: 'completed', finishedAt: 43 },
    finalChanges: finalRows.map((row) => ({ row })),
    answer: null,
    openRows: 'finalize',
  };
  return writer.settleDelegationResult({
    target,
    mutationId: 'repair-mutation',
    mutationKey: 'repair-admission',
    finalRows,
    descriptorSettle: { expectedStreamRevision: descriptor.streamRevision },
    resultEntry: {
      version: 1,
      kind: 'result',
      resultIndex: request.resultIndex,
      runGeneration: target.runGeneration,
      settlementKey: request.settlementKey,
      settlementDigest: delegationTranscriptSettlementDigest(request),
      outcome: request.outcome,
    },
    answerBody: request.answer,
    openRows: 'finalize',
  });
}

async function lostFinalizeMutation(
  writer: ChatDeltaJournalWriter,
): ReturnType<ChatDeltaJournalWriter['settleDelegationResult']> {
  const answer: DelegationTranscriptSettleRequest['answer'] = {
    role: 'final',
    lost: { sha256: 'a'.repeat(64), length: 18 },
  };
  const request: DelegationTranscriptSettleRequest = {
    target,
    settlementKey: 'repair-lost-settlement',
    resultIndex: 1,
    outcome: { status: 'completed', finishedAt: 43 },
    finalChanges: [],
    answer,
    openRows: 'finalize',
  };
  const descriptor = await writer.childDescriptor(target);
  if (!descriptor) throw new Error('The repair stream was not registered.');
  return writer.settleDelegationResult({
    target,
    mutationId: 'repair-lost-mutation',
    mutationKey: 'repair-lost-admission',
    finalRows: [],
    descriptorSettle: { expectedStreamRevision: descriptor.streamRevision },
    resultEntry: {
      version: 1,
      kind: 'result',
      resultIndex: request.resultIndex,
      runGeneration: target.runGeneration,
      settlementKey: request.settlementKey,
      settlementDigest: delegationTranscriptSettlementDigest(request),
      outcome: request.outcome,
    },
    answerBody: answer,
    openRows: 'finalize',
  });
}

function stopReceipt(): DelegationTranscriptReceiptEntry {
  const fitted = fitDelegationStopReceipt(
    {
      chatId: target.chatId,
      receiptKind: 'stop',
      key: 'b'.repeat(64),
      delegationId: target.delegationId,
      runGeneration: 1,
      operationId: '00000000-0000-4000-8000-000000000001',
      requestHash: 'c'.repeat(64),
      operation: 'stop',
      admittedAt: 42,
    },
    'accepted',
  );
  if (!fitted.ok) throw new Error(fitted.reason);
  return fitted.entry;
}

function receiptIdentity(
  entry: DelegationTranscriptReceiptEntry,
): Pick<DelegationTranscriptReceiptEntry, 'chatId' | 'receiptKind' | 'key'> {
  return {
    chatId: entry.chatId,
    receiptKind: entry.receiptKind,
    key: entry.key,
  };
}

async function artifactFiles(store: ChatStorageV2): Promise<string[]> {
  try {
    return await readdir(
      join(store.directory, 'transcripts', 'tool-output', 'chat'),
    );
  } catch {
    return [];
  }
}

function prefixRow(sequence: number): DelegationChildRow {
  return {
    ...message(
      `repair:prefix-${String(sequence).padStart(3, '0')}`,
      'same length prefix text',
      'assistant',
      42,
    ),
    parentBlockId: 'repair',
    delegationSequence: sequence,
    itemRevision: 0,
    final: true,
  };
}

async function format4Scope(
  root: string,
  options: ChatDeltaJournalWriterOptions = {},
): Promise<{ store: ChatStorageV2; writer: ChatDeltaJournalWriter }> {
  const store = new ChatStorageV2(root, 'scope', undefined, {
    maxManifestVersion: 4,
  });
  await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
  await promoteToDeltaJournal(store);
  const writer = await promoteToFormat4Journal(store, options);
  return { store, writer };
}

describe('delta-journal trusted repair settlement', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-repair-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finalizes remaining open rows atomically and records P8 admission metadata', async () => {
    const store = new ChatStorageV2(root, 'scope', undefined, {
      maxManifestVersion: 4,
    });
    await store.migrate(scopeSource([{ id: 'chat', messages: [] }]));
    await promoteToDeltaJournal(store);
    const writer = await promoteToFormat4Journal(store);
    await seedOpenRow(writer);

    const settled = await finalizeMutation(writer);

    expect(settled.settlement).toMatchObject({
      streamRevision: 2,
      contentRevision: 2,
      finalItemCount: 1,
      replayed: false,
    });
    expect((await writer.childPage(target)).rows).toEqual([
      { ...openRow, itemRevision: 1, final: true },
    ]);
    await expect(
      writer.itemAdmission({
        target,
        messageId: openRow.id,
        itemRevision: 1,
      }),
    ).resolves.toEqual({
      id: openRow.id,
      itemRevision: 1,
      admittingStreamRevision: 2,
      mutationKey: 'repair-admission',
    });
    const descriptor = await writer.childDescriptor(target);
    const settleReceipt = descriptor?.settleReceipt;
    if (!settleReceipt) throw new Error('The finalize receipt was not stored.');
    expect(settleReceipt.mutationId).toBe('repair-settlement');
    expect(settleReceipt.scopeRevision).toBe(writer.indexes().live.revision);
    expect(settleReceipt.streamRevision).toBe(2);
    expect(settleReceipt.committedRowCount).toBe(1);
    expect(typeof settleReceipt.committedByteLength).toBe('number');
    expect(settleReceipt.committedSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(finalizeMutation(writer)).resolves.toMatchObject({
      settlement: { replayed: true },
    });
  });

  it('finalizes mixed open tool inputs and preserves existing references', async () => {
    const { store, writer } = await format4Scope(root);
    const artifacts = new ChatTranscriptArtifacts(
      join(store.directory, 'transcripts'),
    );
    const textRef = await artifacts.put('chat', 'existing referenced text');
    const fullOutputRef = await artifacts.put(
      'chat',
      'existing referenced tool output',
    );
    const largeInput = 'é'.repeat(50_000);
    const smallInputRow: DelegationChildRow = {
      ...message('repair:small-input', '', 'assistant', 42),
      parentBlockId: 'repair',
      delegationSequence: 0,
      itemRevision: 0,
      final: false,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'repair:small-input-call',
          toolName: 'shell',
          input: 'small input stays inline',
        },
      ],
    };
    const largeInputRow: DelegationChildRow = {
      ...message('repair:large-input', '', 'assistant', 43),
      parentBlockId: 'repair',
      delegationSequence: 1,
      itemRevision: 0,
      final: false,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'repair:large-input-call',
          toolName: 'shell',
          input: largeInput,
        },
      ],
    };
    const explicitFinal: DelegationChildRow = {
      ...message('repair:referenced-final', '', 'assistant', 44),
      parentBlockId: 'repair',
      delegationSequence: 2,
      itemRevision: 0,
      final: true,
      blocks: [
        { type: 'text', text: 'existing referenced text', textRef },
        {
          type: 'tool_result',
          toolUseId: 'repair:large-input-call',
          toolName: 'shell',
          output: 'existing referenced tool output',
          isError: false,
          fullOutputRef,
        },
      ],
    };
    await seedRows(writer, [smallInputRow, largeInputRow], 'seed-open-mixed');

    const settled = await finalizeMutation(writer, [explicitFinal]);

    expect(settled.settlement.finalItemCount).toBe(3);
    const rows = await writer.childPage(target);
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows[0]).toEqual({
      ...smallInputRow,
      itemRevision: 1,
      final: true,
    });
    const smallToolUse = rows.rows[0]?.blocks[0];
    if (smallToolUse?.type !== 'tool_use')
      throw new Error('The small tool input row was not preserved.');
    expect(smallToolUse.input).toBe('small input stays inline');
    expect(smallToolUse.inputRef).toBeUndefined();

    expect(rows.rows[1]).toMatchObject({
      id: largeInputRow.id,
      itemRevision: 1,
      final: true,
    });
    const largeToolUse = rows.rows[1]?.blocks[0];
    if (largeToolUse?.type !== 'tool_use' || !largeToolUse.inputRef)
      throw new Error('The large tool input was not externalized.');
    expect(largeToolUse.input.length).toBeLessThan(largeInput.length);
    const restoredInput = await artifacts.readRange(
      'chat',
      largeToolUse.inputRef,
      0,
      1024,
    );
    expect(restoredInput.byteLength).toBe(Buffer.byteLength(largeInput));
    expect(restoredInput.text).toBe(
      largeInput.slice(0, restoredInput.text.length),
    );

    expect(rows.rows[2]).toEqual(explicitFinal);
    const explicitText = rows.rows[2]?.blocks[0];
    const explicitToolResult = rows.rows[2]?.blocks[1];
    expect(explicitText).toMatchObject({ textRef });
    expect(explicitToolResult).toMatchObject({ fullOutputRef });
    await expect(
      writer.itemAdmission({
        target,
        messageId: largeInputRow.id,
        itemRevision: 1,
      }),
    ).resolves.toMatchObject({
      admittingStreamRevision: 2,
      mutationKey: 'repair-admission',
    });
  });

  it('records a lost answer during repair without inventing a body', async () => {
    const { writer } = await format4Scope(root);
    await seedOpenRow(writer);

    const settled = await lostFinalizeMutation(writer);

    expect(settled.result.answer).toEqual({
      kind: 'lost',
      role: 'final',
      sha256: 'a'.repeat(64),
      length: 18,
    });
    await expect(
      writer.resultAnswerRange({
        chatId: target.chatId,
        delegationId: target.delegationId,
        resultIndex: 1,
        offset: 0,
        limit: 64,
      }),
    ).rejects.toMatchObject({ failure: { code: 'answer_unavailable' } });
  });

  it.each(['finalize-artifact', 'finalize-journal'] as const)(
    'discards prepared artifacts and leaves open rows intact after %s failure',
    async (faultPoint: DeltaJournalBoundary) => {
      let armed = false;
      let failOnce = true;
      const { store, writer } = await format4Scope(root, {
        onBoundary: (boundary) => {
          if (armed && failOnce && boundary === faultPoint) {
            failOnce = false;
            return Promise.reject(new Error(`injected ${faultPoint}`));
          }
          return Promise.resolve();
        },
      });
      const longRow: DelegationChildRow = {
        ...openRow,
        blocks: [{ type: 'text', text: 'x'.repeat(50_000) }],
      };
      await seedOpenRow(writer, longRow);
      armed = true;

      await expect(finalizeMutation(writer)).rejects.toThrow(
        `injected ${faultPoint}`,
      );
      expect(await artifactFiles(store)).toEqual([]);
      await expect(writer.childPage(target)).resolves.toMatchObject({
        rows: [longRow],
      });

      const settled = await finalizeMutation(writer);
      expect(settled.settlement).toMatchObject({
        finalItemCount: 1,
        replayed: false,
      });
    },
  );

  it('recovers a finalized transcript after checkpoint materialization fails', async () => {
    let armed = false;
    let failOnce = true;
    const { store, writer } = await format4Scope(root, {
      onBoundary: (boundary) => {
        if (armed && failOnce && boundary === 'finalize-checkpoint') {
          failOnce = false;
          return Promise.reject(
            new Error('injected checkpoint materialization'),
          );
        }
        return Promise.resolve();
      },
    });
    await seedOpenRow(writer);
    await finalizeMutation(writer);
    armed = true;

    await expect(writer.checkpoint()).rejects.toThrow(
      'injected checkpoint materialization',
    );

    const reopened = await ChatDeltaJournalWriter.open(store);
    await expect(reopened.childPage(target)).resolves.toEqual({
      rows: [{ ...openRow, itemRevision: 1, final: true }],
    });
    await expect(finalizeMutation(reopened)).resolves.toMatchObject({
      settlement: { replayed: true },
    });
  });

  it('does not expose a receipt when its effect append boundary fails', async () => {
    let armed = false;
    let failOnce = true;
    const { writer } = await format4Scope(root, {
      onBoundary: (boundary) => {
        if (armed && failOnce && boundary === 'receipt-effect') {
          failOnce = false;
          return Promise.reject(new Error('injected receipt effect append'));
        }
        return Promise.resolve();
      },
    });
    const entry = stopReceipt();
    const mutation = { mutationId: 'repair-receipt-mutation', entry };
    armed = true;

    await expect(writer.appendDelegationReceipt(mutation)).rejects.toThrow(
      'injected receipt effect append',
    );
    await expect(
      writer.receipt(receiptIdentity(entry)),
    ).resolves.toBeUndefined();

    await expect(
      writer.appendDelegationReceipt(mutation),
    ).resolves.toMatchObject({
      entry,
      replayed: false,
    });
    await expect(writer.receipt(receiptIdentity(entry))).resolves.toEqual(
      entry,
    );
  });

  it('hashes the committed N and 2N child-log prefixes in both finalize passes', async () => {
    type Measurement = Parameters<
      NonNullable<ChatDeltaJournalWriterOptions['onChildLogTotals']>
    >[0];
    const byteCounts: number[] = [];
    const measured: Array<{
      committedRows: number;
      passes: Measurement[];
      fixedOpenSet: {
        pendingRows: number;
        synthesizedFinalRows: number;
        historyRowsLoadedIntoOverlay: number;
      };
      artifactVerifyCalls: number;
    }> = [];
    for (const count of [1_000, 2_000]) {
      const metrics: Measurement[] = [];
      const scopeRoot = join(root, `scale-${count}`);
      const { writer } = await format4Scope(scopeRoot, {
        onChildLogTotals: (measurement) => metrics.push(measurement),
      });
      const prefix = Array.from({ length: count }, (_, index) =>
        prefixRow(index),
      );
      await seedRows(writer, prefix, `seed-prefix-${count}`);
      await writer.checkpoint();
      await seedOpenRow(
        writer,
        { ...openRow, delegationSequence: count },
        `seed-open-${count}`,
        false,
      );

      const artifactVerify = jest.spyOn(
        ChatTranscriptArtifacts.prototype,
        'verify',
      );
      try {
        const settled = await finalizeMutation(writer);
        expect(settled.settlement.finalItemCount).toBe(count + 1);
        expect(artifactVerify).not.toHaveBeenCalled();
      } finally {
        artifactVerify.mockRestore();
      }
      const finalizePasses = metrics.filter(
        (measurement) => measurement.appendedRowCount === 1,
      );
      expect(finalizePasses).toHaveLength(2);
      expect(
        finalizePasses.map((measurement) => measurement.committedRowCount),
      ).toEqual([count, count]);
      expect(
        finalizePasses.map(
          (measurement) => measurement.committedLogSegmentsRead,
        ),
      ).toEqual([1, 1]);
      expect(
        finalizePasses.map(
          (measurement) => measurement.hashBufferAllocationCount,
        ),
      ).toEqual([1, 1]);
      expect(
        finalizePasses.map(
          (measurement) => measurement.hashBufferBytesPerAllocation,
        ),
      ).toEqual([64 * 1024, 64 * 1024]);
      expect(finalizePasses[0]?.committedBytesRead).toBeGreaterThan(0);
      expect(finalizePasses[1]?.committedBytesRead).toBe(
        finalizePasses[0]?.committedBytesRead,
      );
      byteCounts.push(finalizePasses[0]?.committedBytesRead ?? 0);
      measured.push({
        committedRows: count,
        passes: finalizePasses,
        fixedOpenSet: {
          pendingRows: 1,
          synthesizedFinalRows: 1,
          historyRowsLoadedIntoOverlay: 0,
        },
        artifactVerifyCalls: artifactVerify.mock.calls.length,
      });
    }
    const byteRatio = (byteCounts[1] ?? 0) / (byteCounts[0] ?? 1);
    expect(byteRatio).toBeGreaterThan(1.9);
    expect(byteRatio).toBeLessThan(2.1);
    process.stdout.write(`S2_FINALIZE_WORK ${JSON.stringify(measured)}\n`);
  }, 120_000);
});
