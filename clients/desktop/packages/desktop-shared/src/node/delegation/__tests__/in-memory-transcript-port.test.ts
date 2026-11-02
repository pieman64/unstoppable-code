import type { DelegationChildRow } from '@canopy/agent-transcript';
import { createHash } from 'node:crypto';
import type {
  DelegationTranscriptTarget,
  DelegationTranscriptSettleRequest,
  DelegationTranscriptPortResult,
  DelegationTranscriptGenerationRegistration,
  DelegationTranscriptRegistryIdentity,
  DelegationTranscriptReceiptEntry,
} from '../transcript-port';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  describeDelegationTranscriptPortConformance,
  type DelegationTranscriptPortConformanceFactory,
  type DelegationTranscriptPortConformanceFixture,
} from '../testing/transcript-port-conformance';

class FixtureMemoryPort extends InMemoryDelegationTranscriptPort {
  public advanceFixtureCardRevision(target: DelegationTranscriptTarget): void {
    const stream = this.streams.get(
      JSON.stringify([
        target.kind,
        target.chatId,
        target.delegationId,
        target.runGeneration,
      ]),
    );
    if (stream === undefined) throw new Error('Missing fixture stream');
    stream.state = {
      ...stream.state,
      streamRevision: stream.state.streamRevision + 1,
    };
  }

  public loseAnswer(
    identity: DelegationTranscriptRegistryIdentity,
    resultIndex: number,
  ): void {
    const registry = this.registries.get(
      JSON.stringify([identity.chatId, identity.delegationId]),
    );
    const result = registry?.results.get(resultIndex);
    if (
      registry === undefined ||
      result === undefined ||
      result.answer.kind !== 'body'
    )
      throw new Error('Missing fixture result');
    const answer = result.answer;
    const storedAnswer = this.answers.get(answer.ref.artifactId);
    if (storedAnswer === undefined) throw new Error('Missing fixture answer');
    const text = storedAnswer.bytes.toString(storedAnswer.encoding);
    const lost = {
      ...result,
      answer: {
        kind: 'lost',
        role: answer.role,
        sha256: createHash('sha256')
          .update(Buffer.from(text, 'utf16le'))
          .digest('hex'),
        length: text.length,
      },
    } as const;
    registry.results.set(resultIndex, lost);
    registry.keys.set(result.settlementKey, lost);
    registry.byGeneration.set(result.runGeneration, lost);
  }

  public deleteAnswerBodies(): void {
    this.answers.clear();
  }

  public seedMetadataLessRows(
    target: DelegationTranscriptTarget,
    rows: readonly DelegationChildRow[],
  ): void {
    const stream = this.streams.get(
      JSON.stringify([
        target.kind,
        target.chatId,
        target.delegationId,
        target.runGeneration,
      ]),
    );
    if (stream === undefined) throw new Error('Missing fixture stream');
    for (const row of rows) {
      stream.rows.set(row.id, row);
      if (!row.final) stream.openRows.set(row.id, row);
      stream.admissions.delete(row.id);
      if (row.final) stream.finalRows.push(row);
    }
    stream.state = {
      ...stream.state,
      streamRevision: stream.state.streamRevision + 1,
    };
  }
}

function createMemoryFixture(): DelegationTranscriptPortConformanceFixture {
  const port = new FixtureMemoryPort({
    owns(target: DelegationTranscriptTarget): boolean {
      return target.chatId !== 'foreign-chat';
    },
    ownsChat: (chatId): boolean => chatId !== 'foreign-chat',
  });
  return {
    port,
    removeChat: (chatId) => port.removeChat(chatId),
    portWithoutChatOwnership: () =>
      new InMemoryDelegationTranscriptPort({ owns: () => true }),
    updateCardState: (target) => port.advanceFixtureCardRevision(target),
    seedMetadataLessRows: (target, rows) =>
      port.seedMetadataLessRows(target, rows),
    ownedTarget(
      chatId: string,
      delegationId: string,
      generation: number,
    ): DelegationTranscriptTarget {
      return {
        kind: 'delegation',
        chatId,
        delegationId,
        runGeneration: generation,
      };
    },
    foreignTarget: {
      kind: 'delegation',
      chatId: 'foreign-chat',
      delegationId: 'foreign-child',
      runGeneration: 1,
    },
  };
}

const memoryFixtureFactory: DelegationTranscriptPortConformanceFactory =
  Object.assign(createMemoryFixture, {
    capabilities: {
      reopen: false,
      storageFailure: false,
      checkpoint: false,
      freshInstance: false,
      noJournal: false,
      faults: false,
      chatRemoval: true,
      registryFaults: false,
    },
  });

describeDelegationTranscriptPortConformance('in-memory', memoryFixtureFactory, {
  registry: true,
  durability: 'memory',
});

describe('in-memory registry repair and receipt edge cases', () => {
  function receipt(chatId = 'chat'): DelegationTranscriptReceiptEntry {
    return {
      version: 1,
      kind: 'receipt',
      chatId,
      receiptKind: 'stop',
      key: 'a'.repeat(64),
      delegationId: 'child',
      runGeneration: 1,
      operationId: 'abcdef12-3456-7890-abcd-1234567890ab',
      requestHash: 'b'.repeat(64),
      operation: 'stop',
      admittedAt: 123,
      reply: { kind: 'stop', ackStatus: 'accepted', runGeneration: 1 },
    };
  }

  it('fails closed for throwing chat ownership and honors aborts before receipt publication', async () => {
    const denied = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => {
        throw new Error('ownership unavailable');
      },
    });
    expect(await denied.appendReceipt(receipt())).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    expect(await denied.receipt(receipt())).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const signal = AbortSignal.abort();
    expect(await port.appendReceipt(receipt(), signal)).toMatchObject({
      ok: false,
      error: { code: 'storage_failure', retryable: true },
    });
    expect(await port.receipt(receipt())).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const entry = receipt();
    value(await port.appendReceipt(entry));
    Reflect.set(entry.reply, 'ackStatus', 'failed');
    expect(value(await port.receipt(receipt())).reply).toMatchObject({
      ackStatus: 'accepted',
    });
  });

  it('rolls back explicit changes when an automatic final revision overflows', async () => {
    const port = memory();
    value(await port.open({ target: target() }));
    const exhausted = row('exhausted', Number.MAX_SAFE_INTEGER);
    port.seedMetadataLessRows(target(), [exhausted]);
    const before = value(await port.open({ target: target() }));
    expect(
      await port.settle({
        ...request(),
        openRows: 'finalize',
        finalChanges: [{ row: row('explicit', 0, true) }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(value(await port.open({ target: target() }))).toEqual(before);
    expect(
      value(
        await port.page({
          target: target(),
          streamRevision: before.streamRevision,
        }),
      ).rows,
    ).toEqual([exhausted]);
    expect(
      await port.resultBySettlementKey({
        ...target(),
        settlementKey: request().settlementKey,
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await port.resultByGeneration(target())).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('replays equivalent text and lost answer identity without replacing the first stored representation', async () => {
    const port = memory();
    value(await port.open({ target: target() }));
    const text = 'a😀\ud800';
    const lost = {
      sha256: createHash('sha256')
        .update(Buffer.from(text, 'utf16le'))
        .digest('hex'),
      length: text.length,
    };
    const settled = value(
      await port.settle({ ...request(), answer: { role: 'final', lost } }),
    );
    const replay = value(
      await port.settle({ ...request(), answer: { role: 'final', text } }),
    );
    expect(replay.result).toEqual(settled.result);
    expect(replay.settlement.replayed).toBe(true);
    Reflect.set(lost, 'length', 1);
    const byKey = value(
      await port.resultBySettlementKey({
        ...target(),
        settlementKey: request().settlementKey,
      }),
    );
    Reflect.set(byKey.outcome, 'finishedAt', -1);
    expect(value(await port.resultByGeneration(target()))).toEqual(
      settled.result,
    );
    expect(
      await port.resultAnswerRange({
        ...target(),
        resultIndex: 1,
        offset: 0,
        limit: 4,
      }),
    ).toMatchObject({ ok: false, error: { code: 'answer_unavailable' } });
  });

  it('removes all delegations of one chat while retaining shared answer bodies in another chat', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    const removedChat = 'quoted"chat';
    const targets = [
      { ...target(), chatId: removedChat },
      { ...target(), chatId: removedChat, delegationId: 'other' },
      { ...target(), chatId: 'retained' },
    ];
    for (const scope of targets) {
      value(await port.open({ target: scope }));
      value(
        await port.settle({
          ...request(),
          target: scope,
          answer: { role: 'final', text: 'shared' },
        }),
      );
    }
    value(await port.appendReceipt(receipt(removedChat)));
    value(await port.appendReceipt(receipt('retained')));
    port.removeChat(removedChat);
    for (const scope of targets.slice(0, 2)) {
      expect(await port.resultByGeneration(scope)).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
      expect(value(await port.open({ target: scope })).status).toBe('open');
    }
    expect(await port.receipt(receipt(removedChat))).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(value(await port.receipt(receipt('retained')))).toEqual(
      receipt('retained'),
    );
    expect(
      value(
        await port.resultAnswerRange({
          ...target(),
          chatId: 'retained',
          resultIndex: 1,
          offset: 0,
          limit: 100,
        }),
      ).text,
    ).toBe('shared');
  });
});

function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function target(runGeneration = 1): DelegationTranscriptTarget {
  return {
    kind: 'delegation',
    chatId: 'chat',
    delegationId: 'child',
    runGeneration,
  };
}

function request(
  runGeneration = 1,
  resultIndex = runGeneration,
): DelegationTranscriptSettleRequest {
  return {
    target: target(runGeneration),
    resultIndex,
    settlementKey: `settle-${runGeneration}`,
    finalChanges: [],
    outcome: { status: 'completed', finishedAt: 100 },
    answer: null,
  };
}

function row(
  id: string,
  itemRevision = 0,
  final = false,
  timestamp = 100,
): DelegationChildRow {
  return {
    id,
    itemRevision,
    final,
    timestamp,
    role: 'assistant',
    delegationSegment: 'segment',
    parentBlockId: 'card',
    blocks: [{ type: 'text', text: id }],
  };
}

function registration(
  runGeneration: number,
): DelegationTranscriptGenerationRegistration {
  return {
    chatId: 'chat',
    delegationId: 'child',
    runGeneration,
    createdAt: 50,
    store: 'stream',
    origin: { kind: 'launch' },
    executionMode: 'background',
  };
}

function memory(): FixtureMemoryPort {
  return new FixtureMemoryPort({ owns: () => true });
}

describe('in-memory registry boundary cases', () => {
  it('serializes simultaneous generations and index exhaustion without consuming failed indices', async () => {
    const port = memory();
    for (const runGeneration of [1, 2, 3])
      value(await port.open({ target: target(runGeneration) }));
    const attempts = await Promise.all([
      port.settle(request()),
      port.settle(request(2, 1)),
    ]);
    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(attempts[1]).toMatchObject({
      ok: false,
      error: { code: 'conflict', storedLastResultIndex: 1 },
    });
    value(await port.settle(request(2, 2)));
    expect(await port.settle(request(3, 0))).toMatchObject({
      ok: false,
      error: { code: 'conflict', storedLastResultIndex: 2 },
    });
    expect(await port.settle(request(3, -1))).toMatchObject({
      ok: false,
      error: { code: 'conflict', storedLastResultIndex: 2 },
    });
    expect(
      await port.settle(request(3, Number.MAX_SAFE_INTEGER + 1)),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    value(await port.settle(request(3, 3)));
    const exhausted = memory();
    value(await exhausted.open({ target: target() }));
    value(await exhausted.open({ target: target(2) }));
    value(await exhausted.settle(request(1, Number.MAX_SAFE_INTEGER)));
    expect(
      await exhausted.settle(request(2, Number.MAX_SAFE_INTEGER)),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('atomically rejects open rows, preserves original receipts and finalization order', async () => {
    const port = memory();
    value(await port.open({ target: target() }));
    const original = value(
      await port.appendChanges({
        target: target(),
        mutationKey: 'open',
        changes: [{ row: row('a') }, { row: row('b') }],
      }),
    );
    const partial = {
      ...request(),
      finalChanges: [{ row: row('b', 1, true) }],
    };
    expect(await port.settle(partial)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(value(await port.open({ target: target() })).streamRevision).toBe(
      original.streamRevision,
    );
    expect(
      value(
        await port.message({
          target: target(),
          streamRevision: original.streamRevision,
          messageId: 'b',
        }),
      ).final,
    ).toBe(false);
    const finalChanges = [
      { row: row('b', 1, true, 300) },
      { row: row('a', 1, true, 200) },
    ];
    const settled = value(await port.settle({ ...request(), finalChanges }));
    expect(settled.result.settlement.finalItemsDigest).toBe(
      createHash('sha256')
        .update(
          finalChanges
            .map(({ row: item }) => `${JSON.stringify(item)}\n`)
            .join(''),
        )
        .digest('hex'),
    );
    const receipt = value(
      await port.appendChanges({
        target: target(),
        mutationKey: 'retry',
        changes: finalChanges,
      }),
    );
    expect(receipt).toMatchObject({
      mutationKey: request().settlementKey,
      replayed: true,
      streamRevision: settled.settlement.streamRevision,
    });
    expect(
      await port.appendChanges({
        target: target(),
        mutationKey: 'blocked',
        changes: [{ row: row('new') }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(
      value(await port.open({ target: target() })).latestRowTimestamp,
    ).toBe(300);
  });

  it('updates admission metadata only for changed current revisions in mixed batches', async () => {
    const port = memory();
    value(await port.open({ target: target() }));
    const original = value(
      await port.appendChanges({
        target: target(),
        mutationKey: 'first',
        changes: [{ row: row('a') }, { row: row('b') }],
      }),
    );
    const mixed = value(
      await port.appendChanges({
        target: target(),
        mutationKey: 'mixed',
        changes: [{ row: row('a') }, { row: row('b', 1, false, 20) }],
      }),
    );
    expect(
      value(
        await port.appendChanges({
          target: target(),
          mutationKey: 'retry-a',
          changes: [{ row: row('a') }],
        }),
      ),
    ).toMatchObject({
      streamRevision: original.streamRevision,
      mutationKey: 'first',
      replayed: true,
    });
    expect(
      value(
        await port.appendChanges({
          target: target(),
          mutationKey: 'retry-b',
          changes: [{ row: row('b', 1, false, 20) }],
        }),
      ),
    ).toMatchObject({
      streamRevision: mixed.streamRevision,
      mutationKey: 'mixed',
      replayed: true,
    });
    expect(
      await port.appendChanges({
        target: target(),
        mutationKey: 'stale',
        changes: [{ row: row('b') }],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'stale_identity', storedItemRevision: 1 },
    });
    expect(
      value(await port.open({ target: target() })).latestRowTimestamp,
    ).toBe(100);
  });

  it('projects live generation descriptors while snapshotting registered generations', async () => {
    const port = memory();
    value(await port.registerGeneration(registration(1)));
    value(await port.registerGeneration(registration(2)));
    value(
      await port.registerGeneration({ ...registration(3), store: 'legacy' }),
    );
    const page = value(await port.generationsPage({ ...target(), limit: 1 }));
    expect(page.generations.map(({ entry }) => entry.runGeneration)).toEqual([
      1,
    ]);
    value(await port.registerGeneration(registration(4)));
    value(await port.open({ target: target(2) }));
    const settled = value(await port.settle(request(2, 1)));
    port.advanceFixtureCardRevision(target(2));
    const rest = value(
      await port.generationsPage({
        ...target(),
        limit: 100,
        cursor: page.cursor,
      }),
    );
    expect(rest.generations.map(({ entry }) => entry.runGeneration)).toEqual([
      2, 3,
    ]);
    expect(rest.generations[0]?.stream).toMatchObject({
      status: 'settled',
      contentRevision: settled.settlement.contentRevision,
      streamRevision: settled.settlement.contentRevision + 1,
    });
    expect(rest.generations[1]?.stream).toBeNull();
    expect(
      await port.resultsPage({ ...target(), limit: 1, cursor: page.cursor }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
  });

  it('keeps keys scoped to the delegation, not generation, and returns detached metadata', async () => {
    const port = memory();
    value(await port.open({ target: target() }));
    value(await port.open({ target: target(2) }));
    const settled = value(await port.settle(request()));
    Reflect.set(settled.result.outcome, 'finishedAt', -1);
    expect(
      value(await port.result({ ...target(), resultIndex: 1 })).outcome
        .finishedAt,
    ).toBe(100);
    expect(
      await port.settle({
        ...request(2, 2),
        settlementKey: request().settlementKey,
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const other = { ...target(), delegationId: 'other' };
    value(await port.open({ target: other }));
    value(await port.settle({ ...request(), target: other }));
    expect(
      value(await port.resultsPage({ ...target(), limit: 100 })).results,
    ).toHaveLength(1);
    const registrationInput = registration(1);
    value(await port.registerGeneration(registrationInput));
    Reflect.set(registrationInput.origin, 'anchorMessageId', 'mutated');
    expect(value(await port.generation(target())).entry.origin).toEqual({
      kind: 'launch',
    });
  });

  it('rejects bounded/invalid registry metadata before publishing rows, answers or indices', async () => {
    const port = memory();
    value(await port.open({ target: target() }));
    for (const changed of [
      { ...request(), settlementKey: 'x'.repeat(257) },
      {
        ...request(),
        outcome: {
          status: 'failed',
          finishedAt: 100,
          error: {
            code: 'runtime_error',
            message: 'x'.repeat(4097),
            retryable: false,
          },
        },
      },
      {
        ...request(),
        outcome: {
          status: 'completed',
          finishedAt: 100,
          usage: { inputTokens: -1 },
        },
      },
      {
        ...request(),
        outcome: {
          status: 'failed',
          finishedAt: 100,
          error: {
            code: 'runtime_error',
            message: '😀'.repeat(2049),
            retryable: false,
          },
        },
        settlementKey: '😀'.repeat(128),
      },
    ] satisfies readonly DelegationTranscriptSettleRequest[]) {
      expect(
        await port.settle({
          ...changed,
          finalChanges: [{ row: row('not-published', 0, true) }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    }
    expect(
      value(await port.page({ target: target(), streamRevision: 0 })).rows,
    ).toEqual([]);
    expect(
      value(await port.resultsPage({ ...target(), limit: 100 })).results,
    ).toEqual([]);
    expect(
      await port.registerGeneration({
        ...registration(1),
        origin: { kind: 'follow_up', authoredItemId: 'x'.repeat(257) },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    for (const limit of [0, 101, 1.5])
      expect(await port.resultsPage({ ...target(), limit })).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
    value(await port.settle(request()));
  });

  it.each(['utf8', 'utf16le'] as const)(
    'ranges %s answers on character boundaries, preserving role and hashes',
    async (encoding) => {
      const port = memory();
      value(await port.open({ target: target() }));
      const text = encoding === 'utf8' ? 'a😀é' : 'a😀\ud800';
      const settled = value(
        await port.settle({ ...request(), answer: { role: 'partial', text } }),
      );
      const bytes = Buffer.from(text, encoding);
      expect(settled.result.answer).toMatchObject({
        kind: 'body',
        role: 'partial',
        encoding,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length,
      });
      const first = value(
        await port.resultAnswerRange({
          ...target(),
          resultIndex: 1,
          offset: 0,
          limit: 4,
        }),
      );
      expect(first).toMatchObject({
        text: 'a',
        nextOffset: encoding === 'utf8' ? 1 : 2,
      });
      const second = value(
        await port.resultAnswerRange({
          ...target(),
          resultIndex: 1,
          offset: first.nextOffset ?? -1,
          limit: 4,
        }),
      );
      expect(second.text).toBe('😀');
      expect(
        await port.resultAnswerRange({
          ...target(),
          resultIndex: 1,
          offset: encoding === 'utf8' ? 2 : 4,
          limit: 4,
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      const eof = value(
        await port.resultAnswerRange({
          ...target(),
          resultIndex: 1,
          offset: bytes.length,
          limit: 4,
        }),
      );
      expect(eof).toMatchObject({ text: '', byteLength: bytes.length });
      expect(eof.nextOffset).toBeUndefined();
      for (const range of [
        { offset: -1, limit: 4 },
        { offset: bytes.length + 1, limit: 4 },
        { offset: 0, limit: 3 },
        { offset: 0, limit: 65537 },
      ])
        expect(
          await port.resultAnswerRange({
            ...target(),
            resultIndex: 1,
            ...range,
          }),
        ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    },
  );

  it('distinguishes repair-lost answers and missing-known-body corruption from missing results', async () => {
    const port = memory();
    for (const generation of [1, 2]) {
      value(await port.open({ target: target(generation) }));
      value(
        await port.settle({
          ...request(generation),
          answer: { role: 'final', text: 'shared answer' },
        }),
      );
    }
    port.loseAnswer(target(), 1);
    expect(
      await port.resultAnswerRange({
        ...target(),
        resultIndex: 1,
        offset: 0,
        limit: 4,
      }),
    ).toMatchObject({ ok: false, error: { code: 'answer_unavailable' } });
    expect(
      value(await port.result({ ...target(), resultIndex: 1 })).outcome.status,
    ).toBe('completed');
    port.deleteAnswerBodies();
    expect(
      await port.resultAnswerRange({
        ...target(),
        resultIndex: 2,
        offset: 0,
        limit: 4,
      }),
    ).toMatchObject({ ok: false, error: { code: 'corruption' } });
    expect(
      await port.resultAnswerRange({
        ...target(),
        resultIndex: 3,
        offset: 0,
        limit: 4,
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});
