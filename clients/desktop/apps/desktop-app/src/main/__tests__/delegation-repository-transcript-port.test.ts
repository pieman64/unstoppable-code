import { createHash } from 'node:crypto';
import {
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import type {
  DelegationTranscriptPort,
  DelegationTranscriptPortResult,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { describeDelegationTranscriptPortConformance } from '@canopy/desktop-shared/node/delegation/testing/transcript-port-conformance';
import {
  createCommandOutputSpools,
  type CommandSpoolOperation,
  type DelegationCommandSpools,
} from '../agents/delegation/command-output-spools';
import { RepositoryDelegationTranscriptPort } from '../agents/delegation/repository-transcript-port';
import { FieldSpool } from '../lib/chat-transcript-field-spool';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';
import {
  fakeHandle,
  preparation,
  request as codexRequest,
  run as runCodex,
  type TurnRequest,
} from './helpers/delegation-runner-fixtures/codex';
import { ChatStateService } from '../services/chat-state-service';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { DelegationRegistryOperationError } from '../lib/chat-delta-journal/delegation-registry-error';
import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';

jest.setTimeout(240_000);

function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function row(id = 'retained', itemRevision = 0): DelegationChildRow {
  return {
    id,
    role: 'assistant',
    timestamp: 2,
    parentBlockId: 'agent',
    delegationSequence: id === 'retained' ? 0 : 1,
    delegationSegment: 'native-1',
    itemRevision,
    final: false,
    blocks: [{ type: 'text', text: `revision ${itemRevision}` }],
  };
}

interface DeferredGate {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function deferredGate(): DeferredGate {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface SpoolLifecycle {
  readonly operations: Array<{
    readonly operation: CommandSpoolOperation;
    readonly key: string;
  }>;
  ownersCreated: number;
  ownersClosed: number;
}

type SpoolFault = (
  operation: CommandSpoolOperation,
  key: string,
) => Promise<void>;

function createSpoolFactory(
  root: string,
  lifecycle: SpoolLifecycle,
  fault?: SpoolFault,
): () => DelegationCommandSpools {
  return (): DelegationCommandSpools => {
    lifecycle.ownersCreated += 1;
    const owner = createCommandOutputSpools({
      root: () => root,
      faults: {
        before: async (
          operation: CommandSpoolOperation,
          key: string,
        ): Promise<void> => {
          lifecycle.operations.push({ operation, key });
          await fault?.(operation, key);
        },
      },
    });
    return {
      acquire: (key: string) => owner.acquire(key),
      close: async (): Promise<void> => {
        lifecycle.ownersClosed += 1;
        await owner.close();
      },
    };
  };
}

function streamRequest(target: DelegationTranscriptTarget): AgentRunRequest {
  return {
    ...codexRequest,
    transcriptStream: { target },
  };
}

function commandEvent(
  method: string,
  turnId: string,
  item?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): { method: string; params: Record<string, unknown> } {
  return {
    method,
    params: {
      threadId: 'thread-c28',
      turnId,
      ...(item === undefined ? {} : { item }),
      ...extra,
    },
  };
}

async function sendEvent(
  turn: TurnRequest,
  event: { method: string; params: Record<string, unknown> },
): Promise<void> {
  await turn.onEvent?.(event);
}

async function startCommand(turn: TurnRequest, turnId: string): Promise<void> {
  await sendEvent(turn, {
    method: 'turn/started',
    params: { threadId: 'thread-c28', turn: { id: turnId } },
  });
  await sendEvent(
    turn,
    commandEvent('item/started', turnId, {
      type: 'commandExecution',
      id: 'command-c28',
      command: 'run C28 repository test',
      status: 'inProgress',
    }),
  );
}

async function appendCommandOutput(
  turn: TurnRequest,
  turnId: string,
  delta: string,
): Promise<void> {
  await sendEvent(
    turn,
    commandEvent('item/commandExecution/outputDelta', turnId, undefined, {
      itemId: 'command-c28',
      delta,
    }),
  );
}

async function finishCommand(turn: TurnRequest, turnId: string): Promise<void> {
  await sendEvent(
    turn,
    commandEvent('item/completed', turnId, {
      type: 'commandExecution',
      id: 'command-c28',
      command: 'run C28 repository test',
      status: 'completed',
      aggregatedOutput: null,
    }),
  );
}

async function readAllContent(
  port: DelegationTranscriptPort,
  target: DelegationTranscriptTarget,
  streamRevision: number,
  messageId: string,
  blockOrdinal: number,
  field: Parameters<DelegationTranscriptPort['contentRange']>[0]['field'],
): Promise<string> {
  let offset = 0;
  let content = '';
  while (true) {
    const chunk = value(
      await port.contentRange({
        target,
        streamRevision,
        messageId,
        blockOrdinal,
        field,
        offset,
        limit: 65_536,
      }),
    );
    content += chunk.text;
    if (chunk.nextOffset === undefined) return content;
    if (chunk.nextOffset <= offset)
      throw new Error('Transcript range did not advance');
    offset = chunk.nextOffset;
  }
}

async function expectSpoolsDisposed(
  spoolRoot: string,
  lifecycle: SpoolLifecycle,
  closedFieldHandleCount: number,
): Promise<void> {
  const createdKeys = lifecycle.operations
    .filter(({ operation }) => operation === 'create')
    .map(({ key }) => key);
  const closedKeys = lifecycle.operations
    .filter(({ operation }) => operation === 'close')
    .map(({ key }) => key);
  expect(lifecycle.ownersCreated).toBe(1);
  expect(lifecycle.ownersClosed).toBe(1);
  expect(closedKeys).toEqual(createdKeys);
  expect(closedFieldHandleCount).toBe(createdKeys.length);
  expect(
    lifecycle.operations.filter(
      ({ operation, key }) => operation === 'remove' && key === '',
    ),
  ).toHaveLength(createdKeys.length > 0 ? 1 : 0);
  expect(await readdir(spoolRoot)).toEqual([]);
}

describe('repository delegation transcript port', () => {
  const roots: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  async function root(): Promise<string> {
    const directory = await mkdtemp(
      join(tmpdir(), 'repository-transcript-port-'),
    );
    roots.push(directory);
    return directory;
  }

  async function tempSpoolRoot(): Promise<string> {
    const directory = await mkdtemp(
      join(tmpdir(), 'delegation-repository-spools-'),
    );
    roots.push(directory);
    return directory;
  }

  async function fixture(): Promise<RepositoryTranscriptPortFixture> {
    const result = await createRepositoryTranscriptPortFixture(await root())();
    cleanups.push(() => result.close());
    return result;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const directory of roots.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  describeDelegationTranscriptPortConformance(
    'repository',
    Object.assign(fixture, {
      capabilities: {
        reopen: true,
        storageFailure: true,
        checkpoint: true,
        freshInstance: true,
        noJournal: true,
        faults: true,
      },
    }),
    { registry: true, durability: 'repository' },
  );

  it('preserves structured registry failures including diagnostic floors without message matching', async () => {
    const f = await fixture();
    const failure = {
      code: 'conflict',
      message: 'opaque engine rejection',
      retryable: false,
      storedItemRevision: 4,
      storedLastResultIndex: 17,
    } satisfies ConstructorParameters<
      typeof DelegationRegistryOperationError
    >[0];
    jest
      .spyOn(f.service, 'result')
      .mockRejectedValueOnce(new DelegationRegistryOperationError(failure));
    expect(
      await f.port.result({
        chatId: 'chat',
        delegationId: 'child',
        resultIndex: 1,
      }),
    ).toEqual({ ok: false, error: failure });
  });

  it.each(['registry-answer-published', 'registry-settle-admitted'] as const)(
    'recovers canonical settlement at %s through every repository durability view',
    async (boundary) => {
      const f = await fixture();
      const target = f.ownedTarget('chat', 'registry-crash', 1);
      value(await f.port.open({ target }));
      const request = {
        target,
        settlementKey: 'crash-stable-key',
        resultIndex: 7,
        outcome: { status: 'completed', finishedAt: 456 },
        finalChanges: [{ row: { ...row('final-crash-row'), final: true } }],
        answer: { role: 'final', text: 'Exact registry answer after crash.' },
      } satisfies Parameters<DelegationTranscriptPort['settle']>[0];
      f.injectRegistryFailure(boundary);
      expect(await f.port.settle(request)).toMatchObject({
        ok: false,
        error: { code: 'storage_failure' },
      });
      await f.reopen();
      if (boundary === 'registry-answer-published') {
        expect(
          await f.port.result({ ...target, resultIndex: 7 }),
        ).toMatchObject({ ok: false, error: { code: 'not_found' } });
        expect(value(await f.port.open({ target }))).toMatchObject({
          status: 'open',
          streamRevision: 0,
        });
      } else {
        expect(
          value(await f.port.result({ ...target, resultIndex: 7 })),
        ).toMatchObject({ resultIndex: 7 });
      }
      const settled = value(await f.port.settle(request));
      expect(settled.result.resultIndex).toBe(7);
      expect(settled.settlement.replayed).toBe(
        boundary === 'registry-settle-admitted',
      );
      const verify = async (port: DelegationTranscriptPort): Promise<void> => {
        expect(value(await port.settle(request))).toEqual({
          ...settled,
          settlement: { ...settled.settlement, replayed: true },
        });
        expect(value(await port.result({ ...target, resultIndex: 7 }))).toEqual(
          settled.result,
        );
        expect(
          value(await port.resultsPage({ ...target, limit: 100 })).results,
        ).toEqual([settled.result]);
        expect(
          value(
            await port.resultAnswerRange({
              ...target,
              resultIndex: 7,
              offset: 0,
              limit: 65_536,
            }),
          ).text,
        ).toBe(request.answer.text);
      };
      await verify(f.port);
      await f.checkpoint();
      await verify(f.port);
      await f.reopen();
      await verify(f.port);
      await verify(await f.freshInstance());
      await verify(await f.noJournal());
    },
  );

  it('holds delegation then target exclusion across two ports without re-entering the target lock', async () => {
    const f = await fixture();
    const first = f.ownedTarget('chat', 'shared-lock', 1);
    const second = f.ownedTarget('chat', 'shared-lock', 2);
    const other = new RepositoryDelegationTranscriptPort(f.service, f.scope);
    const entered = deferredGate();
    const release = deferredGate();
    const order: string[] = [];
    const settle = jest
      .spyOn(ChatStateV2Backend.prototype, 'settleDelegationResult')
      .mockImplementation(() => {
        order.push('settle');
        return Promise.reject(
          new DelegationRegistryOperationError({
            code: 'conflict',
            message: 'controlled rejection',
            retryable: false,
          }),
        );
      });
    const register = jest
      .spyOn(ChatStateV2Backend.prototype, 'registerGeneration')
      .mockImplementation((input) => {
        order.push('register');
        return Promise.resolve({
          entry: { ...input, version: 1, kind: 'generation' },
          replayed: false,
        });
      });
    const held = f.service.withChildStreamTarget(f.scope, first, async () => {
      entered.release();
      await release.promise;
    });
    await entered.promise;
    const settling = f.port.settle({
      target: first,
      settlementKey: 'locked',
      resultIndex: 1,
      outcome: { status: 'completed', finishedAt: 456 },
      finalChanges: [],
      answer: null,
    });
    const registering = other.registerGeneration({
      ...second,
      createdAt: 100,
      store: 'stream',
      origin: { kind: 'follow_up' },
      executionMode: 'background',
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settle).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    release.release();
    await held;
    expect(await settling).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(value(await registering)).toMatchObject({ runGeneration: 2 });
    expect(order).toEqual(['settle', 'register']);
  }, 15_000);

  it('keeps checkpoint-only registry reads free of implicit journal promotion', async () => {
    const f = await fixture();
    const readOnly = await f.noJournal();
    expect(await f.store.journalFile()).toBeUndefined();
    await readOnly.result({
      chatId: 'chat',
      delegationId: 'no-journal-read',
      resultIndex: 1,
    });
    expect(await f.store.journalFile()).toBeUndefined();
  });

  it('hashes a checkpoint-only answer once across its pages', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'paged-answer', 1);
    value(await f.port.open({ target }));
    const text = 'a'.repeat(4 * 65_536);
    value(
      await f.port.settle({
        target,
        settlementKey: 'paged-answer',
        resultIndex: 1,
        outcome: { status: 'completed', finishedAt: 2 },
        finalChanges: [],
        answer: { role: 'final', text },
      }),
    );
    const readOnly = await f.noJournal();
    const probe = await open(__filename, 'r');
    const hashed = jest.spyOn(Object.getPrototypeOf(probe), 'createReadStream');
    await probe.close();
    try {
      let read = '';
      for (let offset = 0; offset < text.length; offset += 65_536)
        read += value(
          await readOnly.resultAnswerRange({
            ...target,
            resultIndex: 1,
            offset,
            limit: 65_536,
          }),
        ).text;
      expect(read).toBe(text);
      expect(hashed).toHaveBeenCalledTimes(1);
    } finally {
      hashed.mockRestore();
    }
  });

  it('keeps checkpoint-only settlement and admission replays read-only before a genuine new write', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'no-journal-replay', 1);
    value(await f.port.open({ target }));
    const finalRow = { ...row('checkpointed-final'), final: true };
    const original = value(
      await f.port.appendChanges({
        target,
        mutationKey: 'original-key',
        changes: [{ row: finalRow }],
      }),
    );
    const request = {
      target,
      settlementKey: 'no-journal-settle',
      resultIndex: 1,
      outcome: { status: 'completed', finishedAt: 456 },
      finalChanges: [],
      answer: null,
    } satisfies Parameters<DelegationTranscriptPort['settle']>[0];
    const settled = value(await f.port.settle(request));
    const readOnly = await f.noJournal();
    expect(await f.store.journalFile()).toBeUndefined();
    expect(value(await readOnly.open({ target })).status).toBe('settled');
    expect(value(await readOnly.settle(request))).toEqual({
      ...settled,
      settlement: { ...settled.settlement, replayed: true },
    });
    expect(
      value(
        await readOnly.appendChanges({
          target,
          mutationKey: 'retry',
          changes: [{ row: finalRow }],
        }),
      ),
    ).toEqual({ ...original, replayed: true });
    expect(await f.store.journalFile()).toBeUndefined();
    const next = { ...target, runGeneration: 2 };
    value(await readOnly.open({ target: next }));
    expect(await f.store.journalFile()).toBeDefined();
    expect(
      value(
        await readOnly.appendChanges({
          target: next,
          mutationKey: 'new-write',
          changes: [{ row: { ...row('new-generation'), final: true } }],
        }),
      ).replayed,
    ).toBe(false);
  });

  it('admits canonical settlement before checkpoint and fresh-instance replay', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'causal-registry', 1);
    value(await f.port.open({ target }));
    const request = {
      target,
      settlementKey: 'causal-settlement',
      resultIndex: 1,
      outcome: { status: 'completed', finishedAt: 456 },
      finalChanges: [],
      answer: null,
    } satisfies Parameters<DelegationTranscriptPort['settle']>[0];
    const settled = value(await f.port.settle(request));
    if (f.checkpoint === undefined || f.freshInstance === undefined)
      throw new Error('Checkpoint and fresh instance are mandatory');
    await f.checkpoint();
    const fresh = await f.freshInstance();
    expect(value(await fresh.settle(request))).toEqual({
      ...settled,
      settlement: { ...settled.settlement, replayed: true },
    });
  });

  it.each([
    'outputTruncated',
    'fullOutputRef',
    'textRef',
    'inputRef',
    'partialTextRef',
    'finalTextRef',
    'blocksRef',
  ])(
    'rejects storage-only %s before admission, including explicit false',
    async (field) => {
      const f = await fixture();
      const target = f.ownedTarget('chat', 'delegate', 1);
      value(await f.port.open({ target }));
      const logical: DelegationChildRow = {
        ...row(),
        blocks: [
          {
            type: 'tool_result',
            toolName: 'shell',
            toolUseId: 'call',
            output: 'complete',
            isError: false,
          },
        ],
      };
      Reflect.set(
        field === 'blocksRef' ? logical : logical.blocks[0],
        field,
        field === 'outputTruncated' ? false : {},
      );
      const commit = jest.spyOn(f.service, 'commitChildStream');
      expect(
        await f.port.appendChanges({
          target,
          mutationKey: 'storage-only',
          changes: [{ row: logical }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      expect(commit).not.toHaveBeenCalled();
      expect(value(await f.port.open({ target })).streamRevision).toBe(0);
    },
  );

  it('rejects own non-enumerable storage markers atomically with valid rows', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'delegate', 1);
    value(await f.port.open({ target }));
    const invalid = row('invalid');
    Object.defineProperty(invalid.blocks[0], 'outputTruncated', {
      value: undefined,
    });
    const commit = jest.spyOn(f.service, 'commitChildStream');
    expect(
      await f.port.appendChanges({
        target,
        mutationKey: 'atomic-invalid',
        changes: [{ row: row() }, { row: invalid }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(commit).not.toHaveBeenCalled();
    expect(
      value(await f.port.page({ target, streamRevision: 0 })).rows,
    ).toEqual([]);
  });

  it('does not hold the scope lease across target-serialized caller callbacks', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'delegate', 1);
    value(await f.port.open({ target }));
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        f.service.withChildStreamTarget(f.scope, target, () =>
          f.service.getChildStreamState(f.scope, target),
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('scope lease deadlock')),
            10_000,
          );
        }),
      ]);
      expect(result?.status).toBe('open');
    } finally {
      clearTimeout(timeout);
    }
  });

  it('classifies two port instances against the stored item under the same target serialization', async () => {
    const f = await fixture();
    const other = new RepositoryDelegationTranscriptPort(f.service, f.scope);
    const target = f.ownedTarget('chat', 'delegate', 1);
    value(await f.port.open({ target }));
    const results = await Promise.all([
      f.port.appendChanges({
        target,
        mutationKey: 'race-a',
        changes: [{ row: row() }],
      }),
      other.appendChanges({
        target,
        mutationKey: 'race-b',
        changes: [
          { row: { ...row(), blocks: [{ type: 'text', text: 'other body' }] } },
        ],
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
  });

  it('serializes concurrent opens while pending and after checkpoint without duplicate registration', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'delegate', 1);
    const register = jest.spyOn(
      ChatStateV2Backend.prototype,
      'registerTranscriptStream',
    );
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    const first = await Promise.all(
      Array.from({ length: 12 }, () => f.port.open({ target })),
    );
    expect(first.map(value)).toEqual(
      Array.from({ length: 12 }, () => value(first[0])),
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(checkpoint).not.toHaveBeenCalled();
    await f.repository.flushScope(f.scope);
    const second = await Promise.all(
      Array.from({ length: 12 }, () => f.port.open({ target })),
    );
    expect(second.map(value)).toEqual(first.map(value));
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('projects the journal stream revision without checkpointing on append', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'delegate', 1);
    const opened = value(await f.port.open({ target }));
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    const descriptor = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'childDescriptor',
    );
    const admitted = value(
      await f.port.appendChanges({
        target,
        mutationKey: 'one',
        changes: [{ row: row() }],
      }),
    );
    expect(admitted.streamRevision).toBeGreaterThan(opened.streamRevision);
    expect(value(await f.port.open({ target })).streamRevision).toBe(
      admitted.streamRevision,
    );
    expect(descriptor).toHaveBeenCalledWith(target);
    expect(checkpoint).not.toHaveBeenCalled();
    await f.repository.flushScope(f.scope);
    expect(value(await f.port.open({ target })).streamRevision).toBe(
      admitted.streamRevision,
    );
  });

  it('reads the stored descriptor when no journal is open', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'delegate', 1);
    value(await f.port.open({ target }));
    const receipt = value(
      await f.port.appendChanges({
        target,
        mutationKey: 'checkpointed',
        changes: [{ row: row() }],
      }),
    );
    await f.close();
    const checkpoint = new ChatStateV2Backend(f.store, {
      deltaJournal: {},
      enableFormat4: true,
    });
    await checkpoint.demoteFromDeltaJournal();
    checkpoint.releaseJournal();
    const projected = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'childDescriptor',
    );
    const reader = new ChatStateV2Backend(f.store, { enableFormat4: true });
    expect(await reader.childStreamDescriptor(target)).toMatchObject({
      target,
      status: 'open',
      streamRevision: receipt.streamRevision,
    });
    expect(projected).not.toHaveBeenCalled();
  });

  it('replays an unchanged retained item beyond the 4,096 mutation window and reopen', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'delegate', 1);
    value(await f.port.open({ target }));
    const retained = {
      target,
      mutationKey: 'retained',
      changes: [{ row: row() }],
    };
    const original = value(await f.port.appendChanges(retained));
    let lastRevision = 0;
    for (let revision = 0; revision < 4097; revision++) {
      lastRevision = value(
        await f.port.appendChanges({
          target,
          mutationKey: `moving-${revision}`,
          changes: [{ row: row('moving', revision) }],
        }),
      ).streamRevision;
    }
    // The replay is past the 4,096-id window yet returns the original
    // admission receipt, not the stream's current revision (P8).
    expect(lastRevision).toBeGreaterThan(4096);
    const replay = value(await f.port.appendChanges(retained));
    expect(replay).toEqual({ ...original, replayed: true });
    await f.reopen();
    expect(value(await f.port.appendChanges(retained))).toEqual({
      ...original,
      replayed: true,
    });
  });

  it('recognizes a retry after a lost post-sync acknowledgement as a replay', async () => {
    const f = await fixture();
    const target = f.ownedTarget('chat', 'delegate', 1);
    value(await f.port.open({ target }));
    const input = {
      target,
      mutationKey: 'lost-ack',
      changes: [{ row: row() }],
    };
    f.injectStorageFailure('after-write');
    expect(await f.port.appendChanges(input)).toMatchObject({
      ok: false,
      error: { code: 'storage_failure' },
    });
    expect(value(await f.port.appendChanges(input)).replayed).toBe(true);
  });

  it('orders slow local-queue receipts and reopens the exact spooled final output', async () => {
    const f = await fixture();
    const spoolRoot = await tempSpoolRoot();
    const lifecycle: SpoolLifecycle = {
      operations: [],
      ownersCreated: 0,
      ownersClosed: 0,
    };
    const fieldClose = jest.spyOn(FieldSpool.prototype, 'close');
    const target = f.ownedTarget('chat', 'delegation-1', 1);
    const fullOutput =
      'PREFIX-C28:' +
      'x'.repeat(45_000) +
      'MIDDLE-C28:' +
      'y'.repeat(45_000) +
      ':END-C28';
    const admissionEntered = deferredGate();
    const releaseAdmission = deferredGate();
    const admissions: Parameters<
      DelegationTranscriptPort['appendChanges']
    >[0][] = [];
    const append = f.port.appendChanges.bind(f.port);
    jest
      .spyOn(f.port, 'appendChanges')
      .mockImplementation(async (input, signal) => {
        admissions.push(input);
        if (admissions.length === 1) {
          admissionEntered.release();
          await releaseAdmission.promise;
        }
        return append(input, signal);
      });
    const handle = fakeHandle('thread-c28', async (turn) => {
      await startCommand(turn, 'turn-c28-success');
      await appendCommandOutput(turn, 'turn-c28-success', fullOutput);
      await finishCommand(turn, 'turn-c28-success');
      return { status: 'completed', text: 'stored' };
    });
    const harness = runCodex({
      prepare: () => Promise.resolve(preparation()),
      handles: [handle],
      runRequest: streamRequest(target),
      transcriptPort: f.port,
      spools: createSpoolFactory(spoolRoot, lifecycle),
    });

    await admissionEntered.promise;
    expect(
      harness.events.some((event) => event.type === 'transcript_receipt'),
    ).toBe(false);
    expect(harness.events.some((event) => event.type === 'terminal')).toBe(
      false,
    );
    releaseAdmission.release();
    await expect(harness.terminal).resolves.toMatchObject({
      type: 'terminal',
      status: 'completed',
      finalText: 'stored',
    });

    const receipts = harness.events.filter(
      (event) => event.type === 'transcript_receipt',
    );
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts.map((receipt) => receipt.mutationKey)).toEqual(
      admissions.map((admission) => admission.mutationKey),
    );
    const revisions = receipts.map((receipt) => receipt.streamRevision);
    expect(revisions).toEqual(
      [...revisions].sort((left, right) => left - right),
    );
    expect(
      receipts.flatMap((receipt) => receipt.items).some((item) => item.final),
    ).toBe(true);
    expect(harness.events[harness.events.length - 1]?.type).toBe('terminal');

    const finalAdmission = admissions.find((admission) =>
      admission.changes.some(({ row: admittedRow }) => admittedRow.final),
    );
    if (!finalAdmission)
      throw new Error('The final command row was not admitted');
    const admittedFinalRow = finalAdmission.changes.find(
      ({ row: admittedRow }) => admittedRow.final,
    )?.row;
    if (!admittedFinalRow) throw new Error('Missing final admission row');
    const finalReceiptItem = receipts
      .flatMap((receipt) => receipt.items)
      .find((item) => item.id === admittedFinalRow.id && item.final);
    if (!finalReceiptItem) throw new Error('Missing final command receipt');

    const stateBeforeCheckpoint = value(await f.port.open({ target }));
    const originalRepository = f.repository;
    const originalService = f.service;
    const originalPort = f.port;
    await originalRepository.flushScope(f.scope);
    await f.reopen();
    expect(f.repository).not.toBe(originalRepository);
    expect(f.service).not.toBe(originalService);
    expect(f.port).not.toBe(originalPort);
    const reopenedState = value(await f.port.open({ target }));
    expect(reopenedState.streamRevision).toBe(
      stateBeforeCheckpoint.streamRevision,
    );
    const page = value(
      await f.port.page({
        target,
        streamRevision: reopenedState.streamRevision,
      }),
    );
    const finalRow = page.rows.find(({ id }) => id === admittedFinalRow.id);
    if (!finalRow) throw new Error('Missing reopened final command row');
    expect(finalRow.final).toBe(true);
    expect(finalRow.itemRevision).toBe(finalReceiptItem.itemRevision);
    const outputBlockOrdinal = finalRow.blocks.findIndex(
      (block) => block.type === 'tool_result',
    );
    if (outputBlockOrdinal < 0)
      throw new Error('The final command row has no result block');
    const reopenedOutput = await readAllContent(
      f.port,
      target,
      reopenedState.streamRevision,
      finalRow.id,
      outputBlockOrdinal,
      'output',
    );
    expect(reopenedOutput).toBe(fullOutput);
    expect(createHash('sha256').update(reopenedOutput).digest('hex')).toBe(
      createHash('sha256').update(fullOutput).digest('hex'),
    );
    const middleOffset = Buffer.byteLength(
      fullOutput.slice(0, Math.floor(fullOutput.length / 2)),
    );
    const middleRange = value(
      await f.port.contentRange({
        target,
        streamRevision: reopenedState.streamRevision,
        messageId: finalRow.id,
        blockOrdinal: outputBlockOrdinal,
        field: 'output',
        offset: middleOffset - 12,
        limit: 24,
      }),
    );
    expect(middleRange.text).toBe(
      fullOutput.slice(middleOffset - 12, middleOffset + 12),
    );
    const outputBytes = Buffer.byteLength(fullOutput);
    const endRange = value(
      await f.port.contentRange({
        target,
        streamRevision: reopenedState.streamRevision,
        messageId: finalRow.id,
        blockOrdinal: outputBlockOrdinal,
        field: 'output',
        offset: outputBytes - 32,
        limit: 32,
      }),
    );
    expect(endRange.text).toBe(fullOutput.slice(-32));

    const replay = value(
      await f.port.appendChanges({
        target,
        mutationKey: 'same-final-row-replay',
        changes: [{ row: admittedFinalRow }],
      }),
    );
    expect(replay).toMatchObject({
      target,
      streamRevision: reopenedState.streamRevision,
      replayed: true,
      items: [
        {
          id: admittedFinalRow.id,
          itemRevision: admittedFinalRow.itemRevision,
          final: true,
        },
      ],
    });
    const alteredBlocks = admittedFinalRow.blocks.map((block) =>
      block.type === 'tool_result'
        ? { ...block, output: 'mutated final' }
        : block,
    );
    const mutation = await f.port.appendChanges({
      target,
      mutationKey: 'attempt-final-revision-change',
      changes: [
        {
          row: {
            ...admittedFinalRow,
            itemRevision: admittedFinalRow.itemRevision + 1,
            blocks: alteredBlocks,
          },
        },
      ],
    });
    expect(mutation).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(value(await f.port.open({ target })).streamRevision).toBe(
      reopenedState.streamRevision,
    );
    expect(
      await readAllContent(
        f.port,
        target,
        reopenedState.streamRevision,
        finalRow.id,
        outputBlockOrdinal,
        'output',
      ),
    ).toBe(fullOutput);
    await expectSpoolsDisposed(
      spoolRoot,
      lifecycle,
      fieldClose.mock.calls.length,
    );
  });

  it.each(['before-write', 'after-write'] as const)(
    'fails the real local run on %s repository admission, then retries the same request at the reopened port',
    async (phase) => {
      const f = await fixture();
      const spoolRoot = await tempSpoolRoot();
      const lifecycle: SpoolLifecycle = {
        operations: [],
        ownersCreated: 0,
        ownersClosed: 0,
      };
      const fieldClose = jest.spyOn(FieldSpool.prototype, 'close');
      const target = f.ownedTarget('chat', 'delegation-1', 1);
      const fullOutput =
        'RETRY-PREFIX:' +
        'r'.repeat(45_000) +
        'RETRY-MIDDLE:' +
        's'.repeat(45_000) +
        ':RETRY-END';
      const admissions: Parameters<
        DelegationTranscriptPort['appendChanges']
      >[0][] = [];
      const admissionResults: Array<
        Awaited<ReturnType<DelegationTranscriptPort['appendChanges']>>
      > = [];
      const append = f.port.appendChanges.bind(f.port);
      jest
        .spyOn(f.port, 'appendChanges')
        .mockImplementation(async (input, signal) => {
          admissions.push(input);
          const result = await append(input, signal);
          admissionResults.push(result);
          return result;
        });
      const handle = fakeHandle('thread-c28', async (turn) => {
        await startCommand(turn, 'turn-c28-retry');
        await appendCommandOutput(turn, 'turn-c28-retry', fullOutput);
        f.injectStorageFailure(phase);
        await finishCommand(turn, 'turn-c28-retry');
        return {
          status: 'completed',
          text: 'unreachable after storage failure',
        };
      });
      const reportError = jest.fn();
      const harness = runCodex({
        prepare: () => Promise.resolve(preparation()),
        handles: [handle],
        runRequest: streamRequest(target),
        transcriptPort: f.port,
        spools: createSpoolFactory(spoolRoot, lifecycle),
        reportError,
      });

      await expect(harness.terminal).resolves.toMatchObject({
        type: 'terminal',
        status: 'failed',
        error: {
          code: 'runtime_error',
          message:
            'The delegated transcript could not be saved. Retained partial output is available.',
          retryable: false,
        },
      });
      const receipts = harness.events.filter(
        (event) => event.type === 'transcript_receipt',
      );
      const failedAdmission = admissions[admissions.length - 1];
      if (!failedAdmission)
        throw new Error('No repository admission was attempted');
      const failedAdmissionIndex = admissions.indexOf(failedAdmission);
      expect(admissionResults[failedAdmissionIndex]).toMatchObject({
        ok: false,
        error: {
          code: 'storage_failure',
          message:
            phase === 'before-write'
              ? 'Injected pre-durable child stream failure'
              : 'Injected post-durable child stream failure',
          retryable: true,
        },
      });
      const failedFinalRow = failedAdmission.changes.find(
        ({ row: admittedRow }) => admittedRow.final,
      )?.row;
      if (!failedFinalRow)
        throw new Error('The failed admission was not final');
      expect(receipts.map((receipt) => receipt.mutationKey)).toEqual(
        admissions.slice(0, -1).map((admission) => admission.mutationKey),
      );
      expect(
        receipts
          .flatMap((receipt) => receipt.items)
          .some((item) => item.id === failedFinalRow.id && item.final),
      ).toBe(false);
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            'The delegated transcript could not be saved. Retained partial output is available.',
        }),
      );
      await expectSpoolsDisposed(
        spoolRoot,
        lifecycle,
        fieldClose.mock.calls.length,
      );

      const oldRepository = f.repository;
      const oldService = f.service;
      const oldPort = f.port;
      await oldRepository.flushScope(f.scope);
      await f.reopen();
      expect(f.repository).not.toBe(oldRepository);
      expect(f.service).not.toBe(oldService);
      expect(f.port).not.toBe(oldPort);
      const reopenedPort = f.port;
      const retryInputs: typeof admissions = [];
      const reopenedAppend = reopenedPort.appendChanges.bind(reopenedPort);
      jest
        .spyOn(reopenedPort, 'appendChanges')
        .mockImplementation(async (input, signal) => {
          retryInputs.push(input);
          return reopenedAppend(input, signal);
        });
      const retry = value(await reopenedPort.appendChanges(failedAdmission));
      expect(retryInputs).toHaveLength(1);
      expect(retryInputs[0]).toBe(failedAdmission);
      expect(retry).toMatchObject({
        target,
        mutationKey: failedAdmission.mutationKey,
        replayed: phase === 'after-write',
        items: [
          {
            id: failedFinalRow.id,
            itemRevision: failedFinalRow.itemRevision,
            final: true,
          },
        ],
      });
      const retryReplay = value(
        await reopenedPort.appendChanges(failedAdmission),
      );
      expect(retryReplay).toMatchObject({
        target: retry.target,
        mutationKey: retry.mutationKey,
        streamRevision: retry.streamRevision,
        replayed: true,
        items: retry.items,
      });
      await f.repository.flushScope(f.scope);
      const repositoryBeforeReopen = f.repository;
      const serviceBeforeReopen = f.service;
      const portBeforeReopen = f.port;
      await f.reopen();
      expect(f.repository).not.toBe(repositoryBeforeReopen);
      expect(f.service).not.toBe(serviceBeforeReopen);
      expect(f.port).not.toBe(portBeforeReopen);
      const reopenedState = value(await f.port.open({ target }));
      const page = value(
        await f.port.page({
          target,
          streamRevision: reopenedState.streamRevision,
        }),
      );
      const finalRow = page.rows.find(({ id }) => id === failedFinalRow.id);
      if (!finalRow) throw new Error('Missing retried final command row');
      expect(finalRow.final).toBe(true);
      expect(finalRow.itemRevision).toBe(failedFinalRow.itemRevision);
      const outputBlockOrdinal = finalRow.blocks.findIndex(
        (block) => block.type === 'tool_result',
      );
      if (outputBlockOrdinal < 0)
        throw new Error('The retried command row has no result block');
      const reopenedOutput = await readAllContent(
        f.port,
        target,
        reopenedState.streamRevision,
        finalRow.id,
        outputBlockOrdinal,
        'output',
      );
      expect(reopenedOutput).toBe(fullOutput);
      expect(createHash('sha256').update(reopenedOutput).digest('hex')).toBe(
        createHash('sha256').update(fullOutput).digest('hex'),
      );
      const middleOffset = Buffer.byteLength(
        fullOutput.slice(0, Math.floor(fullOutput.length / 2)),
      );
      const middle = value(
        await f.port.contentRange({
          target,
          streamRevision: reopenedState.streamRevision,
          messageId: finalRow.id,
          blockOrdinal: outputBlockOrdinal,
          field: 'output',
          offset: middleOffset - 10,
          limit: 20,
        }),
      );
      expect(middle.text).toBe(
        fullOutput.slice(middleOffset - 10, middleOffset + 10),
      );
      const end = value(
        await f.port.contentRange({
          target,
          streamRevision: reopenedState.streamRevision,
          messageId: finalRow.id,
          blockOrdinal: outputBlockOrdinal,
          field: 'output',
          offset: Buffer.byteLength(fullOutput) - 24,
          limit: 24,
        }),
      );
      expect(end.text).toBe(fullOutput.slice(-24));
    },
  );

  it.each(['append', 'finish', 'read'] as const)(
    'latches gated real spool %s faults over Stop and disposes every handle',
    async (faultOperation) => {
      const f = await fixture();
      const spoolRoot = await tempSpoolRoot();
      const lifecycle: SpoolLifecycle = {
        operations: [],
        ownersCreated: 0,
        ownersClosed: 0,
      };
      const fieldClose = jest.spyOn(FieldSpool.prototype, 'close');
      const operationEntered = deferredGate();
      const releaseOperation = deferredGate();
      const storageFailure = new Error(`injected ${faultOperation} failure`);
      let failedOnce = false;
      const spools = createSpoolFactory(
        spoolRoot,
        lifecycle,
        async (operation) => {
          if (operation === faultOperation && !failedOnce) {
            failedOnce = true;
            operationEntered.release();
            await releaseOperation.promise;
            throw storageFailure;
          }
        },
      );
      const target = f.ownedTarget('chat', 'delegation-1', 1);
      const handle = fakeHandle('thread-c28', async (turn) => {
        await startCommand(turn, 'turn-c28-fault');
        await appendCommandOutput(turn, 'turn-c28-fault', 'PARTIAL-C28-OUTPUT');
        await finishCommand(turn, 'turn-c28-fault');
        return { status: 'completed', text: 'unreachable after spool failure' };
      });
      const reportError = jest.fn();
      const harness = runCodex({
        prepare: () => Promise.resolve(preparation()),
        handles: [handle],
        runRequest: streamRequest(target),
        transcriptPort: f.port,
        spools,
        reportError,
      });

      await operationEntered.promise;
      const stopping = harness.stop();
      releaseOperation.release();
      await stopping;
      await expect(harness.terminal).resolves.toMatchObject({
        type: 'terminal',
        status: 'failed',
        error: {
          code: 'runtime_error',
          message:
            'The delegated transcript could not be saved. Retained partial output is available.',
          retryable: false,
        },
      });
      expect(reportError).toHaveBeenCalledWith(storageFailure);
      await expectSpoolsDisposed(
        spoolRoot,
        lifecycle,
        fieldClose.mock.calls.length,
      );
    },
  );

  it('keeps a healthy stopped command cancelled and disposes its spool owner', async () => {
    const f = await fixture();
    const spoolRoot = await tempSpoolRoot();
    const lifecycle: SpoolLifecycle = {
      operations: [],
      ownersCreated: 0,
      ownersClosed: 0,
    };
    const fieldClose = jest.spyOn(FieldSpool.prototype, 'close');
    const outputAccepted = deferredGate();
    const target = f.ownedTarget('chat', 'delegation-1', 1);
    const handle = fakeHandle('thread-c28', async (turn, interrupted) => {
      await startCommand(turn, 'turn-c28-cancel');
      await appendCommandOutput(
        turn,
        'turn-c28-cancel',
        'PARTIAL-C28-CANCELLED-OUTPUT',
      );
      outputAccepted.release();
      await interrupted;
      return { status: 'interrupted', text: '' };
    });
    const harness = runCodex({
      prepare: () => Promise.resolve(preparation()),
      handles: [handle],
      runRequest: streamRequest(target),
      transcriptPort: f.port,
      spools: createSpoolFactory(spoolRoot, lifecycle),
    });

    await outputAccepted.promise;
    await harness.stop();
    await expect(harness.terminal).resolves.toMatchObject({
      type: 'terminal',
      status: 'cancelled',
    });
    await expectSpoolsDisposed(
      spoolRoot,
      lifecycle,
      fieldClose.mock.calls.length,
    );
  });

  it.each(['corrupt', 'missing'] as const)(
    'reports a %s referenced body without substituting a preview',
    async (failure) => {
      const f = await fixture();
      const target = f.ownedTarget('chat', 'delegate', 1);
      value(await f.port.open({ target }));
      const logical = {
        ...row(),
        final: true,
        blocks: [{ type: 'text' as const, text: 'large body '.repeat(20_000) }],
      };
      const receipt = value(
        await f.port.appendChanges({
          target,
          mutationKey: 'body',
          changes: [{ row: logical }],
        }),
      );
      await f.repository.flushScope(f.scope);
      const directory = join(
        f.store.directory,
        'transcripts',
        'tool-output',
        target.chatId,
      );
      const bodies = await readdir(directory);
      expect(bodies).toHaveLength(1);
      const body = join(directory, bodies[0]);
      if (failure === 'missing') await rm(body);
      else {
        const bytes = await readFile(body);
        bytes[0] ^= 0xff;
        await writeFile(body, bytes);
      }
      await f.reopen();
      expect(
        await f.port.contentRange({
          target,
          streamRevision: receipt.streamRevision,
          messageId: logical.id,
          blockOrdinal: 0,
          field: 'text',
          offset: 0,
          limit: 64,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: failure === 'missing' ? 'not_found' : 'corruption' },
      });
    },
  );

  it.each([2, 3])(
    'rejects explicit format %i through every supported stream operation',
    async (format) => {
      const directory = await root();
      const scope = { projectId: 'project', worktreeId: 'scope' };
      const store = new ChatStorageV2(directory, 'scope');
      await store.migrate(
        scopeSource([{ id: 'chat', messages: [message('parent', 'legacy')] }]),
      );
      if (format === 3) {
        const backend = new ChatStateV2Backend(store, { deltaJournal: {} });
        await backend.promoteToDeltaJournal();
        backend.releaseJournal();
      }
      expect(await store.format()).toBe(`v${format}`);
      const repository = new ChatStateV2Repository({
        resolvePaths: (): {
          tabs: string;
          archives: string;
          journal: string;
        } => ({
          tabs: join(directory, 'scope.json'),
          archives: join(directory, 'archives.json'),
          journal: join(directory, 'journal.jsonl'),
        }),
        // The option would promote this scope to format 4 at load; stream
        // operations must refuse below format 4 without it.
      });
      cleanups.push(() => repository.drainAll());
      const service = new ChatStateService({
        repository,
        recordDiagnostic: jest.fn(),
      });
      const port = new RepositoryDelegationTranscriptPort(service, scope);
      const target = {
        kind: 'delegation' as const,
        chatId: 'chat',
        delegationId: 'delegate',
        runGeneration: 1,
      };
      const pinned = { target, streamRevision: 0 };
      const operations: Array<() => Promise<unknown>> = [
        (): Promise<unknown> => port.open({ target }),
        (): Promise<unknown> =>
          port.appendChanges({
            target,
            mutationKey: 'legacy',
            changes: [{ row: row() }],
          }),
        (): Promise<unknown> => port.flush(pinned),
        (): Promise<unknown> => port.page(pinned),
        (): Promise<unknown> =>
          port.message({ ...pinned, messageId: 'retained' }),
        (): Promise<unknown> =>
          port.contentRange({
            ...pinned,
            messageId: 'retained',
            blockOrdinal: 0,
            field: 'text',
            offset: 0,
            limit: 64,
          }),
      ];
      for (const operation of operations)
        expect(await operation()).toMatchObject({
          ok: false,
          error: { code: 'unsupported_format' },
        });
    },
  );

  it('keeps the production service constructor at manifest ceiling 4', async () => {
    const stores: ChatStorageV2[] = [];
    const original = ChatStorageV2.fromLegacyPaths.bind(ChatStorageV2);
    jest
      .spyOn(ChatStorageV2, 'fromLegacyPaths')
      .mockImplementation((...args) => {
        const store = original(...args);
        stores.push(store);
        return store;
      });
    const service = new ChatStateService({ recordDiagnostic: jest.fn() });
    // Reading an isolated empty scope constructs the real default repository.
    await expect(
      service.getTranscriptPage({
        projectId: 'ceiling-project',
        worktreeId: 'ceiling-scope',
        chatId: 'missing',
      }),
    ).rejects.toThrow('Unknown chat: missing');
    expect(stores.length).toBeGreaterThan(0);
    expect(stores.every((store) => store.maxManifestVersion === 4)).toBe(true);
    await service.drain();
  });

  it.each(
    [
      'state',
      'page',
      'message',
      'content',
      'register',
      'append',
      'settle',
      'repair',
    ].flatMap((operation) =>
      [false, true].map((explicitCeiling) => ({ operation, explicitCeiling })),
    ),
  )(
    'handles option-off format-4 $operation (explicit ceiling: $explicitCeiling)',
    async ({ operation, explicitCeiling }) => {
      const f = await fixture();
      const target = f.ownedTarget('chat', 'delegate', 1);
      value(await f.port.open({ target }));
      value(
        await f.port.registerGeneration({
          ...target,
          createdAt: 100,
          store: 'stream',
          origin: { kind: 'launch' },
          executionMode: 'background',
        }),
      );
      const admitted = value(
        await f.port.appendChanges({
          target,
          mutationKey: 'seed',
          changes: [{ row: row() }],
        }),
      );
      await f.close();
      if (explicitCeiling) {
        // Also cover checkpointed format 4: a handling write must re-enter its
        // journal without authorizing promotion from format 3.
        const checkpointed = new ChatStateV2Backend(f.store, {
          deltaJournal: {},
        });
        await checkpointed.demoteFromDeltaJournal();
        checkpointed.releaseJournal();
        const original = ChatStorageV2.fromLegacyPaths.bind(ChatStorageV2);
        jest
          .spyOn(ChatStorageV2, 'fromLegacyPaths')
          .mockImplementation((paths) =>
            original(paths, { maxManifestVersion: 4 }),
          );
      }
      const directory = f.store.descriptor().workspaceRoot;
      const repository = new ChatStateV2Repository({
        resolvePaths: (): {
          tabs: string;
          archives: string;
          journal: string;
        } => ({
          tabs: join(directory, 'scope.json'),
          archives: join(directory, 'archives.json'),
          journal: join(directory, 'journal.jsonl'),
        }),
      });
      cleanups.push(() => repository.drainAll());
      const port = new RepositoryDelegationTranscriptPort(
        new ChatStateService({ repository, recordDiagnostic: jest.fn() }),
        f.scope,
      );
      if (operation === 'state') {
        expect(value(await port.generation(target))).toMatchObject({
          entry: { store: 'stream', runGeneration: 1 },
          stream: { status: 'open' },
        });
      } else if (operation === 'page') {
        expect(
          value(
            await port.page({
              target,
              streamRevision: admitted.streamRevision,
              limit: 10,
            }),
          ).rows,
        ).toMatchObject([{ id: 'retained' }]);
      } else if (operation === 'message') {
        expect(
          value(
            await port.message({
              target,
              streamRevision: admitted.streamRevision,
              messageId: 'retained',
            }),
          ),
        ).toMatchObject({ id: 'retained' });
      } else if (operation === 'content') {
        expect(
          value(
            await port.contentRange({
              target,
              streamRevision: admitted.streamRevision,
              messageId: 'retained',
              blockOrdinal: 0,
              field: 'text',
              offset: 0,
              limit: 64,
            }),
          ).text,
        ).toBe('revision 0');
      } else if (operation === 'register') {
        expect(
          value(
            await port.registerGeneration({
              ...target,
              runGeneration: 2,
              createdAt: 200,
              store: 'stream',
              origin: { kind: 'follow_up' },
              executionMode: 'background',
            }),
          ),
        ).toMatchObject({ runGeneration: 2, store: 'stream' });
        expect(
          value(await port.open({ target: { ...target, runGeneration: 2 } })),
        ).toMatchObject({ status: 'open' });
      } else if (operation === 'append') {
        expect(
          value(
            await port.appendChanges({
              target,
              mutationKey: 'option-off',
              changes: [{ row: row('next') }],
            }),
          ),
        ).toMatchObject({ replayed: false });
      } else {
        const settled = value(
          await port.settle({
            target,
            settlementKey: 'option-off-settlement',
            resultIndex: 1,
            outcome: { status: 'completed', finishedAt: 456 },
            finalChanges: [],
            openRows: 'finalize',
            answer:
              operation === 'repair'
                ? { role: 'final', lost: { sha256: 'a'.repeat(64), length: 7 } }
                : null,
          }),
        );
        expect(settled.result).toMatchObject({ resultIndex: 1 });
        if (operation === 'repair') {
          expect(
            value(
              await port.resultBySettlementKey({
                ...target,
                settlementKey: 'option-off-settlement',
              }),
            ),
          ).toMatchObject({ answer: { kind: 'lost', length: 7 } });
        }
      }
    },
  );
});
