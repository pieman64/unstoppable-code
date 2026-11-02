import { createHash } from 'node:crypto';
import type {
  StoredDelegationControl,
  StoredDelegationLegacy,
} from '../broker';
import type {
  AgentDelegationSpawnRequest,
  DelegationMessageAuthor,
} from '@canopy/protocol/delegation';
import {
  completeDelegationCommandReceipt,
  fitDelegationReceiptAck,
  fitDelegationStopReceipt,
} from '../receipt-reply';
import { createDelegationRunState } from '../lifecycle';
import { DelegationReadMetadataError } from '../record-read-metadata';
import {
  decodeStoredDelegationV3,
  delegationSettlementKey,
  delegationStopRequestHash,
  encodeStoredDelegationV3,
  legacyPrefixView,
  readMetadataOfRecord,
  readMetadataOfValidatedRecord,
  currentStopPolicy,
  MAX_V3_LATEST_RECEIPT_BYTES,
  MAX_V3_LATEST_RECEIPT_ITEMS,
  nextV3ReceiptAdmissionTime,
} from '../record-v3';
import type {
  StoredDelegationV3Answer,
  V3CommandReceiptEntry,
  V3StopReceiptEntry,
  StoredDelegationV3Registration,
  V3StopOutcomeEntry,
} from '../record-v3';
import type { DelegationRecordReadMetadata } from '../record-read-metadata';
import { delegationTranscriptSettlementDigest } from '../settlement-identity';
import type {
  DelegationTranscriptSettleRequest,
  DelegationTranscriptSettlementOutcome,
  DelegationTranscriptTarget,
} from '../transcript-port';
import type { DelegationParentContext } from '../types';

const CHAT_ID = 'chat-1';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000003';
const RUN_GENERATION = 7;
const CALL_KEY = 'c'.repeat(64);
const COMMAND_OPERATION_ID = '00000000-0000-4000-8000-000000000010';
const OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_OPERATION_ID = '00000000-0000-4000-8000-000000000002';
const CONTROL_AUTHORS: readonly {
  readonly name: string;
  readonly sender: DelegationMessageAuthor;
}[] = [
  { name: 'user', sender: { kind: 'user' } },
  {
    name: 'agent',
    sender: {
      kind: 'agent',
      depth: 2,
      delegationId: 'agent-2',
      description: 'nested agent',
    },
  },
];
const VALID_SETTLING_ANSWERS: readonly StoredDelegationV3Answer[] = [
  'none',
  { role: 'final', empty: true },
  { role: 'final', sha256: 'a'.repeat(64), length: 5 },
];

function parent(): DelegationParentContext {
  return {
    harnessId: 'harness',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: CHAT_ID,
    sessionKey: 'session',
    turnId: 'turn',
    toolCallId: 'tool-call',
    runtimeGeneration: 1,
    depth: 0,
  };
}

function task(): AgentDelegationSpawnRequest {
  return {
    modelId: 'model',
    description: 'task',
    prompt: 'prompt',
    executionMode: 'background',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
  };
}

function readMetadata(
  runGeneration = RUN_GENERATION,
): DelegationRecordReadMetadata {
  return {
    originAt: 100,
    lastActivityAt: 120,
    current: {
      store: 'stream',
      target: {
        kind: 'delegation',
        chatId: CHAT_ID,
        delegationId: DELEGATION_ID,
        runGeneration,
      },
    },
  };
}

function registration(
  runGeneration = RUN_GENERATION,
): StoredDelegationV3Registration {
  return {
    runGeneration,
    createdAt: 100,
    store: 'stream',
    origin: { kind: 'launch' },
    executionMode: 'background',
  };
}

function recordFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    version: 3,
    parent: parent(),
    task: task(),
    callKey: CALL_KEY,
    requestHash: 'a'.repeat(64),
    createdAt: 100,
    state: createDelegationRunState(DELEGATION_ID, RUN_GENERATION),
    launch: {
      version: 1,
      delegationId: DELEGATION_ID,
      launchKey: CALL_KEY,
      runGeneration: RUN_GENERATION,
      phase: 'reserved',
    },
    delivery: { status: 'unclaimed' },
    readMetadata: readMetadata(),
    registration: registration(),
    receipts: { commandReceipts: [], stopReceipts: [] },
    ...overrides,
  };
  if (overrides.settling !== undefined && overrides.readMetadata === undefined)
    record.readMetadata = {
      ...readMetadata(),
      settling: { runGeneration: RUN_GENERATION },
    };
  return record;
}

function legacyRecord(
  version: 1 | 2,
  stopRequested?: NonNullable<StoredDelegationLegacy['stopRequested']>,
): StoredDelegationLegacy {
  return {
    version,
    parent: parent(),
    task: task(),
    callKey: CALL_KEY,
    requestHash: 'a'.repeat(64),
    createdAt: 100,
    state: createDelegationRunState(DELEGATION_ID, RUN_GENERATION),
    launch: {
      version: 1,
      delegationId: DELEGATION_ID,
      launchKey: CALL_KEY,
      runGeneration: RUN_GENERATION,
      phase: 'reserved',
    },
    delivery: { status: 'unclaimed' },
    ...(stopRequested === undefined ? {} : { stopRequested }),
  };
}

function stopOutcomeEntry(status: 'completed' | 'failed'): V3StopOutcomeEntry {
  return {
    version: 1,
    kind: 'receipt',
    chatId: CHAT_ID,
    receiptKind: 'stop_outcome',
    key: OPERATION_ID,
    delegationId: DELEGATION_ID,
    runGeneration: RUN_GENERATION,
    operationId: OPERATION_ID,
    requestHash: null,
    operation: 'stop',
    admittedAt: 150,
    reply: {
      kind: 'stop_outcome',
      status,
      finishedAt: 200,
      runGeneration: RUN_GENERATION,
    },
  };
}

function stopState(
  status?: 'accepted' | 'completed' | 'failed',
  activeStatus?: 'accepted' | 'completed' | 'failed',
): Record<string, unknown> {
  return {
    commandReceipts: [],
    stopReceipts: [],
    ...(status === undefined
      ? {}
      : {
          stopFence: {
            operationId: OPERATION_ID,
            status,
          },
        }),
    ...(activeStatus === undefined
      ? {}
      : {
          activeStop: {
            operationId: OPERATION_ID,
            runGeneration: RUN_GENERATION,
            admittedAt: 150,
            ...(activeStatus === 'accepted'
              ? {}
              : { pendingTerminalOutcome: stopOutcomeEntry(activeStatus) }),
          },
        }),
  };
}

function commandReceipt(
  options: {
    readonly key?: string;
    readonly operationId?: string;
    readonly operation?:
      | 'follow_up'
      | 'resume'
      | 'steer'
      | 'interrupt'
      | 'apply'
      | 'discard';
    readonly admittedAt?: number;
    readonly runGeneration?: number;
    readonly replyDelegationId?: string;
    readonly replyRunGeneration?: number;
    readonly replyControlOperationId?: string;
    readonly replyOperation?:
      | 'follow_up'
      | 'resume'
      | 'steer'
      | 'interrupt'
      | 'apply'
      | 'discard';
    readonly refused?: boolean;
    readonly final?: 'completed' | 'failed';
  } = {},
): V3CommandReceiptEntry {
  const operation = options.operation ?? 'follow_up';
  const operationId = options.operationId ?? COMMAND_OPERATION_ID;
  const result = fitDelegationReceiptAck(
    {
      chatId: CHAT_ID,
      delegationId: DELEGATION_ID,
      receiptKind: 'command',
      key: options.key ?? 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      operationId,
      runGeneration: options.runGeneration ?? RUN_GENERATION,
      operation,
      admittedAt: options.admittedAt ?? 130,
    },
    options.refused === true
      ? {
          ok: false,
          error: {
            code: 'policy_blocked',
            message: 'Resume is not allowed.',
            retryable: false,
          },
        }
      : {
          ok: true,
          outcome: 'accepted',
          snapshot: {
            delegationId: options.replyDelegationId ?? DELEGATION_ID,
            runGeneration:
              options.replyRunGeneration ??
              options.runGeneration ??
              RUN_GENERATION,
            status: 'running',
            outputTruncated: false,
            control: {
              operationId: options.replyControlOperationId ?? operationId,
              operation: options.replyOperation ?? operation,
              status: 'accepted',
            },
          },
        },
  );
  if (!result.ok) throw new Error('Expected valid command receipt');
  const entry = result.entry;
  if (entry.receiptKind !== 'command' || entry.reply.kind !== 'command')
    throw new Error('Expected valid command receipt');
  const reply = entry.reply;
  if (options.final === undefined)
    return {
      ...entry,
      receiptKind: 'command',
      reply: {
        kind: 'command',
        ack: reply.ack,
        final: reply.final,
      },
    };
  const completed = completeDelegationCommandReceipt(result.entry, {
    status: options.final,
  });
  if (!completed.ok) throw new Error('Expected completed command receipt');
  const completedEntry = completed.entry;
  if (
    completedEntry.receiptKind !== 'command' ||
    completedEntry.reply.kind !== 'command'
  )
    throw new Error('Expected completed command receipt');
  const completedReply = completedEntry.reply;
  return {
    ...completedEntry,
    receiptKind: 'command',
    reply: {
      kind: 'command',
      ack: completedReply.ack,
      final: completedReply.final,
    },
  };
}

function stopReceipt(
  index: number,
  runGeneration = RUN_GENERATION,
  admittedAt = 140,
  operationId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
): V3StopReceiptEntry {
  const result = fitDelegationStopReceipt(
    {
      chatId: CHAT_ID,
      delegationId: DELEGATION_ID,
      receiptKind: 'stop',
      key: `${index.toString(16).padStart(4, '0')}${'c'.repeat(60)}`,
      requestHash: 'd'.repeat(64),
      operationId,
      runGeneration,
      operation: 'stop',
      admittedAt,
    },
    'accepted',
  );
  if (!result.ok) throw new Error('Expected valid stop receipt');
  const entry = result.entry;
  if (entry.receiptKind !== 'stop' || entry.reply.kind !== 'stop')
    throw new Error('Expected valid stop receipt');
  const reply = entry.reply;
  return {
    ...entry,
    receiptKind: 'stop',
    reply: {
      kind: 'stop',
      ackStatus: reply.ackStatus,
      runGeneration: reply.runGeneration,
    },
  };
}

function settlingIntent(
  answer: StoredDelegationV3Answer,
  assertedResultIndex = 1,
): Record<string, unknown> {
  const target: DelegationTranscriptTarget = {
    kind: 'delegation',
    chatId: CHAT_ID,
    delegationId: DELEGATION_ID,
    runGeneration: RUN_GENERATION,
  };
  const settlementKey = delegationSettlementKey(
    CHAT_ID,
    DELEGATION_ID,
    RUN_GENERATION,
  );
  const settleAnswer =
    answer === 'none'
      ? null
      : 'empty' in answer
        ? { role: answer.role, text: '' }
        : {
            role: answer.role,
            lost: { sha256: answer.sha256, length: answer.length },
          };
  const request: DelegationTranscriptSettleRequest = {
    target,
    settlementKey,
    resultIndex: assertedResultIndex,
    outcome: { status: 'completed', finishedAt: 200 },
    finalChanges: [],
    answer: settleAnswer,
    openRows: 'finalize',
  };
  return {
    runGeneration: RUN_GENERATION,
    settlementKey,
    assertedResultIndex,
    outcome: request.outcome,
    answer,
    expectedSettlementDigest: delegationTranscriptSettlementDigest(request),
  };
}

function historyEntry(runGeneration: number): Record<string, unknown> {
  return {
    delegationId: DELEGATION_ID,
    runGeneration,
    sequence: 1,
    parentHarnessId: 'harness',
    parentTurnId: 'turn',
    parentToolCallId: 'tool-call',
    createdAt: 100 + runGeneration,
    task: {
      description: 'task',
      prompt: 'prompt',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: DELEGATION_ID,
      runGeneration,
      status: 'completed',
      outputTruncated: false,
      routeSnapshot: {
        selectedModelId: 'model',
        runtimeModelId: 'model',
        harnessId: 'harness',
      },
    },
    transcript: [],
  };
}

function controlFor(
  sender: DelegationMessageAuthor,
  receipt = commandReceipt(),
): StoredDelegationControl {
  if (receipt.operation === 'stop') {
    throw new Error('Expected a command receipt for stored control');
  }
  return {
    operationId: receipt.operationId,
    key: receipt.key,
    requestHash: 'b'.repeat(64),
    operation: receipt.operation,
    status: 'accepted',
    sender,
  };
}

function latestReceipt(
  items: readonly {
    readonly id: string;
    readonly itemRevision: number;
    readonly final: boolean;
  }[] = [{ id: 'row-1', itemRevision: 0, final: false }],
): Record<string, unknown> {
  return {
    target: {
      kind: 'delegation',
      chatId: CHAT_ID,
      delegationId: DELEGATION_ID,
      runGeneration: RUN_GENERATION,
    },
    mutationKey: 'mutation-1',
    streamRevision: 1,
    items,
    replayed: false,
  };
}

function resultLocator(
  resultIndex: number,
  runGeneration: number,
): Record<string, unknown> {
  return {
    resultIndex,
    runGeneration,
    status: 'completed',
    settledAt: 190,
  };
}

function route(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    selectedModelId: 'model',
    runtimeModelId: 'model',
    harnessId: 'harness',
    runtimeKind: 'runtime',
    runnerRegistrationId: 'runner',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'catalog',
    providerType: 'provider',
    assignmentRevision: 'assignment',
    billingAuthority: 'provider',
    aiCreditsRouted: false,
    capabilities: [],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'snapshot',
    capabilityGeneration: 1,
    policyRevision: 'policy',
    ...overrides,
  };
}

describe('stored delegation v3 record contract', () => {
  it('roundtrips strictly without changing legacy-prefix order or contents', () => {
    const prefix = {
      results: [
        {
          resultIndex: 1,
          runGeneration: 2,
          status: 'completed',
          settledAt: 110,
          finalText: 'older answer',
          outputTruncated: false,
        },
        {
          resultIndex: 2,
          runGeneration: 4,
          status: 'failed',
          settledAt: 120,
          outputTruncated: false,
        },
      ],
      stopRequests: [
        {
          operationId: OPERATION_ID,
          key: 'd'.repeat(64),
          runGeneration: 2,
          status: 'completed',
        },
        {
          operationId: OTHER_OPERATION_ID,
          key: 'e'.repeat(64),
          runGeneration: 4,
          status: 'failed',
        },
      ],
    };
    const record = decodeStoredDelegationV3(
      recordFixture({ legacyPrefix: prefix }),
    );
    const encoded = encodeStoredDelegationV3(record);
    const decoded = decodeStoredDelegationV3(JSON.parse(encoded));

    expect(encodeStoredDelegationV3(record)).toBe(encoded);
    expect(decoded.legacyPrefix).toEqual(prefix);
    expect(
      decoded.legacyPrefix?.results?.map((result) => result.resultIndex),
    ).toEqual([1, 2]);
    expect(legacyPrefixView(decoded)).toBe(decoded.legacyPrefix);
  });

  it.each([
    [
      'an unknown top-level field',
      (): Record<string, unknown> => ({ ...recordFixture(), unexpected: true }),
    ],
    [
      'a non-v3 version',
      (): Record<string, unknown> => ({ ...recordFixture(), version: 4 }),
    ],
    [
      'a nested unknown capsule field',
      (): Record<string, unknown> => ({
        ...recordFixture(),
        readMetadata: { ...readMetadata(), unexpected: true },
      }),
    ],
    [
      'an unknown field in retained spawn identity metadata',
      (): Record<string, unknown> =>
        recordFixture({
          spawnIdentity: {
            key: 'd'.repeat(64),
            hash: 'e'.repeat(64),
            unexpected: true,
          },
        }),
    ],
    [
      'an unknown field in a retained route',
      (): Record<string, unknown> =>
        recordFixture({ route: route({ unexpected: true }) }),
    ],
    [
      'an unknown field in a retained workspace observation',
      (): Record<string, unknown> =>
        recordFixture({
          workspaceObservation: {
            consistency: 'live_shared_worktree',
            headRevision: null,
            dirty: false,
            observedAt: 100,
            unexpected: true,
          },
        }),
    ],
    [
      'a registration generation that does not match the record',
      (): Record<string, unknown> => ({
        ...recordFixture(),
        registration: registration(6),
      }),
    ],
    [
      'a launch key inconsistent with the call key',
      (): Record<string, unknown> =>
        recordFixture({
          launch: {
            version: 1,
            delegationId: DELEGATION_ID,
            launchKey: 'd'.repeat(64),
            runGeneration: RUN_GENERATION,
            phase: 'reserved',
          },
        }),
    ],
    [
      'a read-metadata target that does not match the record',
      (): Record<string, unknown> => ({
        ...recordFixture(),
        readMetadata: readMetadata(6),
      }),
    ],
    [
      'a receipt window over 64 entries',
      (): Record<string, unknown> =>
        recordFixture({
          receipts: {
            commandReceipts: Array.from({ length: 65 }, () => ({})),
            stopReceipts: [],
          },
        }),
    ],
    [
      'a stop window over 64 entries',
      (): Record<string, unknown> =>
        recordFixture({
          receipts: {
            commandReceipts: [],
            stopReceipts: Array.from({ length: 65 }, () => ({})),
          },
        }),
    ],
    [
      'an active stop whose pending receipt belongs to another operation',
      (): Record<string, unknown> =>
        recordFixture({
          receipts: {
            commandReceipts: [],
            stopReceipts: [],
            activeStop: {
              operationId: OPERATION_ID,
              runGeneration: RUN_GENERATION,
              admittedAt: 150,
              pendingTerminalOutcome: {
                ...stopOutcomeEntry('failed'),
                key: OTHER_OPERATION_ID,
                operationId: OTHER_OPERATION_ID,
              },
            },
          },
        }),
    ],
    [
      'a current state containing transcript history',
      (): Record<string, unknown> => ({
        ...recordFixture(),
        state: {
          ...createDelegationRunState(DELEGATION_ID, RUN_GENERATION),
          transcript: [],
        },
      }),
    ],
    [
      'an unbounded current-state preview',
      (): Record<string, unknown> => ({
        ...recordFixture(),
        state: {
          ...createDelegationRunState(DELEGATION_ID, RUN_GENERATION),
          partialText: 'x'.repeat(4097),
        },
      }),
    ],
  ])('rejects %s', (_label, makeRecord): void => {
    expect(() => decodeStoredDelegationV3(makeRecord())).toThrow(
      DelegationReadMetadataError,
    );
  });

  it('keeps legacy projections and current stop policy separate', () => {
    const legacyStops: readonly ('accepted' | 'completed' | 'failed')[] = [
      'accepted',
      'completed',
      'failed',
    ];
    for (const status of legacyStops) {
      const stopRequested = {
        operationId: OPERATION_ID,
        key: 'legacy-key',
        runGeneration: RUN_GENERATION,
        status,
      };
      const legacy = legacyRecord(2, stopRequested);
      expect(currentStopPolicy(legacy).stopRequested).toBe(stopRequested);
      expect(legacyPrefixView(legacy).stopRequested).toBe(stopRequested);
    }
    expect(currentStopPolicy(legacyRecord(1))).toEqual({});

    const noStop = decodeStoredDelegationV3(recordFixture());
    expect(currentStopPolicy(noStop)).toEqual({});

    const accepted = decodeStoredDelegationV3(
      recordFixture({ receipts: stopState('accepted', 'accepted') }),
    );
    expect(currentStopPolicy(accepted)).toEqual({
      stopRequested: {
        operationId: OPERATION_ID,
        operation: 'stop',
        runGeneration: RUN_GENERATION,
        status: 'accepted',
      },
      stopFence: { operationId: OPERATION_ID, status: 'accepted' },
    });

    const terminalStops: readonly ('completed' | 'failed')[] = [
      'completed',
      'failed',
    ];
    for (const status of terminalStops) {
      const active = decodeStoredDelegationV3(
        recordFixture({ receipts: stopState(status, status) }),
      );
      expect(currentStopPolicy(active).stopRequested).toEqual({
        operationId: OPERATION_ID,
        operation: 'stop',
        runGeneration: RUN_GENERATION,
        status,
      });
    }

    for (const status of legacyStops) {
      const fenced = decodeStoredDelegationV3(
        recordFixture({ receipts: stopState(status) }),
      );
      expect(currentStopPolicy(fenced).stopRequested).toEqual({
        operationId: OPERATION_ID,
        operation: 'stop',
        status,
      });
      expect(currentStopPolicy(fenced).stopFence).toEqual({
        operationId: OPERATION_ID,
        status,
      });
    }
  });

  it('projects read metadata only from valid v3 records', () => {
    expect(readMetadataOfRecord(legacyRecord(1))).toBeUndefined();
    expect(readMetadataOfRecord(legacyRecord(2))).toBeUndefined();
    const valid = decodeStoredDelegationV3(recordFixture());
    expect(readMetadataOfRecord(valid)).toBe(valid.readMetadata);
    expect(() =>
      readMetadataOfRecord({
        ...recordFixture(),
        readMetadata: { broken: true },
      }),
    ).toThrow(DelegationReadMetadataError);
  });

  it('keeps the empty current preview as an empty text value', () => {
    const record = decodeStoredDelegationV3(
      recordFixture({
        state: {
          ...createDelegationRunState(DELEGATION_ID, RUN_GENERATION),
          finalText: '',
        },
      }),
    );

    expect(record.state.finalText).toBe('');
  });

  it('does not encode an empty settling answer as a lost body', () => {
    const record = recordFixture({
      settling: {
        runGeneration: RUN_GENERATION,
        settlementKey: delegationSettlementKey(
          CHAT_ID,
          DELEGATION_ID,
          RUN_GENERATION,
        ),
        assertedResultIndex: 1,
        outcome: { status: 'completed', finishedAt: 200 },
        answer: {
          role: 'final',
          sha256: 'e'.repeat(64),
          length: 0,
        },
        expectedSettlementDigest: 'f'.repeat(64),
      },
    });

    expect(() => decodeStoredDelegationV3(record)).toThrow(
      DelegationReadMetadataError,
    );
  });

  it('pins literal settlement and stop request hash vectors', () => {
    expect(
      delegationSettlementKey(CHAT_ID, DELEGATION_ID, RUN_GENERATION),
    ).toBe('effa6dfd8489675a02d4221f30d69acfeac3ed40d6eea3058a7709fe8f81c4fd');
    expect(delegationStopRequestHash(DELEGATION_ID)).toBe(
      '3b04a319b3b3c1ab574d5fe7364c48475eb6836f471f1a311eb2ccc9288d896f',
    );
  });

  it('uses the same D4 settlement identity for text and its lost UTF-16LE identity', () => {
    const target: DelegationTranscriptTarget = {
      kind: 'delegation',
      chatId: CHAT_ID,
      delegationId: DELEGATION_ID,
      runGeneration: RUN_GENERATION,
    };
    const settlementKey = delegationSettlementKey(
      CHAT_ID,
      DELEGATION_ID,
      RUN_GENERATION,
    );
    const outcome: DelegationTranscriptSettlementOutcome = {
      status: 'completed',
      finishedAt: 200,
    };

    for (const text of ['ASCII', '🌿', '\uD800']) {
      const normal: DelegationTranscriptSettleRequest = {
        target,
        settlementKey,
        resultIndex: 1,
        outcome,
        finalChanges: [],
        answer: { role: 'final', text },
        openRows: 'finalize',
      };
      const lost: DelegationTranscriptSettleRequest = {
        ...normal,
        answer: {
          role: 'final',
          lost: {
            sha256: createHash('sha256')
              .update(Buffer.from(text, 'utf16le'))
              .digest('hex'),
            length: text.length,
          },
        },
      };
      expect(delegationTranscriptSettlementDigest(normal)).toBe(
        delegationTranscriptSettlementDigest(lost),
      );
    }

    const empty: DelegationTranscriptSettleRequest = {
      target,
      settlementKey,
      resultIndex: 1,
      outcome,
      finalChanges: [],
      answer: { role: 'final', text: '' },
      openRows: 'finalize',
    };
    expect(empty.answer).toEqual({ role: 'final', text: '' });
    expect(delegationTranscriptSettlementDigest(empty)).not.toBe(
      delegationTranscriptSettlementDigest({ ...empty, answer: null }),
    );
  });

  it('pins independent combined D4 vectors and rejects role, outcome, or finalize mutations', () => {
    const target: DelegationTranscriptTarget = {
      kind: 'delegation',
      chatId: CHAT_ID,
      delegationId: DELEGATION_ID,
      runGeneration: RUN_GENERATION,
    };
    const settlementKey = delegationSettlementKey(
      CHAT_ID,
      DELEGATION_ID,
      RUN_GENERATION,
    );
    const outcome: DelegationTranscriptSettlementOutcome = {
      status: 'completed',
      finishedAt: 200,
    };
    // Shell-hashed by hand: the ASCII canonical payload is
    // {"answer":{"length":5,"role":"final","sha256":"161638584b9de08ac08753c210432cd71e38e9d81e8fbbe27d277334b86627a4"},"finalItems":[],"openRows":"finalize","outcome":{"finishedAt":200,"status":"completed"},"resultIndex":1,"target":{"chatId":"chat-1","delegationId":"00000000-0000-4000-8000-000000000003","kind":"delegation","runGeneration":7},"v":1}
    // The other literals use the same payload with their independently hashed
    // UTF-16LE answer identity and code-unit length; the domain prefix is
    // canopy.delegation.settlement.v1 followed by NUL.
    const vectors = [
      {
        text: 'ASCII',
        answerHash:
          '161638584b9de08ac08753c210432cd71e38e9d81e8fbbe27d277334b86627a4',
        length: 5,
        digest:
          '043f850b010c851beca8baa8ca5e75b9b45ef01c71ea8b8c11d70ce02ca04ef1',
      },
      {
        text: '🌿',
        answerHash:
          'c646f3c3773cde0f9890c742b6404edb56686785678b3a13edfb13889d197d12',
        length: 2,
        digest:
          '5f5938646bca515e71386b242764e3250a4fd6d3be96b6f38f2c8fd829945fad',
      },
      {
        text: '\uD800',
        answerHash:
          '205022e3428b7c8276cf247b36e4e512db5651e5cb3472c253d9ee893a8ac750',
        length: 1,
        digest:
          'd4faeb05d4f9ba67da5aaec43db67ee185784e491404fdb78e265f94615c2d43',
      },
    ];

    for (const vector of vectors) {
      const request: DelegationTranscriptSettleRequest = {
        target,
        settlementKey,
        resultIndex: 1,
        outcome,
        finalChanges: [],
        answer: { role: 'final', text: vector.text },
        openRows: 'finalize',
      };
      const repair: DelegationTranscriptSettleRequest = {
        ...request,
        answer: {
          role: 'final',
          lost: { sha256: vector.answerHash, length: vector.length },
        },
      };
      expect(delegationTranscriptSettlementDigest(request)).toBe(vector.digest);
      expect(delegationTranscriptSettlementDigest(repair)).toBe(vector.digest);
    }

    const ascii = vectors[0];
    const base: DelegationTranscriptSettleRequest = {
      target,
      settlementKey,
      resultIndex: 1,
      outcome,
      finalChanges: [],
      answer: { role: 'final', text: ascii.text },
      openRows: 'finalize',
    };
    const digest = ascii.digest;
    expect(
      delegationTranscriptSettlementDigest({
        ...base,
        answer: { role: 'partial', text: ascii.text },
      }),
    ).not.toBe(digest);
    expect(
      delegationTranscriptSettlementDigest({
        ...base,
        outcome: { status: 'failed', finishedAt: 200 },
      }),
    ).not.toBe(digest);
    expect(
      delegationTranscriptSettlementDigest({ ...base, openRows: 'reject' }),
    ).not.toBe(digest);
  });

  it.each(CONTROL_AUTHORS)(
    'roundtrips a structured $name current-control sender',
    ({ sender }) => {
      const receipt = commandReceipt();
      const control = controlFor(sender, receipt);
      const decoded = decodeStoredDelegationV3(
        recordFixture({
          control,
          receipts: { commandReceipts: [receipt], stopReceipts: [] },
        }),
      );

      expect(decoded.control?.sender).toEqual(sender);
      expect(
        decodeStoredDelegationV3(JSON.parse(encodeStoredDelegationV3(decoded)))
          .control?.sender,
      ).toEqual(sender);
    },
  );

  it('promotes a real control-bearing v2 record into an unchanged prefix', () => {
    const userReceipt = commandReceipt({
      key: '9'.repeat(64),
      operationId: '00000000-0000-4000-8000-000000000011',
    });
    const agentReceipt = commandReceipt({
      key: '8'.repeat(64),
      operationId: '00000000-0000-4000-8000-000000000012',
      operation: 'steer',
    });
    const legacy: StoredDelegationLegacy = {
      ...legacyRecord(2),
      control: controlFor({ kind: 'user' }, userReceipt),
      controls: [controlFor({ kind: 'agent', depth: 1 }, agentReceipt)],
    };
    const promoted = decodeStoredDelegationV3(
      recordFixture({
        legacyPrefix: { control: legacy.control, controls: legacy.controls },
      }),
    );

    expect(promoted.legacyPrefix?.control).toEqual(legacy.control);
    expect(promoted.legacyPrefix?.controls).toEqual(legacy.controls);
    expect(encodeStoredDelegationV3(promoted)).toContain('"kind":"agent"');
  });

  it.each([
    [
      'a literal user sender in the current control',
      (): Record<string, unknown> => ({
        ...recordFixture({
          control: { ...controlFor({ kind: 'user' }), sender: 'user' },
          receipts: {
            commandReceipts: [commandReceipt()],
            stopReceipts: [],
          },
        }),
      }),
    ],
    [
      'a malformed agent author in the current control',
      (): Record<string, unknown> => ({
        ...recordFixture({
          control: {
            ...controlFor({ kind: 'user' }),
            sender: { kind: 'agent', depth: 10 },
          },
          receipts: {
            commandReceipts: [commandReceipt()],
            stopReceipts: [],
          },
        }),
      }),
    ],
    [
      'a literal agent sender in the legacy prefix',
      (): Record<string, unknown> =>
        recordFixture({
          legacyPrefix: {
            control: {
              ...controlFor({ kind: 'agent', depth: 1 }),
              sender: 'agent',
            },
          },
        }),
    ],
    [
      'a malformed user author in a legacy-prefix control',
      (): Record<string, unknown> =>
        recordFixture({
          legacyPrefix: {
            controls: [
              {
                ...controlFor({ kind: 'user' }),
                sender: { kind: 'user', extra: true },
              },
            ],
          },
        }),
    ],
  ])('rejects %s', (_label, makeRecord): void => {
    expect(() => decodeStoredDelegationV3(makeRecord())).toThrow(
      DelegationReadMetadataError,
    );
  });

  it('accepts full valid command and stop windows and validates their reply identities', () => {
    const commandReceipts = Array.from({ length: 64 }, (_, index) =>
      commandReceipt({
        key: index.toString(16).padStart(64, '0'),
        operationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      }),
    );
    const stopReceipts = Array.from({ length: 64 }, (_, index) =>
      stopReceipt(index + 1),
    );
    const latestStopReceipt = stopReceipts.at(-1);
    const decoded = decodeStoredDelegationV3(
      recordFixture({
        receipts: {
          commandReceipts,
          stopReceipts,
          stopFence: {
            operationId: latestStopReceipt?.operationId ?? OPERATION_ID,
            status: 'completed',
          },
        },
        latestReceipt: latestReceipt(
          Array.from({ length: 64 }, (_, index) => ({
            id: `row-${index}`,
            itemRevision: index,
            final: false,
          })),
        ),
      }),
    );

    expect(decoded.receipts.commandReceipts).toHaveLength(64);
    expect(decoded.receipts.stopReceipts).toHaveLength(64);
    expect(decoded.latestReceipt?.items).toHaveLength(64);
  });

  it.each([
    [
      'a reply snapshot for another delegation',
      commandReceipt({ replyDelegationId: 'another-delegation' }),
    ],
    [
      'a reply snapshot for another generation',
      commandReceipt({ replyRunGeneration: RUN_GENERATION - 1 }),
    ],
    [
      'a reply control for another operation id',
      commandReceipt({ replyControlOperationId: OTHER_OPERATION_ID }),
    ],
    [
      'a reply control for another operation',
      commandReceipt({ replyOperation: 'steer' }),
    ],
  ])('rejects %s', (_label, receipt): void => {
    expect(() =>
      decodeStoredDelegationV3(
        recordFixture({
          receipts: { commandReceipts: [receipt], stopReceipts: [] },
        }),
      ),
    ).toThrow(DelegationReadMetadataError);
  });

  it.each([
    [
      'a current control with no window receipt',
      controlFor({ kind: 'user' }),
      [],
    ],
    [
      'a current control linked by a different key',
      { ...controlFor({ kind: 'user' }), key: 'd'.repeat(64) },
      [commandReceipt()],
    ],
    [
      'a current control linked by a different operation id',
      { ...controlFor({ kind: 'user' }), operationId: OTHER_OPERATION_ID },
      [commandReceipt()],
    ],
    [
      'a current control linked by a different operation',
      { ...controlFor({ kind: 'user' }), operation: 'steer' },
      [commandReceipt()],
    ],
  ])('rejects %s', (_label, control, commandReceipts): void => {
    expect(() =>
      decodeStoredDelegationV3(
        recordFixture({
          control,
          receipts: { commandReceipts, stopReceipts: [] },
        }),
      ),
    ).toThrow(DelegationReadMetadataError);
  });

  it('allows pending stop append states and retains a cleared slot fence', () => {
    const pending = decodeStoredDelegationV3(
      recordFixture({ receipts: stopState('completed', 'completed') }),
    );
    expect(
      pending.receipts.activeStop?.pendingTerminalOutcome?.reply.kind,
    ).toBe('stop_outcome');

    const alias = stopReceipt(1, RUN_GENERATION, 140, OPERATION_ID);
    const admittedWithAlias = decodeStoredDelegationV3(
      recordFixture({
        receipts: {
          ...stopState('accepted', 'accepted'),
          stopReceipts: [alias],
        },
      }),
    );
    expect(admittedWithAlias.receipts.stopReceipts).toEqual([alias]);

    const cleared = decodeStoredDelegationV3(
      recordFixture({
        receipts: {
          commandReceipts: [],
          stopReceipts: [alias],
          stopFence: { operationId: OPERATION_ID, status: 'completed' },
        },
      }),
    );
    expect(cleared.receipts.activeStop).toBeUndefined();
    expect(cleared.receipts.stopFence).toEqual({
      operationId: OPERATION_ID,
      status: 'completed',
    });

    const explicitlyResumed = decodeStoredDelegationV3(
      recordFixture({
        receipts: {
          commandReceipts: [
            commandReceipt({ operation: 'resume', admittedAt: 160 }),
          ],
          stopReceipts: [alias],
        },
      }),
    );
    expect(explicitlyResumed.receipts.stopFence).toBeUndefined();

    const resumedThenFailed = recordFixture({
      receipts: {
        commandReceipts: [
          commandReceipt({
            operation: 'resume',
            admittedAt: 141,
            final: 'failed',
          }),
        ],
        stopReceipts: [alias],
      },
    });
    const reopened = decodeStoredDelegationV3(
      JSON.parse(
        encodeStoredDelegationV3(decodeStoredDelegationV3(resumedThenFailed)),
      ),
    );
    expect(reopened.receipts.stopFence).toBeUndefined();
    expect(currentStopPolicy(reopened)).toEqual({});
  });

  it('orders newly admitted operations after every retained receipt', () => {
    const receipts = {
      commandReceipts: [commandReceipt({ admittedAt: 150 })],
      stopReceipts: [stopReceipt(1, RUN_GENERATION, 160)],
    };
    expect(nextV3ReceiptAdmissionTime(receipts, 160)).toBe(161);
    expect(nextV3ReceiptAdmissionTime(receipts, 100)).toBe(161);
    expect(nextV3ReceiptAdmissionTime(receipts, 200)).toBe(200);
    expect(
      nextV3ReceiptAdmissionTime({ commandReceipts: [], stopReceipts: [] }, 0),
    ).toBe(0);
  });

  it.each([
    [
      'duplicate command keys within their namespace',
      {
        commandReceipts: [commandReceipt(), commandReceipt()],
        stopReceipts: [],
      },
    ],
    [
      'duplicate stop keys within their namespace',
      {
        commandReceipts: [],
        stopReceipts: [stopReceipt(1), stopReceipt(1)],
      },
    ],
    [
      'an active slot without a fence',
      {
        commandReceipts: [],
        stopReceipts: [],
        activeStop: {
          operationId: OPERATION_ID,
          runGeneration: RUN_GENERATION,
          admittedAt: 150,
        },
      },
    ],
    [
      'an active slot and a fence for different operations',
      {
        commandReceipts: [],
        stopReceipts: [],
        activeStop: {
          operationId: OPERATION_ID,
          runGeneration: RUN_GENERATION,
          admittedAt: 150,
        },
        stopFence: { operationId: OTHER_OPERATION_ID, status: 'accepted' },
      },
    ],
    [
      'a pending terminal fence that contradicts its stored outcome',
      stopState('completed', 'failed'),
    ],
    [
      'a fence cleared without a later explicit resume',
      {
        commandReceipts: [],
        stopReceipts: [stopReceipt(1)],
      },
    ],
    [
      'a fence cleared by a refused resume',
      {
        commandReceipts: [
          commandReceipt({
            operation: 'resume',
            admittedAt: 160,
            refused: true,
          }),
        ],
        stopReceipts: [stopReceipt(1)],
      },
    ],
    [
      'a fence cleared by a resume admitted at the same time as the stop',
      {
        commandReceipts: [
          commandReceipt({ operation: 'resume', admittedAt: 140 }),
        ],
        stopReceipts: [stopReceipt(1)],
      },
    ],
    [
      'an active operation aliased by another generation',
      {
        commandReceipts: [],
        stopReceipts: [stopReceipt(1, RUN_GENERATION - 1, 140, OPERATION_ID)],
        activeStop: {
          operationId: OPERATION_ID,
          runGeneration: RUN_GENERATION,
          admittedAt: 150,
        },
        stopFence: { operationId: OPERATION_ID, status: 'accepted' },
      },
    ],
    [
      'an active stop from a future generation',
      {
        commandReceipts: [],
        stopReceipts: [],
        activeStop: {
          operationId: OPERATION_ID,
          runGeneration: RUN_GENERATION + 1,
          admittedAt: 150,
        },
        stopFence: { operationId: OPERATION_ID, status: 'accepted' },
      },
    ],
    [
      'a stop alias whose operation is not stop',
      {
        commandReceipts: [],
        stopReceipts: [{ ...stopReceipt(1), operation: 'follow_up' }],
      },
    ],
    [
      'a future-generation receipt',
      {
        commandReceipts: [
          commandReceipt({ runGeneration: RUN_GENERATION + 1 }),
        ],
        stopReceipts: [],
      },
    ],
  ])('rejects %s', (_label, receipts): void => {
    expect(() => decodeStoredDelegationV3(recordFixture({ receipts }))).toThrow(
      DelegationReadMetadataError,
    );
  });

  it.each(VALID_SETTLING_ANSWERS)(
    'accepts a valid settling intent: %o',
    (answer): void => {
      const record = decodeStoredDelegationV3(
        recordFixture({ settling: settlingIntent(answer) }),
      );
      expect(record.settling?.answer).toEqual(answer);
    },
  );

  it.each([
    [
      'a digest that does not match the intent',
      { ...settlingIntent('none'), expectedSettlementDigest: 'f'.repeat(64) },
    ],
    [
      'an unknown field in the intent',
      { ...settlingIntent('none'), extra: true },
    ],
  ])('rejects %s', (_label, settling): void => {
    expect(() => decodeStoredDelegationV3(recordFixture({ settling }))).toThrow(
      DelegationReadMetadataError,
    );
  });

  it('accepts a retained route with nonempty capabilities', () => {
    const decoded = decodeStoredDelegationV3(
      recordFixture({ route: route({ capabilities: ['read', 'progress'] }) }),
    );
    expect(decoded.route?.capabilities).toEqual(['read', 'progress']);
  });

  it('accepts a valid latest locator and the next pending result index', () => {
    const decoded = decodeStoredDelegationV3(
      recordFixture({
        latestResult: resultLocator(3, RUN_GENERATION - 1),
        settling: settlingIntent('none', 4),
      }),
    );
    expect(decoded.latestResult?.resultIndex).toBe(3);
    expect(decoded.settling?.assertedResultIndex).toBe(4);

    const notified = decodeStoredDelegationV3(
      recordFixture({
        latestResult: {
          ...resultLocator(3, RUN_GENERATION - 1),
          notified: true,
        },
      }),
    );
    expect(notified.latestResult?.notified).toBe(true);
  });

  it('accepts valid mixed-prefix history, ordered results, and stream progress unchanged', () => {
    const prefix = {
      history: [historyEntry(3), historyEntry(5)],
      results: [
        {
          resultIndex: 1,
          runGeneration: 2,
          status: 'completed',
          settledAt: 120,
          outputTruncated: false,
        },
        {
          resultIndex: 2,
          runGeneration: 4,
          status: 'completed',
          settledAt: 140,
          finalText: 'legacy answer',
          outputTruncated: false,
        },
      ],
      stopRequests: [
        {
          operationId: OPERATION_ID,
          runGeneration: 5,
          status: 'completed',
        },
      ],
    };
    const record = decodeStoredDelegationV3(
      recordFixture({
        legacyPrefix: prefix,
        latestResult: resultLocator(3, 6),
        settling: settlingIntent('none', 4),
      }),
    );
    const encoded = encodeStoredDelegationV3(record);
    const decoded = decodeStoredDelegationV3(JSON.parse(encoded));

    expect(decoded.legacyPrefix).toEqual(prefix);
    expect(decoded.latestResult?.resultIndex).toBe(3);
    expect(decoded.settling?.assertedResultIndex).toBe(4);
  });

  it.each([
    [
      'a prefix whose results start at a nonconsecutive index',
      {
        results: [
          {
            resultIndex: 2,
            runGeneration: 2,
            status: 'completed',
            settledAt: 120,
            outputTruncated: false,
          },
        ],
      },
    ],
    [
      'prefix results with non-increasing generations',
      {
        results: [
          {
            resultIndex: 1,
            runGeneration: 4,
            status: 'completed',
            settledAt: 120,
            outputTruncated: false,
          },
          {
            resultIndex: 2,
            runGeneration: 3,
            status: 'completed',
            settledAt: 130,
            outputTruncated: false,
          },
        ],
      },
    ],
    [
      'a foreign historical transcript',
      { history: [{ ...historyEntry(3), delegationId: 'foreign' }] },
    ],
    [
      'a current-generation historical transcript',
      { history: [historyEntry(RUN_GENERATION)] },
    ],
    [
      'a user-message receipt for another delegation',
      {
        userMessageReceipts: [
          {
            operationId: OPERATION_ID,
            key: 'a'.repeat(64),
            requestHash: 'b'.repeat(64),
            delegationId: 'foreign',
            operation: 'follow_up',
            error: {
              code: 'runtime_error',
              message: 'failed',
              retryable: false,
            },
          },
        ],
      },
    ],
    [
      'a future legacy stop request',
      {
        stopRequests: [
          {
            operationId: OPERATION_ID,
            runGeneration: RUN_GENERATION,
            status: 'accepted',
          },
        ],
      },
    ],
  ])('rejects %s', (_label, legacyPrefix): void => {
    expect(() =>
      decodeStoredDelegationV3(recordFixture({ legacyPrefix })),
    ).toThrow(DelegationReadMetadataError);
  });

  it.each([
    [
      'a latest locator on the frozen result index floor',
      {
        legacyPrefix: {
          results: [
            {
              resultIndex: 1,
              runGeneration: 2,
              status: 'completed',
              settledAt: 120,
              outputTruncated: false,
            },
          ],
        },
        latestResult: resultLocator(1, 6),
      },
    ],
    [
      'a stream registration that overlaps frozen history',
      { legacyPrefix: { history: [historyEntry(RUN_GENERATION)] } },
    ],
    [
      'a future-generation latest locator',
      { latestResult: resultLocator(1, RUN_GENERATION + 1) },
    ],
    [
      'a latest locator with a non-true notification marker',
      { latestResult: { ...resultLocator(1, 6), notified: false } },
    ],
    [
      'a latest locator that overlaps a frozen stop generation',
      {
        legacyPrefix: {
          stopRequests: [
            {
              operationId: OPERATION_ID,
              runGeneration: 6,
              status: 'completed',
            },
          ],
        },
        latestResult: resultLocator(1, 6),
      },
    ],
    [
      'a registration that overlaps a frozen control generation',
      {
        legacyPrefix: {
          controls: [
            {
              ...controlFor({ kind: 'agent', depth: 1 }),
              firstOutcome: {
                delegationId: DELEGATION_ID,
                runGeneration: RUN_GENERATION,
                status: 'running',
                outputTruncated: false,
              },
            },
          ],
        },
      },
    ],
    [
      'an intent that reuses the frozen result index',
      {
        legacyPrefix: {
          results: [
            {
              resultIndex: 1,
              runGeneration: 2,
              status: 'completed',
              settledAt: 120,
              outputTruncated: false,
            },
          ],
        },
        settling: settlingIntent('none', 1),
      },
    ],
    [
      'an intent whose index does not follow the latest locator',
      {
        latestResult: resultLocator(2, 6),
        settling: settlingIntent('none', 2),
      },
    ],
    [
      'an intent for a generation already settled by its locator',
      {
        latestResult: resultLocator(3, RUN_GENERATION),
        settling: settlingIntent('none', 4),
      },
    ],
  ])('rejects %s', (_label, overrides): void => {
    expect(() => decodeStoredDelegationV3(recordFixture(overrides))).toThrow(
      DelegationReadMetadataError,
    );
  });

  it('bounds latest receipt count, encoded bytes, and item identity without truncating', () => {
    const uniqueItems = Array.from({ length: 64 }, (_, index) => ({
      id: `row-${index}`,
      itemRevision: index,
      final: false,
    }));
    const valid = decodeStoredDelegationV3(
      recordFixture({ latestReceipt: latestReceipt(uniqueItems) }),
    );
    expect(valid.latestReceipt?.items).toHaveLength(64);

    const duplicateItems = [
      { id: 'duplicate', itemRevision: 0, final: false },
      { id: 'duplicate', itemRevision: 1, final: false },
    ];
    const oversizedItems = Array.from({ length: 64 }, (_, index) => ({
      id: `${String(index).padStart(2, '0')}${'x'.repeat(254)}`,
      itemRevision: index,
      final: false,
    }));
    const overCountItems = Array.from({ length: 65 }, (_, index) => ({
      id: `row-${index}`,
      itemRevision: index,
      final: false,
    }));
    for (const receipt of [
      latestReceipt(duplicateItems),
      latestReceipt(oversizedItems),
      latestReceipt(overCountItems),
    ]) {
      expect(() =>
        decodeStoredDelegationV3(recordFixture({ latestReceipt: receipt })),
      ).toThrow(DelegationReadMetadataError);
    }
    expect(duplicateItems).toHaveLength(2);
    expect(oversizedItems).toHaveLength(64);
    expect(overCountItems).toHaveLength(65);
    expect(MAX_V3_LATEST_RECEIPT_ITEMS).toBe(64);
    expect(MAX_V3_LATEST_RECEIPT_BYTES).toBe(16 * 1024);
  });

  it('uses typed metadata and policy projections without decoding again', () => {
    const v3 = decodeStoredDelegationV3(recordFixture());
    const legacy = legacyRecord(2);

    expect(readMetadataOfValidatedRecord(v3)).toBe(v3.readMetadata);
    expect(readMetadataOfValidatedRecord(legacy)).toBeUndefined();
    expect(legacyPrefixView(v3)).toEqual({});
    expect(currentStopPolicy(v3)).toEqual({});
  });
});
