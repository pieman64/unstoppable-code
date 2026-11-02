import {
  handoffV3StopOutcome,
  readV3StopOutcome,
} from '../broker-stop-outcome';
import type { V3StopOutcomeDependencies } from '../broker-stop-outcome';
import type {
  DelegationTranscriptPort,
  DelegationTranscriptPortError,
  DelegationTranscriptPortErrorCode,
  DelegationTranscriptReceiptEntry,
  DelegationTranscriptReceiptIdentity,
} from '../transcript-port';
import type {
  V3ReceiptState,
  V3StopOutcomeEntry,
  V3StopReceiptEntry,
} from '../record-v3';

const CHAT_ID = 'chat-1';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000003';
const OPERATION_A = '00000000-0000-4000-8000-000000000011';
const OPERATION_B = '00000000-0000-4000-8000-000000000012';
const RUN_A = 7;
const RUN_B = 8;
const ALIAS_KEY_A = 'a'.repeat(64);
const ALIAS_KEY_B = 'b'.repeat(64);

interface DurableRecordStore {
  state: V3ReceiptState;
  commitCalls: number;
  failBeforeCommitAt: number | undefined;
  failAfterCommitAt: number | undefined;
  replaceBeforeCommitAt: number | undefined;
  replacementBeforeCommit: V3ReceiptState | undefined;
}

interface DurableTranscriptStore {
  entries: Map<string, DelegationTranscriptReceiptEntry>;
  appendCalls: number;
  receiptCalls: number;
  appendError: DelegationTranscriptPortError | undefined;
  receiptError: DelegationTranscriptPortError | undefined;
}

function portError(
  code: DelegationTranscriptPortErrorCode,
  message: string,
  retryable = false,
): DelegationTranscriptPortError {
  return { code, message, retryable };
}

function alias(
  operationId: string,
  key: string,
  runGeneration: number,
  admittedAt: number,
  ackStatus: 'accepted' | 'completed' | 'failed' = 'accepted',
): V3StopReceiptEntry {
  return {
    version: 1,
    kind: 'receipt',
    chatId: CHAT_ID,
    receiptKind: 'stop',
    key,
    delegationId: DELEGATION_ID,
    runGeneration,
    operationId,
    requestHash: 'c'.repeat(64),
    operation: 'stop',
    admittedAt,
    reply: { kind: 'stop', ackStatus, runGeneration },
  };
}

function outcome(
  operationId: string,
  runGeneration: number,
  admittedAt: number,
  status: 'completed' | 'failed' = 'completed',
  finishedAt = 200,
): V3StopOutcomeEntry {
  return {
    version: 1,
    kind: 'receipt',
    chatId: CHAT_ID,
    receiptKind: 'stop_outcome',
    key: operationId,
    delegationId: DELEGATION_ID,
    runGeneration,
    operationId,
    requestHash: null,
    operation: 'stop',
    admittedAt,
    reply: { kind: 'stop_outcome', status, finishedAt, runGeneration },
  };
}

function activeState(
  activeAlias: V3StopReceiptEntry,
  status: 'accepted' | 'completed' | 'failed' = 'accepted',
  pendingOutcome?: V3StopOutcomeEntry,
  historicalAliases: readonly V3StopReceiptEntry[] = [],
): V3ReceiptState {
  return {
    commandReceipts: [],
    stopReceipts: [...historicalAliases, activeAlias],
    activeStop: {
      operationId: activeAlias.operationId,
      runGeneration: activeAlias.runGeneration,
      admittedAt: activeAlias.admittedAt,
      ...(pendingOutcome === undefined
        ? {}
        : { pendingTerminalOutcome: pendingOutcome }),
    },
    stopFence: { operationId: activeAlias.operationId, status },
  };
}

function recordStore(state: V3ReceiptState): DurableRecordStore {
  return {
    state,
    commitCalls: 0,
    failBeforeCommitAt: undefined,
    failAfterCommitAt: undefined,
    replaceBeforeCommitAt: undefined,
    replacementBeforeCommit: undefined,
  };
}

function transcriptStore(): DurableTranscriptStore {
  return {
    entries: new Map(),
    appendCalls: 0,
    receiptCalls: 0,
    appendError: undefined,
    receiptError: undefined,
  };
}

function receiptKey(
  identity: Pick<DelegationTranscriptReceiptIdentity, 'receiptKind' | 'key'>,
): string {
  return `${identity.receiptKind}:${identity.key}`;
}

function portFor(
  store: DurableTranscriptStore,
): Pick<DelegationTranscriptPort, 'appendReceipt' | 'receipt'> {
  return {
    appendReceipt(
      input,
    ): Promise<Awaited<ReturnType<DelegationTranscriptPort['appendReceipt']>>> {
      store.appendCalls += 1;
      if (store.appendError !== undefined)
        return Promise.resolve({ ok: false, error: store.appendError });
      const key = receiptKey(input);
      const existing = store.entries.get(key);
      if (existing !== undefined) {
        return existing === input
          ? Promise.resolve({
              ok: true,
              value: { entry: existing, replayed: true },
            })
          : Promise.resolve({
              ok: false,
              error: portError(
                'conflict',
                'The receipt key already names different content.',
              ),
            });
      }
      store.entries.set(key, input);
      return Promise.resolve({
        ok: true,
        value: { entry: input, replayed: false },
      });
    },
    receipt(
      input,
    ): Promise<Awaited<ReturnType<DelegationTranscriptPort['receipt']>>> {
      store.receiptCalls += 1;
      if (store.receiptError !== undefined)
        return Promise.resolve({ ok: false, error: store.receiptError });
      const entry = store.entries.get(receiptKey(input));
      return entry === undefined
        ? Promise.resolve({
            ok: false,
            error: portError('not_found', 'The receipt was not found.'),
          })
        : Promise.resolve({ ok: true, value: entry });
    },
  };
}

function dependenciesFor(
  record: DurableRecordStore,
  transcript: DurableTranscriptStore,
): V3StopOutcomeDependencies {
  return {
    read(): Promise<V3ReceiptState> {
      return Promise.resolve(record.state);
    },
    commit(
      change: (receipts: V3ReceiptState) => V3ReceiptState,
    ): Promise<void> {
      record.commitCalls += 1;
      const call = record.commitCalls;
      if (record.failBeforeCommitAt === call)
        throw new Error('Injected failure before record commit');
      if (
        record.replaceBeforeCommitAt === call &&
        record.replacementBeforeCommit !== undefined
      )
        record.state = record.replacementBeforeCommit;
      record.state = change(record.state);
      if (record.failAfterCommitAt === call)
        throw new Error('Injected failure after record commit');
      return Promise.resolve();
    },
    port: portFor(transcript),
  };
}

const IDENTITY = { chatId: CHAT_ID, delegationId: DELEGATION_ID };
const ALIAS_A = alias(OPERATION_A, ALIAS_KEY_A, RUN_A, 150);
const ALIAS_B = alias(OPERATION_B, ALIAS_KEY_B, RUN_B, 250);
const OUTCOME_A = outcome(OPERATION_A, RUN_A, ALIAS_A.admittedAt);

describe('v3 stop outcome handoff and reader', () => {
  it('recovers a crash before the pending-outcome commit after reopening both stores', async () => {
    const record = recordStore(activeState(ALIAS_A));
    const transcript = transcriptStore();
    record.failBeforeCommitAt = 1;

    const first = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(first).toMatchObject({
      ok: false,
      error: { code: 'storage_failure' },
    });
    expect(record.state.activeStop?.pendingTerminalOutcome).toBeUndefined();
    expect(transcript.appendCalls).toBe(0);

    record.failBeforeCommitAt = undefined;
    const reopened = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(reopened).toEqual({ ok: true, value: { cleared: true } });
    expect(record.state.activeStop).toBeUndefined();
    expect(transcript.entries.get(`stop_outcome:${OPERATION_A}`)).toEqual(
      OUTCOME_A,
    );
  });

  it('replays a persisted pending outcome after a crash immediately after its commit', async () => {
    const record = recordStore(activeState(ALIAS_A));
    const transcript = transcriptStore();
    record.failAfterCommitAt = 1;

    const first = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(first).toMatchObject({
      ok: false,
      error: { code: 'storage_failure' },
    });
    expect(record.state.activeStop?.pendingTerminalOutcome).toEqual(OUTCOME_A);
    expect(transcript.appendCalls).toBe(0);

    record.failAfterCommitAt = undefined;
    const reopened = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(reopened).toEqual({ ok: true, value: { cleared: true } });
    expect(record.state.activeStop).toBeUndefined();
    expect(transcript.entries.get(`stop_outcome:${OPERATION_A}`)).toEqual(
      OUTCOME_A,
    );
  });

  it('retains the pending outcome when append fails and completes after reopening', async () => {
    const record = recordStore(activeState(ALIAS_A));
    const transcript = transcriptStore();
    transcript.appendError = portError(
      'storage_failure',
      'The transcript store is unavailable.',
      true,
    );

    const first = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(first).toMatchObject({
      ok: false,
      error: { code: 'storage_failure', retryable: true },
    });
    expect(record.state.activeStop?.pendingTerminalOutcome).toEqual(OUTCOME_A);
    expect(record.state.activeStop?.operationId).toBe(OPERATION_A);

    transcript.appendError = undefined;
    const reopened = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(reopened).toEqual({ ok: true, value: { cleared: true } });
    expect(transcript.entries.get(`stop_outcome:${OPERATION_A}`)).toEqual(
      OUTCOME_A,
    );
  });

  it('retains the slot when clear fails after append, then replays the immutable append', async () => {
    const record = recordStore(activeState(ALIAS_A));
    const transcript = transcriptStore();
    record.failBeforeCommitAt = 2;

    const first = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(first).toMatchObject({
      ok: false,
      error: { code: 'storage_failure' },
    });
    expect(record.state.activeStop?.pendingTerminalOutcome).toEqual(OUTCOME_A);
    expect(transcript.entries.get(`stop_outcome:${OPERATION_A}`)).toEqual(
      OUTCOME_A,
    );

    record.failBeforeCommitAt = undefined;
    const reopened = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(reopened).toEqual({ ok: true, value: { cleared: true } });
    expect(transcript.entries.get(`stop_outcome:${OPERATION_A}`)).toEqual(
      OUTCOME_A,
    );
    expect(transcript.appendCalls).toBe(2);
    expect(record.state.activeStop).toBeUndefined();
    expect(record.state.stopFence).toEqual({
      operationId: OPERATION_A,
      status: 'completed',
    });
  });

  it('reads the durable outcome after a crash following clear without duplicating it', async () => {
    const record = recordStore(activeState(ALIAS_A));
    const transcript = transcriptStore();

    const completed = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );
    const appendCount = transcript.appendCalls;
    const reopenedRead = await readV3StopOutcome(
      IDENTITY,
      ALIAS_A,
      dependenciesFor(record, transcript),
    );
    const reopenedHandoff = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(completed).toEqual({ ok: true, value: { cleared: true } });
    expect(reopenedRead).toEqual({
      ok: true,
      value: { kind: 'outcome', outcome: OUTCOME_A },
    });
    expect(reopenedHandoff).toEqual({ ok: true, value: { cleared: false } });
    expect(transcript.appendCalls).toBe(appendCount);
    expect(record.state.activeStop).toBeUndefined();
  });

  it('keeps an old A outcome immutable across clear, resume, new B and restart', async () => {
    const record = recordStore(activeState(ALIAS_A));
    const transcript = transcriptStore();
    await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    record.state = {
      commandReceipts: [],
      stopReceipts: [ALIAS_A],
    };
    record.state = activeState(ALIAS_B, 'accepted', undefined, [ALIAS_A]);
    const beforeRead = record.state;
    const replay = await readV3StopOutcome(
      IDENTITY,
      ALIAS_A,
      dependenciesFor(record, transcript),
    );

    expect(replay).toEqual({
      ok: true,
      value: { kind: 'outcome', outcome: OUTCOME_A },
    });
    expect(record.state).toBe(beforeRead);
    expect(record.state.activeStop?.operationId).toBe(OPERATION_B);
    expect(record.state.stopFence).toEqual({
      operationId: OPERATION_B,
      status: 'accepted',
    });
  });

  it('uses the matching active slot status before consulting the transcript', async () => {
    const pending = outcome(OPERATION_A, RUN_A, ALIAS_A.admittedAt, 'failed');
    const record = recordStore(activeState(ALIAS_A, 'failed', pending));
    const transcript = transcriptStore();

    const result = await readV3StopOutcome(
      IDENTITY,
      ALIAS_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toEqual({
      ok: true,
      value: { kind: 'active', status: 'failed' },
    });
    expect(transcript.receiptCalls).toBe(0);
  });

  it('accepts a matching pending outcome while the fence still says accepted', async () => {
    const pending = outcome(OPERATION_A, RUN_A, ALIAS_A.admittedAt, 'failed');
    const record = recordStore(activeState(ALIAS_A, 'accepted', pending));
    const transcript = transcriptStore();

    const result = await readV3StopOutcome(
      IDENTITY,
      ALIAS_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toEqual({
      ok: true,
      value: { kind: 'active', status: 'failed' },
    });
    expect(transcript.receiptCalls).toBe(0);
  });

  it('rejects a mismatched pending identity even while the fence says accepted', async () => {
    const wrongPending = outcome(
      OPERATION_B,
      RUN_B,
      ALIAS_B.admittedAt,
      'failed',
    );
    const record = recordStore(activeState(ALIAS_A, 'accepted', wrongPending));
    const transcript = transcriptStore();

    const result = await readV3StopOutcome(
      IDENTITY,
      ALIAS_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
    expect(transcript.receiptCalls).toBe(0);
  });

  it('fails closed as corruption when a non-active operation has no durable outcome', async () => {
    const record = recordStore({
      commandReceipts: [],
      stopReceipts: [ALIAS_A],
    });
    const transcript = transcriptStore();

    const result = await readV3StopOutcome(
      IDENTITY,
      ALIAS_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'corruption', retryable: false },
    });
  });

  it('surfaces an unavailable durable lookup instead of guessing a status', async () => {
    const record = recordStore({
      commandReceipts: [],
      stopReceipts: [ALIAS_A],
    });
    const transcript = transcriptStore();
    transcript.receiptError = portError(
      'storage_failure',
      'The transcript store is unavailable.',
      true,
    );

    const result = await readV3StopOutcome(
      IDENTITY,
      ALIAS_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'storage_failure', retryable: true },
    });
  });

  it('rejects a mismatched durable outcome as an identity conflict', async () => {
    const record = recordStore({
      commandReceipts: [],
      stopReceipts: [ALIAS_A],
    });
    const transcript = transcriptStore();
    const wrongOutcome = outcome(OPERATION_B, RUN_B, ALIAS_B.admittedAt);
    transcript.entries.set(`stop_outcome:${OPERATION_A}`, wrongOutcome);

    const result = await readV3StopOutcome(
      IDENTITY,
      ALIAS_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
  });

  it('does not let a late completion of A mutate B or its stop fence', async () => {
    const record = recordStore(
      activeState(ALIAS_B, 'accepted', undefined, [ALIAS_A]),
    );
    const transcript = transcriptStore();
    const before = record.state;

    const result = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
    expect(record.state).toBe(before);
    expect(record.state.activeStop?.operationId).toBe(OPERATION_B);
    expect(record.state.stopFence).toEqual({
      operationId: OPERATION_B,
      status: 'accepted',
    });
    expect(transcript.appendCalls).toBe(0);
  });

  it('rechecks identity when clearing so a concurrent B is not removed', async () => {
    const stateB = activeState(ALIAS_B, 'accepted', undefined, [ALIAS_A]);
    const record = recordStore(activeState(ALIAS_A));
    const transcript = transcriptStore();
    record.replaceBeforeCommitAt = 2;
    record.replacementBeforeCommit = stateB;

    const result = await handoffV3StopOutcome(
      IDENTITY,
      OUTCOME_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
    expect(record.state).toBe(stateB);
    expect(record.state.activeStop?.operationId).toBe(OPERATION_B);
    expect(record.state.stopFence).toEqual({
      operationId: OPERATION_B,
      status: 'accepted',
    });
    expect(transcript.entries.get(`stop_outcome:${OPERATION_A}`)).toEqual(
      OUTCOME_A,
    );
  });

  it('rejects an alias outside the requested delegation identity', async () => {
    const record = recordStore({ commandReceipts: [], stopReceipts: [] });
    const transcript = transcriptStore();

    const result = await readV3StopOutcome(
      { chatId: CHAT_ID, delegationId: '00000000-0000-4000-8000-000000000099' },
      ALIAS_A,
      dependenciesFor(record, transcript),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
    expect(transcript.receiptCalls).toBe(0);
  });
});
