import { delegationTranscriptSettlementDigest } from '@canopy/desktop-shared/node/delegation/settlement-identity';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { TranscriptStreamDescriptor } from '@canopy/protocol/canopy-core';
import {
  RepositoryDelegationTranscriptPort,
  type RepositoryDelegationTranscriptChatState,
} from '../../agents/delegation/repository-transcript-port';
import { encodeChatTranscriptReadCursor } from '../../lib/chat-transcript-read-cursor';
import { DelegationRegistryOperationError } from '../../lib/chat-delta-journal/delegation-registry-error';

const target = {
  kind: 'delegation',
  chatId: 'chat',
  delegationId: 'child',
  runGeneration: 1,
} as const;
const scope = { projectId: 'project', worktreeId: 'worktree' };
const row: DelegationChildRow = {
  id: 'item',
  role: 'assistant',
  timestamp: 12,
  itemRevision: 0,
  final: true,
  blocks: [{ type: 'text', text: 'body' }],
};
function descriptor(settled: boolean): TranscriptStreamDescriptor {
  return {
    version: 1,
    target,
    streamKey: 'a'.repeat(64),
    checkpointRevision: 0,
    openedAt: 10,
    status: settled ? 'settled' : 'open',
    streamRevision: 5,
    committedRowCount: 1,
    latestRowTimestamp: 12,
    committedByteLength: 1,
    committedSha256: 'b'.repeat(64),
    cardState: null,
    settleReceipt: settled
      ? {
          mutationId: 'settle',
          scopeRevision: 3,
          streamRevision: 3,
          committedRowCount: 1,
          committedByteLength: 1,
          committedSha256: 'b'.repeat(64),
        }
      : null,
  };
}
function state(
  d: TranscriptStreamDescriptor,
): RepositoryDelegationTranscriptChatState {
  return {
    appendDelegationReceipt: jest.fn(() => Promise.reject(new Error('unused'))),
    receipt: jest.fn(() => Promise.resolve(undefined)),
    result: jest.fn(() => Promise.resolve(undefined)),
    resultBySettlementKey: jest.fn(() => Promise.resolve(undefined)),
    resultByGeneration: jest.fn(() => Promise.resolve(undefined)),
    generation: jest.fn(() => Promise.resolve(undefined)),
    resultsPage: jest.fn(() => Promise.resolve({ results: [] })),
    generationsPage: jest.fn(() => Promise.resolve({ generations: [] })),
    resultAnswerRange: jest.fn(() => Promise.reject(new Error('unused'))),
    itemAdmission: jest.fn(() => Promise.resolve(undefined)),
    registerGeneration: jest.fn(() => Promise.reject(new Error('unused'))),
    settleDelegationResult: jest.fn(() => Promise.reject(new Error('unused'))),
    withChildStreamTarget: (_scope, _target, operation) => operation(),
    openChildStream: jest.fn(() => Promise.resolve(d)),
    getChildStreamState: jest.fn(() => Promise.resolve(d)),
    commitChildStream: jest.fn(() =>
      Promise.resolve({ applied: false, revision: 5, descriptor: d }),
    ),
    updateCardState: jest.fn(() => Promise.reject(new Error('unused'))),
    getChildStreamMessage: jest.fn(() => Promise.resolve(row)),
    getChildStreamPage: jest.fn(() =>
      Promise.resolve({ rows: [row], streamRevision: 3 }),
    ),
    readChildStreamContent: jest.fn(() =>
      Promise.resolve({ text: 'body', byteLength: 4, encoding: 'utf8' }),
    ),
  };
}

describe('repository transcript port adapter boundary', () => {
  it('accepts a structured-cloned JSON settlement at the frozen identity boundary', () => {
    const request = {
      target,
      settlementKey: 'cloned',
      resultIndex: 1,
      outcome: { status: 'completed', finishedAt: 456 },
      finalChanges: [],
      answer: null,
    } satisfies Parameters<
      RepositoryDelegationTranscriptChatState['settleDelegationResult']
    >[1];
    expect(() =>
      delegationTranscriptSettlementDigest(structuredClone(request)),
    ).not.toThrow();
  });

  it('preserves the complete typed engine failure without interpreting its message', async () => {
    const service = state(descriptor(false));
    const failure = {
      code: 'conflict',
      message: 'format 2 stale cursor ENOENT',
      retryable: false,
      storedItemRevision: 9,
      storedLastResultIndex: 7,
    } as const;
    jest
      .spyOn(service, 'result')
      .mockRejectedValueOnce(new DelegationRegistryOperationError(failure));
    const port = new RepositoryDelegationTranscriptPort(service, scope);
    expect(await port.result({ ...target, resultIndex: 1 })).toEqual({
      ok: false,
      error: failure,
    });
  });

  it('normalizes all settled read calls and page return revisions to immutable content', async () => {
    const service = state(descriptor(true));
    const pageRead = jest.spyOn(service, 'getChildStreamPage');
    const messageRead = jest.spyOn(service, 'getChildStreamMessage');
    const contentRead = jest.spyOn(service, 'readChildStreamContent');
    const port = new RepositoryDelegationTranscriptPort(service, scope);
    for (const pin of [3, 4, 5]) {
      expect(await port.page({ target, streamRevision: pin })).toMatchObject({
        ok: true,
        value: { streamRevision: 3 },
      });
      expect(
        await port.message({ target, streamRevision: pin, messageId: 'item' }),
      ).toMatchObject({ ok: true });
      expect(
        await port.contentRange({
          target,
          streamRevision: pin,
          messageId: 'item',
          blockOrdinal: 0,
          field: 'text',
          offset: 0,
          limit: 4,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(pageRead).toHaveBeenLastCalledWith(scope, target, 3, undefined, 100);
    expect(messageRead).toHaveBeenLastCalledWith(scope, target, 'item', 3);
    expect(contentRead).toHaveBeenLastCalledWith(
      scope,
      target,
      3,
      'item',
      0,
      'text',
      0,
      4,
      undefined,
    );
    for (const pin of [2, 6])
      expect(await port.page({ target, streamRevision: pin })).toMatchObject({
        ok: false,
        error: { code: 'stale_identity' },
      });
    expect(await port.open({ target })).toMatchObject({
      ok: true,
      value: { openedAt: 10, latestRowTimestamp: 12 },
    });
  });

  it('continues settled cursors using the normalized revision and rejects metadata-revision cursors', async () => {
    const service = state(descriptor(true));
    const pageRead = jest.spyOn(service, 'getChildStreamPage');
    const port = new RepositoryDelegationTranscriptPort(service, scope);
    const cursor = encodeChatTranscriptReadCursor(
      { ...scope, chatId: target.chatId, target },
      {
        kind: 'stream',
        revision: 3,
        position: 0,
        messageId: 'item',
        totalMessages: 2,
      },
    );
    expect(
      await port.page({ target, streamRevision: 5, cursor }),
    ).toMatchObject({ ok: true, value: { streamRevision: 3 } });
    expect(pageRead).toHaveBeenLastCalledWith(scope, target, 3, cursor, 100);
    const noncanonical = encodeChatTranscriptReadCursor(
      { ...scope, chatId: target.chatId, target },
      {
        kind: 'stream',
        revision: 5,
        position: 0,
        messageId: 'item',
        totalMessages: 2,
      },
    );
    expect(
      await port.page({ target, streamRevision: 5, cursor: noncanonical }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('projects structural target-spread registry inputs to the exact engine request keys', async () => {
    const service = state(descriptor(false));
    const resultRead = jest.spyOn(service, 'result');
    const generationRead = jest.spyOn(service, 'generation');
    const resultPage = jest.spyOn(service, 'resultsPage');
    const generationPage = jest.spyOn(service, 'generationsPage');
    const answerRead = jest.spyOn(service, 'resultAnswerRange');
    const port = new RepositoryDelegationTranscriptPort(service, scope);
    await port.result({ ...target, resultIndex: 1 });
    await port.generation(target);
    await port.resultsPage({ ...target, limit: 1 });
    await port.generationsPage({ ...target, limit: 1 });
    await port.resultAnswerRange({
      ...target,
      resultIndex: 1,
      offset: 0,
      limit: 4,
    });
    const identity = { chatId: 'chat', delegationId: 'child' };
    expect(resultRead).toHaveBeenCalledWith(scope, {
      ...identity,
      resultIndex: 1,
    });
    expect(generationRead).toHaveBeenCalledWith(scope, {
      ...identity,
      runGeneration: 1,
    });
    expect(resultPage).toHaveBeenCalledWith(scope, { ...identity, limit: 1 });
    expect(generationPage).toHaveBeenCalledWith(scope, {
      ...identity,
      limit: 1,
    });
    expect(answerRead).toHaveBeenCalledWith(
      scope,
      { ...identity, resultIndex: 1, offset: 0, limit: 4 },
      undefined,
    );
  });

  it('does not repin an open stream', async () => {
    const service = state(descriptor(false));
    const messageRead = jest.spyOn(service, 'getChildStreamMessage');
    const port = new RepositoryDelegationTranscriptPort(service, scope);
    expect(
      await port.message({ target, streamRevision: 4, messageId: 'item' }),
    ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
    expect(messageRead).not.toHaveBeenCalled();
  });

  it('returns the admitting raw key and revision, never the current descriptor revision', async () => {
    const service = state(descriptor(false));
    const commit = jest.spyOn(service, 'commitChildStream');
    jest.spyOn(service, 'itemAdmission').mockResolvedValueOnce({
      id: 'item',
      itemRevision: 0,
      admittingStreamRevision: 1,
      mutationKey: 'original-raw-key',
    });
    const port = new RepositoryDelegationTranscriptPort(service, scope);
    expect(
      await port.appendChanges({
        target,
        mutationKey: 'retry',
        changes: [{ row }],
      }),
    ).toEqual({
      ok: true,
      value: {
        target,
        mutationKey: 'original-raw-key',
        streamRevision: 1,
        items: [{ id: 'item', itemRevision: 0, final: true }],
        replayed: true,
      },
    });
    expect(commit).not.toHaveBeenCalled();
    expect(
      await port.appendChanges({
        target,
        mutationKey: 'must-not-invent',
        changes: [{ row }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported_format' } });
  });
  it('derives recombined receipts in request order with the maximum original revision', async () => {
    const service = state(descriptor(false));
    const other = { ...row, id: 'other' };
    jest
      .spyOn(service, 'getChildStreamMessage')
      .mockResolvedValueOnce(other)
      .mockResolvedValueOnce(row);
    jest
      .spyOn(service, 'itemAdmission')
      .mockResolvedValueOnce({
        id: 'other',
        itemRevision: 0,
        admittingStreamRevision: 4,
        mutationKey: 'other-key',
      })
      .mockResolvedValueOnce({
        id: 'item',
        itemRevision: 0,
        admittingStreamRevision: 1,
        mutationKey: 'first-key',
      });
    const port = new RepositoryDelegationTranscriptPort(service, scope);
    expect(
      await port.appendChanges({
        target,
        mutationKey: 'recombined',
        changes: [{ row: other }, { row }],
      }),
    ).toMatchObject({
      ok: true,
      value: {
        mutationKey: 'recombined',
        streamRevision: 4,
        items: [{ id: 'other' }, { id: 'item' }],
        replayed: true,
      },
    });
  });
});
