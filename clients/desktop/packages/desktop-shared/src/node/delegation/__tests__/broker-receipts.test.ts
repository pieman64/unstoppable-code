import {
  classifyRegistryLookup,
  createChatReceiptLock,
  foldReceiptActivity,
  planReceiptFits,
  receiptNotAdmitted,
  receiptPins,
  ReceiptQuarantine,
  rollOverReceipt,
  selectReceiptEvictee,
} from '../broker-receipts';
import type { ReceiptNotAdmittedCause } from '../broker-receipts';
import { createDelegationRunState } from '../lifecycle';
import {
  completeDelegationCommandReceipt,
  fitDelegationReceiptAck,
  fitDelegationStopReceipt,
} from '../receipt-reply';
import type { DelegationReceiptFitResult } from '../receipt-reply';
import { decodeStoredDelegationV3 } from '../record-v3';
import type {
  StoredDelegationV3,
  V3CommandReceiptEntry,
  V3ReceiptState,
  V3StopReceiptEntry,
} from '../record-v3';
import { canonicalDelegationJson } from '../settlement-identity';
import type {
  DelegationTranscriptPortErrorCode,
  DelegationTranscriptPortResult,
  DelegationTranscriptReceiptAppendResult,
  DelegationTranscriptReceiptEntry,
  DelegationTranscriptReceiptIdentity,
} from '../transcript-port';

const CHAT_ID = 'chat';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000001';
const IDENTITY: DelegationTranscriptReceiptIdentity = {
  chatId: CHAT_ID,
  receiptKind: 'command',
  key: 'a'.repeat(64),
};
const ERROR_CODES: readonly DelegationTranscriptPortErrorCode[] = [
  'invalid_request',
  'not_found',
  'unauthorized',
  'stale_identity',
  'conflict',
  'unsupported_format',
  'storage_failure',
  'corruption',
  'answer_unavailable',
];

function failure<T>(
  code: DelegationTranscriptPortErrorCode,
): DelegationTranscriptPortResult<T> {
  return {
    ok: false,
    error: { code, message: 'Port failed', retryable: true },
  };
}

function commandEntry(
  result: DelegationReceiptFitResult,
): V3CommandReceiptEntry {
  if (!result.ok) throw new Error(result.reason);
  const { entry } = result;
  if (entry.receiptKind !== 'command' || entry.reply.kind !== 'command')
    throw new Error('Expected a fitted command receipt');
  return { ...entry, receiptKind: entry.receiptKind, reply: entry.reply };
}

function complete(
  entry: V3CommandReceiptEntry,
  status: 'completed' | 'failed' = 'completed',
): V3CommandReceiptEntry {
  return commandEntry(completeDelegationCommandReceipt(entry, { status }));
}

function command(
  index: number,
  options: {
    operation?: V3CommandReceiptEntry['operation'];
    admittedAt?: number;
    ack?: 'accepted' | 'completed' | 'refused';
    final?: 'completed' | 'failed';
  } = {},
): V3CommandReceiptEntry {
  const operationId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const operation = options.operation ?? 'follow_up';
  if (operation === 'stop') throw new Error('Expected a command operation');
  const fitted = commandEntry(
    fitDelegationReceiptAck(
      {
        chatId: CHAT_ID,
        delegationId: DELEGATION_ID,
        receiptKind: 'command',
        key: index.toString(16).padStart(64, '0'),
        requestHash: 'b'.repeat(64),
        operationId,
        runGeneration: 1,
        operation,
        admittedAt: options.admittedAt ?? index + 100,
      },
      options.ack === 'refused'
        ? {
            ok: false,
            error: {
              code: 'policy_blocked',
              message: 'Refused',
              retryable: false,
            },
          }
        : {
            ok: true,
            outcome: options.ack ?? 'accepted',
            snapshot: {
              delegationId: DELEGATION_ID,
              runGeneration: 1,
              status: 'running',
              outputTruncated: false,
              control: {
                operationId,
                operation,
                status: options.ack ?? 'accepted',
              },
            },
          },
    ),
  );
  return options.final === undefined ? fitted : complete(fitted, options.final);
}

function stop(index: number, admittedAt = 100): V3StopReceiptEntry {
  const fitted = fitDelegationStopReceipt(
    {
      chatId: CHAT_ID,
      delegationId: DELEGATION_ID,
      receiptKind: 'stop',
      key: index.toString(16).padStart(64, '0'),
      requestHash: 'd'.repeat(64),
      operationId: '00000000-0000-4000-8000-000000000099',
      runGeneration: 1,
      operation: 'stop',
      admittedAt,
    },
    'accepted',
  );
  if (!fitted.ok) throw new Error(fitted.reason);
  const { entry } = fitted;
  if (entry.receiptKind !== 'stop' || entry.reply.kind !== 'stop')
    throw new Error('Expected a fitted stop alias');
  return { ...entry, receiptKind: entry.receiptKind, reply: entry.reply };
}

function candidate(
  receipts: V3ReceiptState,
  operational?: V3CommandReceiptEntry,
): StoredDelegationV3 {
  if (operational?.operation === 'stop') throw new Error('Expected a command');
  return {
    version: 3,
    parent: {
      harnessId: 'harness',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: CHAT_ID,
      sessionKey: 'session',
      turnId: 'turn',
      toolCallId: 'tool',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'model',
      description: 'task',
      prompt: 'prompt',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    callKey: 'c'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: 100,
    state: createDelegationRunState(DELEGATION_ID, 1),
    launch: {
      version: 1,
      delegationId: DELEGATION_ID,
      launchKey: 'c'.repeat(64),
      runGeneration: 1,
      phase: 'reserved',
    },
    delivery: { status: 'unclaimed' },
    readMetadata: {
      originAt: 100,
      lastActivityAt: 100,
      current: {
        store: 'stream',
        target: {
          kind: 'delegation',
          chatId: CHAT_ID,
          delegationId: DELEGATION_ID,
          runGeneration: 1,
        },
      },
    },
    registration: {
      runGeneration: 1,
      createdAt: 100,
      store: 'stream',
      origin: { kind: 'launch' },
      executionMode: 'background',
    },
    receipts,
    ...(operational === undefined
      ? {}
      : {
          control: {
            operationId: operational.operationId,
            key: operational.key,
            requestHash: 'b'.repeat(64),
            operation: operational.operation,
            status: 'accepted',
          },
        }),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function appendSuccess(
  entry: DelegationTranscriptReceiptEntry,
  replayed = false,
): DelegationTranscriptPortResult<DelegationTranscriptReceiptAppendResult> {
  return { ok: true, value: { entry, replayed } };
}

describe('not-admitted and registry lookup (E4/E5)', () => {
  const causes: readonly ReceiptNotAdmittedCause[] = [
    'lookup',
    'append',
    'pre_write',
    'uncertain_commit',
  ];
  it.each(causes)(
    'constructs %s without a receipt or invented code',
    (cause) => {
      expect(receiptNotAdmitted(cause)).toEqual({
        kind: 'not_admitted',
        cause,
      });
      expect(receiptNotAdmitted(cause, 'conflict')).toEqual({
        kind: 'not_admitted',
        cause,
        code: 'conflict',
      });
    },
  );

  it('returns the exact hit entry', () => {
    const entry = command(1);
    const result = classifyRegistryLookup({ ok: true, value: entry });
    expect(result).toEqual({ kind: 'hit', entry });
    if (result.kind !== 'hit') throw new Error('Expected hit');
    expect(result.entry).toBe(entry);
  });

  it.each(ERROR_CODES)('classifies structured %s', (code) => {
    expect(classifyRegistryLookup(failure(code))).toEqual(
      code === 'not_found'
        ? { kind: 'absent' }
        : { kind: 'not_admitted', cause: 'lookup', code },
    );
  });

  it.each([new Error('read failed'), null, 'failure', { code: 'ENOENT' }])(
    'does not admit an untyped throw: %p',
    (thrown) => {
      expect(classifyRegistryLookup({ thrown })).toEqual({
        kind: 'not_admitted',
        cause: 'lookup',
      });
    },
  );

  it.each(ERROR_CODES)(
    'retains thrown port code %s without treating it as absence',
    (code) => {
      expect(classifyRegistryLookup({ thrown: { code } })).toEqual({
        kind: 'not_admitted',
        cause: 'lookup',
        code,
      });
    },
  );
});

describe('candidate receipt pins (E2/B8)', () => {
  it('has no witness without stops, but pins the operational receipt', () => {
    const receipt = command(1, { operation: 'resume', final: 'completed' });
    const record = candidate(
      { commandReceipts: [receipt], stopReceipts: [] },
      receipt,
    );
    expect(receiptPins(decodeStoredDelegationV3(record))).toEqual({
      operationalKey: receipt.key,
    });
    expect(
      receiptPins(candidate({ commandReceipts: [], stopReceipts: [] })),
    ).toEqual({});
  });

  it('does not witness while an active stop exists', () => {
    const alias = stop(1);
    const receipt = command(2, { operation: 'resume', admittedAt: 110 });
    const record = candidate(
      {
        commandReceipts: [receipt],
        stopReceipts: [alias],
        activeStop: {
          operationId: alias.operationId,
          runGeneration: 1,
          admittedAt: 100,
        },
        stopFence: { operationId: alias.operationId, status: 'accepted' },
      },
      receipt,
    );
    expect(receiptPins(decodeStoredDelegationV3(record))).toEqual({
      operationalKey: receipt.key,
    });
  });

  it('does not witness while a fence exists', () => {
    const alias = stop(1);
    const receipt = command(2, { operation: 'resume', admittedAt: 110 });
    const record = candidate({
      commandReceipts: [receipt],
      stopReceipts: [alias],
      stopFence: { operationId: alias.operationId, status: 'completed' },
    });
    expect(receiptPins(decodeStoredDelegationV3(record))).toEqual({});
  });

  it('pins a cleared-fence witness even when its final failed', () => {
    const receipt = command(2, {
      operation: 'resume',
      admittedAt: 110,
      final: 'failed',
    });
    const record = candidate({
      commandReceipts: [receipt],
      stopReceipts: [stop(1)],
    });
    expect(receiptPins(decodeStoredDelegationV3(record))).toEqual({
      resumeWitnessKey: receipt.key,
    });
  });

  it('chooses the latest successful ack, ignoring later refused resumes and other operations', () => {
    const first = command(1, { operation: 'resume', admittedAt: 110 });
    const latest = command(2, {
      operation: 'resume',
      admittedAt: 120,
      ack: 'completed',
    });
    const refused = command(3, {
      operation: 'resume',
      admittedAt: 130,
      ack: 'refused',
    });
    const other = command(4, { admittedAt: 140 });
    const record = candidate(
      {
        commandReceipts: [first, latest, refused, other],
        stopReceipts: [stop(1)],
      },
      other,
    );
    expect(receiptPins(decodeStoredDelegationV3(record))).toEqual({
      operationalKey: other.key,
      resumeWitnessKey: latest.key,
    });
  });

  it('does not use a refused resume as the only witness, matching the codec', () => {
    const refused = command(1, {
      operation: 'resume',
      admittedAt: 110,
      ack: 'refused',
    });
    const record = candidate({
      commandReceipts: [refused],
      stopReceipts: [stop(1)],
    });
    expect(receiptPins(record)).toEqual({});
    expect(() => decodeStoredDelegationV3(record)).toThrow();
  });

  it('requires admission strictly after the latest alias, not the first alias', () => {
    const receipt = command(1, { operation: 'resume', admittedAt: 110 });
    const record = candidate({
      commandReceipts: [receipt],
      stopReceipts: [stop(1, 100), stop(2, 110)],
    });
    expect(receiptPins(record)).toEqual({});
    expect(() => decodeStoredDelegationV3(record)).toThrow();
  });

  it('releases the old witness after a new stop', () => {
    const receipt = command(1, { operation: 'resume', admittedAt: 110 });
    const alias = stop(2, 120);
    const record = candidate({
      commandReceipts: [receipt],
      stopReceipts: [stop(1), alias],
      stopFence: { operationId: alias.operationId, status: 'completed' },
    });
    expect(receiptPins(decodeStoredDelegationV3(record))).toEqual({});
  });

  it('deterministically takes the last retained witness on equal admission times', () => {
    const first = command(1, { operation: 'resume', admittedAt: 110 });
    const last = command(2, { operation: 'resume', admittedAt: 110 });
    expect(
      receiptPins(
        candidate({ commandReceipts: [first, last], stopReceipts: [stop(1)] }),
      ),
    ).toEqual({ resumeWitnessKey: last.key });
  });
});

describe('prior-durable eviction selection (E2/B10)', () => {
  it.each(['completed', 'refused'])(
    'selects the first terminal %s ack',
    (ack) => {
      const entries = [
        command(1, { ack: ack === 'completed' ? 'completed' : 'refused' }),
        command(2, { ack: 'completed' }),
      ];
      expect(selectReceiptEvictee(entries, entries, 'command', {})).toBe(0);
    },
  );

  it('skips unresolved accepted commands in a mixed window', () => {
    const entries = [command(1), command(2), command(3, { ack: 'refused' })];
    expect(selectReceiptEvictee(entries, entries, 'command', {})).toBe(2);
  });

  it.each(['completed', 'failed'])(
    'allows an accepted command with a durable %s final',
    (status) => {
      const entry = complete(
        command(1),
        status === 'completed' ? 'completed' : 'failed',
      );
      expect(selectReceiptEvictee([entry], [entry], 'command', {})).toBe(0);
    },
  );

  it.each(['operationalKey', 'resumeWitnessKey'])('skips the %s pin', (pin) => {
    const first = command(1, { final: 'completed' });
    const second = command(2, { ack: 'completed' });
    expect(
      selectReceiptEvictee([first, second], [first, second], 'command', {
        [pin]: first.key,
      }),
    ).toBe(1);
  });

  it('skips both pins and selects the next durable receipt', () => {
    const entries = [1, 2, 3].map((index) =>
      command(index, { ack: 'completed' }),
    );
    expect(
      selectReceiptEvictee(entries, entries, 'command', {
        operationalKey: command(1).key,
        resumeWitnessKey: command(2).key,
      }),
    ).toBe(2);
  });

  it('skips a candidate-only final in favor of an older durable entry', () => {
    const unresolved = command(1);
    const olderDurable = command(2, { admittedAt: 100, ack: 'completed' });
    const speculative = complete(unresolved, 'failed');
    expect(
      selectReceiptEvictee(
        [unresolved, olderDurable],
        [speculative, olderDurable],
        'command',
        {},
      ),
    ).toBe(1);
  });

  it('skips even a terminal candidate-only admission', () => {
    const fresh = command(1, { ack: 'refused' });
    const durable = command(2, { ack: 'completed' });
    expect(
      selectReceiptEvictee([durable], [fresh, durable], 'command', {}),
    ).toBe(1);
  });

  it('refuses 64 unresolved entries and an empty window', () => {
    const entries = Array.from({ length: 64 }, (_, index) =>
      command(index + 1),
    );
    expect(
      selectReceiptEvictee(entries, entries, 'command', {}),
    ).toBeUndefined();
    expect(selectReceiptEvictee([], [], 'command', {})).toBeUndefined();
  });

  it('compares canonical JSON rather than object identity or property order', () => {
    const entry = command(1, { final: 'completed' });
    const { reply, admittedAt, ...remaining } = entry;
    const reordered = {
      reply,
      admittedAt,
      ...remaining,
    };
    expect(reordered).not.toBe(entry);
    expect(selectReceiptEvictee([entry], [reordered], 'command', {})).toBe(0);
    expect(
      selectReceiptEvictee(
        [entry],
        [{ ...entry, admittedAt: entry.admittedAt + 1 }],
        'command',
        {},
      ),
    ).toBeUndefined();
    expect(
      selectReceiptEvictee(
        [entry],
        [complete(command(1), 'failed')],
        'command',
        {},
      ),
    ).toBeUndefined();
  });

  it('takes equal-time aliases in retained order, ignores command pins, and skips changed aliases', () => {
    const first = stop(1);
    const second = stop(2);
    const aliases = [first, second];
    expect(
      selectReceiptEvictee(aliases, aliases, 'stop', {
        operationalKey: first.key,
        resumeWitnessKey: second.key,
      }),
    ).toBe(0);
    const changed = { ...first, admittedAt: 101 };
    expect(selectReceiptEvictee(aliases, [changed, second], 'stop', {})).toBe(
      1,
    );
    expect(selectReceiptEvictee([], aliases, 'stop', {})).toBeUndefined();
  });

  it('does not select another receipt kind', () => {
    const alias = stop(1);
    expect(
      selectReceiptEvictee([alias], [alias], 'command', {}),
    ).toBeUndefined();
  });
});

describe('transaction-local fit planning (E3)', () => {
  const previous = command(1);
  const next = command(2);
  const archived = command(3);

  it('finalizes a replaced prior control and fits the new operational control in input order', () => {
    expect(
      planReceiptFits({
        priorWindowKeys: [previous.key],
        priorControl: previous,
        incomingControls: [previous, next],
        admittedOperationIds: new Set([next.operationId]),
      }),
    ).toEqual([
      { control: previous, kind: 'finalize' },
      { control: next, kind: 'fit' },
    ]);
  });

  it('fits a new coalesced completed steer, leaving the unchanged operational control retained', () => {
    const coalesced = command(2, { operation: 'steer', ack: 'completed' });
    expect(
      planReceiptFits({
        priorWindowKeys: [previous.key],
        priorControl: previous,
        incomingControls: [coalesced, previous],
        admittedOperationIds: new Set([coalesced.operationId]),
      }),
    ).toEqual([
      { control: coalesced, kind: 'fit' },
      { control: previous, kind: 'finalize' },
    ]);
  });

  it('does not refit an unchanged control on a later status or completion transaction', () => {
    const input = {
      priorWindowKeys: [previous.key],
      priorControl: previous,
      incomingControls: [previous],
      admittedOperationIds: new Set<string>(),
    };
    expect(planReceiptFits(input)).toEqual([
      { control: previous, kind: 'finalize' },
    ]);
    expect(planReceiptFits({ ...input, incomingControls: [] })).toEqual([]);
  });

  it('leaves an archived operation archived, even when it was the prior control', () => {
    expect(
      planReceiptFits({
        priorWindowKeys: [previous.key],
        priorControl: archived,
        incomingControls: [archived],
        admittedOperationIds: new Set<string>(),
      }),
    ).toEqual([{ control: archived, kind: 'archived' }]);
  });

  it('throws a defect when explicit intent attempts to admit a retained key', () => {
    expect(() =>
      planReceiptFits({
        priorWindowKeys: [previous.key],
        priorControl: previous,
        incomingControls: [previous],
        admittedOperationIds: new Set([previous.operationId]),
      }),
    ).toThrow(/defect.*already retained/);
    expect(() =>
      planReceiptFits({
        priorWindowKeys: [next.key],
        incomingControls: [next],
        admittedOperationIds: new Set([next.operationId]),
      }),
    ).toThrow(/defect/);
  });

  it('does not mutate intent or controls and does not infer intent from absence', () => {
    const incomingControls = deepFreeze([archived, next, previous]);
    const admittedOperationIds = new Set([next.operationId]);
    expect(
      planReceiptFits({
        priorWindowKeys: [previous.key],
        incomingControls,
        admittedOperationIds,
      }).map((item) => item.kind),
    ).toEqual(['archived', 'fit', 'finalize']);
    expect([...admittedOperationIds]).toEqual([next.operationId]);
    expect(incomingControls).toEqual([archived, next, previous]);
  });
});

describe('chat receipt lock (E6)', () => {
  it('serializes the same tuple through callback completion', async () => {
    const lock = createChatReceiptLock();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const first = lock.run(IDENTITY, async () => {
      events.push('first');
      entered.resolve();
      await release.promise;
      events.push('first done');
      return 1;
    });
    await entered.promise;
    const second = lock.run({ ...IDENTITY }, () => {
      events.push('second');
      return Promise.resolve(2);
    });
    await Promise.resolve();
    expect(events).toEqual(['first']);
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(['first', 'first done', 'second']);
  });

  it.each(['key', 'chatId', 'receiptKind'])(
    'allows a different %s in parallel',
    async (field) => {
      const lock = createChatReceiptLock();
      const entered = deferred();
      const release = deferred();
      const first = lock.run(IDENTITY, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const other: DelegationTranscriptReceiptIdentity =
        field === 'key'
          ? { ...IDENTITY, key: 'other' }
          : field === 'chatId'
            ? { ...IDENTITY, chatId: 'other' }
            : { ...IDENTITY, receiptKind: 'stop' };
      try {
        expect(await lock.run(other, () => Promise.resolve('parallel'))).toBe(
          'parallel',
        );
      } finally {
        release.resolve();
        await first;
      }
    },
  );

  it('releases on a rejected callback, including already queued waiters', async () => {
    const lock = createChatReceiptLock();
    const entered = deferred();
    const release = deferred();
    const first = lock.run(IDENTITY, async () => {
      entered.resolve();
      await release.promise;
      throw new Error('failed');
    });
    const rejected = expect(first).rejects.toThrow('failed');
    await entered.promise;
    const second = lock.run(IDENTITY, () => Promise.resolve('next'));
    release.resolve();
    await rejected;
    expect(await second).toBe('next');
    expect(await lock.run(IDENTITY, () => Promise.resolve('released'))).toBe(
      'released',
    );
  });

  it('releases on a synchronous throw', async () => {
    const lock = createChatReceiptLock();
    await expect(
      lock.run(IDENTITY, (): Promise<void> => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(await lock.run(IDENTITY, () => Promise.resolve(42))).toBe(42);
  });

  it('rejects nested same-identity ownership across an await instead of deadlocking', async () => {
    const lock = createChatReceiptLock();
    const nested = jest.fn(() => Promise.resolve('must not run'));
    await expect(
      lock.run(IDENTITY, async () => {
        await Promise.resolve();
        return lock.run({ ...IDENTITY }, nested);
      }),
    ).rejects.toThrow(/defect.*non-reentrant/);
    expect(nested).not.toHaveBeenCalled();
    expect(await lock.run(IDENTITY, () => Promise.resolve('released'))).toBe(
      'released',
    );
  });

  it('allows different-key nesting but rejects a cycle back to the outer key', async () => {
    const lock = createChatReceiptLock();
    await lock.run(IDENTITY, async () => {
      await lock.run({ ...IDENTITY, key: 'other' }, async () => {
        await expect(
          lock.run(IDENTITY, () => Promise.resolve()),
        ).rejects.toThrow(/non-reentrant/);
      });
    });
  });

  it('ends inherited ownership when its original callback exits', async () => {
    const lock = createChatReceiptLock();
    const later = deferred();
    let descendant: Promise<string> = Promise.resolve('not started');
    await lock.run(IDENTITY, () => {
      descendant = later.promise.then(() =>
        lock.run(IDENTITY, () => Promise.resolve('new owner')),
      );
      return Promise.resolve();
    });
    later.resolve();
    expect(await descendant).toBe('new owner');
  });

  it('encodes tuples without delimiter collisions', async () => {
    const lock = createChatReceiptLock();
    const firstIdentity: DelegationTranscriptReceiptIdentity = {
      chatId: 'a,command',
      receiptKind: 'stop',
      key: 'k',
    };
    const otherIdentity: DelegationTranscriptReceiptIdentity = {
      chatId: 'a',
      receiptKind: 'command',
      key: 'stop,k',
    };
    expect(Object.values(firstIdentity).join(',')).toBe(
      Object.values(otherIdentity).join(','),
    );
    const entered = deferred();
    const release = deferred();
    const first = lock.run(firstIdentity, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      expect(
        await lock.run(otherIdentity, () => Promise.resolve('distinct')),
      ).toBe('distinct');
    } finally {
      release.resolve();
      await first;
    }
  });
});

describe('archive-before-removal rollover (E1)', () => {
  const priorWindow = deepFreeze(
    Array.from({ length: 64 }, (_, index) =>
      command(index + 1, { ack: 'completed' }),
    ),
  );
  const fresh = command(65);
  const candidateWindow = deepFreeze([...priorWindow, fresh]);
  const first = priorWindow[0];
  if (first === undefined) throw new Error('Expected rollover fixture');

  it.each([0, 1, 64])(
    'passes through %i entries without an append',
    async (length) => {
      const window = candidateWindow.slice(0, length);
      const append = jest.fn((entry: DelegationTranscriptReceiptEntry) =>
        Promise.resolve(appendSuccess(entry)),
      );
      const result = await rollOverReceipt({
        priorWindow,
        candidateWindow: window,
        kind: 'command',
        pins: {},
        append,
      });
      expect(result).toEqual({ ok: true, window, archived: undefined });
      if (!('ok' in result) || !result.ok) throw new Error('Expected success');
      expect(result.window).toBe(window);
      expect(append).not.toHaveBeenCalled();
    },
  );

  it('refuses without append when all retained commands are unresolved', async () => {
    const prior = Array.from({ length: 64 }, (_, index) => command(index + 1));
    const append = jest.fn((entry: DelegationTranscriptReceiptEntry) =>
      Promise.resolve(appendSuccess(entry)),
    );
    expect(
      await rollOverReceipt({
        priorWindow: prior,
        candidateWindow: [...prior, fresh],
        kind: 'command',
        pins: {},
        append,
      }),
    ).toEqual({ ok: false, refused: 'capacity' });
    expect(append).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'archives exact bytes after append success (replayed=%s), without mutation',
    async (replayed) => {
      const before = canonicalDelegationJson({ priorWindow, candidateWindow });
      const gate = deferred();
      const entered = deferred();
      const append = jest.fn(async (entry: V3CommandReceiptEntry) => {
        entered.resolve();
        await gate.promise;
        return appendSuccess(entry, replayed);
      });
      let returned = false;
      const pending = rollOverReceipt({
        priorWindow,
        candidateWindow,
        kind: 'command',
        pins: {},
        append,
      });
      const observed = pending.then((result) => {
        returned = true;
        return result;
      });
      await entered.promise;
      expect(returned).toBe(false);
      expect(canonicalDelegationJson({ priorWindow, candidateWindow })).toBe(
        before,
      );
      expect(append).toHaveBeenCalledTimes(1);
      expect(append.mock.calls[0]?.[0]).toBe(first);
      gate.resolve();
      const result = await observed;
      expect(result).toEqual({
        ok: true,
        window: candidateWindow.slice(1),
        archived: first,
      });
      if (!('ok' in result) || !result.ok) throw new Error('Expected success');
      expect(result.window).toHaveLength(64);
      expect(result.archived).toBe(first);
      expect(result.window[63]).toBe(fresh);
      expect(canonicalDelegationJson({ priorWindow, candidateWindow })).toBe(
        before,
      );
    },
  );

  it.each(ERROR_CODES)(
    'treats append %s as not admitted, never absence',
    async (code) => {
      const before = canonicalDelegationJson({ priorWindow, candidateWindow });
      const append = jest.fn(() =>
        Promise.resolve(failure<DelegationTranscriptReceiptAppendResult>(code)),
      );
      expect(
        await rollOverReceipt({
          priorWindow,
          candidateWindow,
          kind: 'command',
          pins: {},
          append,
        }),
      ).toEqual({ kind: 'not_admitted', cause: 'append', code });
      expect(append).toHaveBeenCalledTimes(1);
      expect(canonicalDelegationJson({ priorWindow, candidateWindow })).toBe(
        before,
      );
    },
  );

  it.each([undefined, 'storage_failure'])(
    'catches a thrown append without changing either window: %p',
    async (code) => {
      const before = canonicalDelegationJson({ priorWindow, candidateWindow });
      const error = Object.assign(
        new Error('append failed'),
        code === undefined ? {} : { code },
      );
      const append = jest.fn(() => Promise.reject(error));
      const result = await rollOverReceipt({
        priorWindow,
        candidateWindow,
        kind: 'command',
        pins: {},
        append,
      });
      expect(result).toEqual({
        kind: 'not_admitted',
        cause: 'append',
        ...(code === undefined ? {} : { code }),
      });
      expect(canonicalDelegationJson({ priorWindow, candidateWindow })).toBe(
        before,
      );
    },
  );

  it('leaves a durable-but-reported-failed entry in the window, then retries identical bytes successfully', async () => {
    let durable: string | undefined;
    const append = jest.fn((entry: V3CommandReceiptEntry) => {
      const bytes = canonicalDelegationJson(entry);
      if (durable === undefined) {
        durable = bytes;
        return Promise.resolve(
          failure<DelegationTranscriptReceiptAppendResult>('storage_failure'),
        );
      }
      expect(bytes).toBe(durable);
      return Promise.resolve(appendSuccess(entry, true));
    });
    const input = {
      priorWindow,
      candidateWindow,
      kind: 'command',
      pins: {},
      append,
    } satisfies Parameters<typeof rollOverReceipt<V3CommandReceiptEntry>>[0];
    expect(await rollOverReceipt(input)).toEqual({
      kind: 'not_admitted',
      cause: 'append',
      code: 'storage_failure',
    });
    expect(candidateWindow[0]).toBe(first);
    expect(priorWindow).toHaveLength(64);
    expect(candidateWindow).toHaveLength(65);
    expect(await rollOverReceipt(input)).toEqual({
      ok: true,
      window: candidateWindow.slice(1),
      archived: first,
    });
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('rolls stop aliases without changing their shared operation identity', async () => {
    const prior = deepFreeze(
      Array.from({ length: 64 }, (_, index) => stop(index + 1)),
    );
    const window = deepFreeze([...prior, stop(65)]);
    const append = jest.fn((entry: V3StopReceiptEntry) =>
      Promise.resolve(appendSuccess(entry)),
    );
    expect(
      await rollOverReceipt({
        priorWindow: prior,
        candidateWindow: window,
        kind: 'stop',
        pins: {},
        append,
      }),
    ).toEqual({ ok: true, window: window.slice(1), archived: prior[0] });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toBe(prior[0]);
  });

  it('rejects inputs that admit more than one receipt into a bounded window', async () => {
    const prior = deepFreeze(
      Array.from({ length: 64 }, (_, index) => stop(index + 1)),
    );
    const append = jest.fn((entry: V3StopReceiptEntry) =>
      Promise.resolve(appendSuccess(entry)),
    );
    await expect(
      rollOverReceipt({
        priorWindow: prior,
        candidateWindow: [...prior, stop(65), stop(66)],
        kind: 'stop',
        pins: {},
        append,
      }),
    ).rejects.toThrow('one receipt');
    await expect(
      rollOverReceipt({
        priorWindow: [...prior, stop(65)],
        candidateWindow: [...prior, stop(65)],
        kind: 'stop',
        pins: {},
        append,
      }),
    ).rejects.toThrow('one receipt');
    expect(append).not.toHaveBeenCalled();
  });
});

describe('restart-scoped quarantine and activity (E1/B9/E9)', () => {
  it('quarantines by delegation and reserves a chat-kind-key independently and idempotently', () => {
    const quarantine = new ReceiptQuarantine();
    expect(quarantine.isQuarantined('delegate')).toBe(false);
    expect(quarantine.isReserved(IDENTITY)).toBe(false);
    quarantine.quarantine('delegate');
    quarantine.quarantine('delegate');
    expect(quarantine.isQuarantined('delegate')).toBe(true);
    expect(quarantine.isQuarantined('another')).toBe(false);
    expect(quarantine.isReserved(IDENTITY)).toBe(false);
    quarantine.reserve(IDENTITY);
    quarantine.reserve({ ...IDENTITY });
    expect(quarantine.isReserved({ ...IDENTITY })).toBe(true);
    expect(quarantine.isReserved({ ...IDENTITY, chatId: 'other' })).toBe(false);
    expect(quarantine.isReserved({ ...IDENTITY, receiptKind: 'stop' })).toBe(
      false,
    );
    expect(quarantine.isReserved({ ...IDENTITY, key: 'other' })).toBe(false);
    expect(new ReceiptQuarantine().isQuarantined('delegate')).toBe(false);
    expect(new ReceiptQuarantine().isReserved(IDENTITY)).toBe(false);
  });

  it('reserves collision-safe tuples without acquiring or holding the chat lock', async () => {
    const quarantine = new ReceiptQuarantine();
    const identity: DelegationTranscriptReceiptIdentity = {
      chatId: 'a,command',
      receiptKind: 'stop',
      key: 'k',
    };
    const other: DelegationTranscriptReceiptIdentity = {
      chatId: 'a',
      receiptKind: 'command',
      key: 'stop,k',
    };
    quarantine.reserve(identity);
    expect(quarantine.isReserved(other)).toBe(false);
    expect(
      await createChatReceiptLock().run(identity, () =>
        Promise.resolve('not a mutex'),
      ),
    ).toBe('not a mutex');
  });

  it.each([
    { previous: 100, events: [], expected: 100 },
    { previous: 100, events: [10, 99, 100], expected: 100 },
    { previous: 100, events: [120, 110, 140, 130], expected: 140 },
    { previous: 0, events: [0], expected: 0 },
    { previous: 140, events: [140, 140], expected: 140 },
  ])(
    'folds only supplied admission/first-resolution times: %p',
    ({ previous, events, expected }) => {
      const times = deepFreeze([...events]);
      expect(foldReceiptActivity(previous, times)).toBe(expected);
      expect(times).toEqual(events);
    },
  );
});
