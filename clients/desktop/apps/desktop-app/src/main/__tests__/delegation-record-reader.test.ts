import { FixtureDelegationReadMetadata } from '@canopy/desktop-shared/node/delegation/testing/record-read-metadata-fixture';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositoryTranscriptPortFixture } from './helpers/repository-transcript-port-fixture';
import { DelegationRegistryOperationError } from '../lib/chat-delta-journal/delegation-registry-error';
import {
  delegationBlockId,
  type PersistedChatMessage,
} from '@canopy/agent-transcript';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import type { DelegationRecordReadMetadata } from '@canopy/desktop-shared/node/delegation/record-read-metadata';
import type {
  DelegationTranscriptPortErrorCode,
  DelegationTranscriptGeneration,
  DelegationTranscriptGenerationEntry,
  DelegationTranscriptResultEntry,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import type { DelegationRecordReadStreamState } from '../agents/delegation/repository-transcript-port';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import { routeFixture } from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/fixtures';
import { projectAgentRoute } from '@canopy/desktop-shared/node/delegation';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import {
  createDelegationRecordReader,
  type DelegationRecordReadPort,
} from '../agents/delegation/record-reader';

const scope: ChatScopeKey = { projectId: 'project', worktreeId: 'worktree' };
const target: DelegationTranscriptTarget = {
  kind: 'delegation',
  chatId: 'chat',
  delegationId: 'child',
  runGeneration: 2,
};

function metadata(
  currentStore: 'legacy' | 'stream' = 'stream',
  settling = false,
): DelegationRecordReadMetadata {
  const fixture = new FixtureDelegationReadMetadata();
  fixture.stream(target.delegationId, {
    originAt: 100,
    lastActivityAt: 125,
    settling,
  });
  const capsule = fixture.source(record());
  if (!capsule) throw new Error('Missing fixture read metadata');
  return currentStore === 'stream'
    ? capsule
    : { ...capsule, current: { ...capsule.current, store: 'legacy' } };
}

function record(
  state?: StoredDelegation['state'],
  route?: StoredDelegation['route'],
): StoredDelegation {
  return {
    version: 2,
    parent: {
      harnessId: 'codex',
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: target.chatId,
      turnId: 'turn',
      toolCallId: 'call',
      sessionKey: 'project/worktree/chat',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'logical-model',
      description: 'Current task',
      prompt: 'Current prompt',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
      executionMode: 'background',
    },
    callKey: 'call-key',
    requestHash: 'request-hash',
    createdAt: 100,
    ...(route === undefined ? {} : { route }),
    state: state ?? {
      delegationId: target.delegationId,
      runGeneration: target.runGeneration,
      sequence: 4,
      status: 'running',
      outputTruncated: false,
    },
    launch: {
      version: 1,
      delegationId: target.delegationId,
      launchKey: 'call-key',
      runGeneration: target.runGeneration,
      phase: 'identified',
    },
    delivery: { status: 'unclaimed' },
    history: [],
  };
}

function generationEntry(
  runGeneration: number,
  anchorMessageId: string,
  store: 'legacy' | 'stream' = 'stream',
): DelegationTranscriptGenerationEntry {
  return {
    version: 1,
    kind: 'generation',
    chatId: target.chatId,
    delegationId: target.delegationId,
    runGeneration,
    createdAt: 100 + runGeneration,
    store,
    origin: {
      kind: runGeneration === 1 ? 'launch' : 'follow_up',
      anchorMessageId,
    },
    executionMode: 'foreground',
  };
}

function generation(
  entry: DelegationTranscriptGenerationEntry,
  result: DelegationTranscriptResultEntry | null = null,
): DelegationTranscriptGeneration {
  return { entry, stream: null, result };
}

function settledResult(
  runGeneration: number,
  overrides: Partial<DelegationTranscriptResultEntry['outcome']> = {},
): DelegationTranscriptResultEntry {
  return {
    version: 1,
    kind: 'result',
    resultIndex: 3,
    runGeneration,
    settlementKey: `settle-${runGeneration}`,
    settlementDigest: `digest-${runGeneration}`,
    outcome: {
      status: 'completed',
      startedAt: 140,
      finishedAt: 180,
      ...overrides,
    },
    answer: { kind: 'none' },
    settlement: {
      streamRevision: 2,
      contentRevision: 2,
      finalItemCount: 0,
      finalItemsDigest: 'items',
    },
  };
}

function cardMessage(
  messageId: string,
  runGeneration: number,
  options: {
    readonly description: string;
    readonly prompt: string;
    readonly finalText?: string;
    readonly partialText?: string;
    readonly snapshot?: Partial<AgentDelegationSnapshot>;
  },
): PersistedChatMessage {
  return {
    id: messageId,
    role: 'assistant',
    timestamp: 100 + runGeneration,
    blocks: [
      {
        type: 'delegated_agent_call',
        agentBlockId: delegationBlockId(target.delegationId, runGeneration),
        delegationId: target.delegationId,
        runGeneration,
        sequence: runGeneration,
        parentHarnessId: 'codex',
        parentTurnId: 'turn',
        parentToolCallId: 'call',
        createdAt: 100 + runGeneration,
        selectedModelId: 'model',
        runtimeModelId: 'model',
        targetHarnessId: 'codex',
        routeSnapshot: projectAgentRoute(
          routeFixture({
            selectedModelId: 'model',
            runtimeModelId: 'model',
            harnessId: 'codex',
          }),
        ),
        description: options.description,
        prompt: options.prompt,
        executionMode: 'foreground',
        status: 'completed',
        outputTruncated: false,
        ...(options.finalText === undefined
          ? {}
          : { finalText: options.finalText }),
        ...(options.partialText === undefined
          ? {}
          : { partialText: options.partialText }),
        ...options.snapshot,
      },
    ],
  };
}

interface ReadCounts {
  generation: number;
  resultByGeneration: number;
  generationsPage: number;
  getChildStreamState: number;
  readStoredParentMessage: number;
}

function readPort(
  options: {
    readonly generations?: readonly DelegationTranscriptGeneration[];
    readonly cards?: readonly PersistedChatMessage[];
    readonly currentDescriptor?: DelegationRecordReadStreamState;
    readonly orphanResult?: DelegationTranscriptResultEntry;
  } = {},
): { readonly port: DelegationRecordReadPort; readonly counts: ReadCounts } {
  const counts: ReadCounts = {
    generation: 0,
    resultByGeneration: 0,
    generationsPage: 0,
    getChildStreamState: 0,
    readStoredParentMessage: 0,
  };
  const port: DelegationRecordReadPort = {
    generation: (_scope, request) => {
      counts.generation += 1;
      return Promise.resolve(
        options.generations?.find(
          (candidate) =>
            candidate.entry.runGeneration === request.runGeneration,
        ),
      );
    },
    resultByGeneration: (_scope, request) => {
      counts.resultByGeneration += 1;
      return Promise.resolve(
        options.orphanResult?.runGeneration === request.runGeneration
          ? options.orphanResult
          : undefined,
      );
    },
    generationsPage: (_scope, request) => {
      counts.generationsPage += 1;
      const entries = (options.generations ?? []).filter(
        (candidate) => candidate.entry.delegationId === request.delegationId,
      );
      return Promise.resolve({ generations: entries });
    },
    getChildStreamState: (_scope, requestedTarget) => {
      counts.getChildStreamState += 1;
      return Promise.resolve(
        options.currentDescriptor?.target.runGeneration ===
          requestedTarget.runGeneration
          ? options.currentDescriptor
          : undefined,
      );
    },
    readStoredParentMessage: (_scope, _chatId, messageId) => {
      counts.readStoredParentMessage += 1;
      return Promise.resolve(
        options.cards?.find((candidate) => candidate.id === messageId),
      );
    },
  };
  return { port, counts };
}

function legacyExecutionFailure(
  message: string,
  retryable: boolean,
): NonNullable<StoredDelegation['state']['error']> {
  const error: NonNullable<StoredDelegation['state']['error']> = {
    code: 'runtime_error',
    message,
    retryable,
  };
  // These reader cases intentionally keep the removed persisted error code.
  Reflect.set(error, 'code', 'execution_failed');
  return error;
}

describe('DelegationRecordReader', () => {
  it('preserves the no-argument unsupported default', async () => {
    const reader = createDelegationRecordReader();

    await expect(
      reader.resolveActivity({ record: record(), readMetadata: metadata() }),
    ).rejects.toThrow('Stream-backed delegation readers are not available yet');
  });

  it('uses a historical generation’s own stored-card previews and never record bodies', async () => {
    const currentState: StoredDelegation['state'] = {
      delegationId: target.delegationId,
      runGeneration: target.runGeneration,
      sequence: 6,
      status: 'running',
      outputTruncated: false,
      get partialText(): string {
        throw new Error('reader inspected a record body');
      },
    };
    const historical = generation(generationEntry(1, 'historical-card'));
    const current = generation(generationEntry(2, 'current-card'));
    const { port, counts } = readPort({
      generations: [historical, current],
      cards: [
        cardMessage('historical-card', 1, {
          description: 'Historical description',
          prompt: 'Historical prompt',
          finalText: 'Historical final preview',
          partialText: 'Historical partial preview',
        }),
        cardMessage('current-card', 2, {
          description: 'Current description',
          prompt: 'Current prompt',
        }),
      ],
    });
    const reader = createDelegationRecordReader({ port, scope });

    const resolvedList = await reader.resolveGenerationList({
      record: record(currentState),
      readMetadata: metadata(),
    });

    const [resolved] = resolvedList;
    expect(resolved).toMatchObject({
      kind: 'stream',
      runGeneration: 1,
      status: 'interrupted',
      task: {
        description: 'Historical description',
        prompt: 'Historical prompt',
        executionMode: 'foreground',
      },
      snapshot: {
        status: 'interrupted',
        finalText: 'Historical final preview',
        partialText: 'Historical partial preview',
      },
    });
    expect(counts).toEqual({
      generation: 0,
      resultByGeneration: 0,
      generationsPage: 1,
      getChildStreamState: 0,
      readStoredParentMessage: 2,
    });
    expect(resolvedList).toHaveLength(2);
    expect(counts.readStoredParentMessage).toBe(2);
  });

  it('lets a canonical result beat stale settling and clears stale outcome fields', async () => {
    const current = generation(
      generationEntry(2, 'current-card'),
      settledResult(2),
    );
    const { port, counts } = readPort({
      generations: [current],
      cards: [
        cardMessage('current-card', 2, {
          description: 'Current description',
          prompt: 'Current prompt',
          finalText: 'Card preview',
        }),
      ],
    });
    const reader = createDelegationRecordReader({ port, scope });
    const input = {
      record: record(
        {
          delegationId: target.delegationId,
          runGeneration: 2,
          sequence: 10,
          status: 'running',
          startedAt: 90,
          finishedAt: 95,
          error: legacyExecutionFailure('stale error', false),
          usage: { inputTokens: 9 },
          stopReason: 'shutdown',
          outputTruncated: false,
          get partialText(): string {
            throw new Error('reader inspected a record body');
          },
        },
        routeFixture(),
      ),
      readMetadata: metadata('stream', true),
    };

    const resolved = await reader.resolveGenerationHeader(input, 2);

    expect(resolved).toMatchObject({
      kind: 'stream',
      status: 'completed',
      startedAt: 140,
      finishedAt: 180,
      snapshot: {
        status: 'completed',
        resultIndex: 3,
        finalText: 'Card preview',
      },
      task: { description: 'Current description', prompt: 'Current prompt' },
    });
    if (resolved.kind !== 'stream') throw new Error('Expected stream result');
    expect(resolved.snapshot.error).toBeUndefined();
    expect(resolved.snapshot.usage).toBeUndefined();
    expect(resolved.snapshot.stopReason).toBeUndefined();
    expect(resolved.snapshot.routeSnapshot).not.toHaveProperty(
      'authAccountKey',
    );
    expect(counts).toEqual({
      generation: 1,
      resultByGeneration: 0,
      generationsPage: 0,
      getChildStreamState: 0,
      readStoredParentMessage: 1,
    });
  });

  it('allows the watcher alone to read an orphan result by generation', async () => {
    const { port, counts } = readPort({ orphanResult: settledResult(2) });
    const reader = createDelegationRecordReader({ port, scope });
    const input = { record: record(), readMetadata: metadata() };

    const outcome = await reader.resolveGenerationOutcome(input, 2);
    const header = await reader.resolveGenerationHeader(input, 2);

    expect(outcome).toEqual({ kind: 'settled', result: settledResult(2) });
    expect(header).toMatchObject({
      kind: 'content_unavailable',
      runGeneration: 2,
      failure: { code: 'not_found' },
    });
    expect(counts).toEqual({
      generation: 2,
      resultByGeneration: 1,
      generationsPage: 0,
      getChildStreamState: 0,
      readStoredParentMessage: 0,
    });
  });

  it('takes the validated legacy branch without touching stream metadata', async () => {
    const { port, counts } = readPort({
      generations: [generation(generationEntry(2, 'ignored-card', 'legacy'))],
    });
    const reader = createDelegationRecordReader({ port, scope });
    const input = { record: record(), readMetadata: metadata('legacy') };

    await expect(reader.resolveActivity(input)).resolves.toBe(100);
    await expect(reader.resolveGenerationOutcome(input, 2)).resolves.toEqual({
      kind: 'unsettled',
    });
    await expect(reader.resolveGenerationHeader(input, 2)).resolves.toEqual({
      kind: 'legacy',
      runGeneration: 2,
    });
    await expect(reader.resolveGenerationList(input)).resolves.toEqual([]);
    expect(counts).toEqual({
      generation: 0,
      resultByGeneration: 0,
      generationsPage: 0,
      getChildStreamState: 0,
      readStoredParentMessage: 0,
    });
  });

  it('validates the branch capsule before performing any stream read', async () => {
    const { port, counts } = readPort();
    const reader = createDelegationRecordReader({ port, scope });
    const invalid: DelegationRecordReadMetadata = {
      ...metadata(),
      current: {
        store: 'stream',
        target: { ...target, runGeneration: 1 },
      },
    };

    await expect(
      reader.resolveActivity({ record: record(), readMetadata: invalid }),
    ).rejects.toThrow('Invalid delegation read metadata: target');
    expect(counts).toEqual({
      generation: 0,
      resultByGeneration: 0,
      generationsPage: 0,
      getChildStreamState: 0,
      readStoredParentMessage: 0,
    });
  });

  it('reads at most one current descriptor for roots activity', async () => {
    const descriptor: DelegationRecordReadStreamState = {
      target,
      status: 'open',
      streamRevision: 1,
      openedAt: 150,
      latestRowTimestamp: 170,
    };
    const { port, counts } = readPort({ currentDescriptor: descriptor });
    const reader = createDelegationRecordReader({ port, scope });

    await expect(
      reader.resolveActivity({ record: record(), readMetadata: metadata() }),
    ).resolves.toBe(170);
    expect(counts).toEqual({
      generation: 0,
      resultByGeneration: 0,
      generationsPage: 0,
      getChildStreamState: 1,
      readStoredParentMessage: 0,
    });
  });

  it('keeps a generation with an absent card and marks its task unavailable', async () => {
    const { port, counts } = readPort({
      generations: [generation(generationEntry(1, 'missing-card'))],
    });
    const reader = createDelegationRecordReader({ port, scope });

    const [resolved] = await reader.resolveGenerationList({
      record: record(),
      readMetadata: metadata(),
    });

    expect(resolved).toMatchObject({
      kind: 'stream',
      runGeneration: 1,
      task: { description: '', prompt: '', executionMode: 'foreground' },
      taskUnavailable: true,
    });
    expect(counts.readStoredParentMessage).toBe(1);
  });
  it('uses current execution and control times without reading transcript bodies', async () => {
    const source = record({
      delegationId: 'child',
      runGeneration: 2,
      sequence: 1,
      status: 'running',
      outputTruncated: false,
      startedAt: 200,
      finishedAt: 250,
      get transcript(): never {
        throw new Error('body read');
      },
    });
    const current: StoredDelegation = {
      ...source,
      control: {
        operationId: 'control',
        operation: 'steer',
        key: 'key',
        requestHash: 'hash',
        status: 'accepted',
        occurredAt: 300,
      },
    };
    // Preserve the legacy controls array as raw input to the V3 reader.
    Reflect.set(current, 'controls', [
      {
        operationId: 'old-control',
        operation: 'steer',
        key: 'key',
        requestHash: 'hash',
        status: 'completed',
        occurredAt: 350,
      },
    ]);
    const { port, counts } = readPort();
    await expect(
      createDelegationRecordReader({ port, scope }).resolveActivity({
        record: current,
        readMetadata: metadata(),
      }),
    ).resolves.toBe(350);
    expect(counts.getChildStreamState).toBe(1);
  });

  it('keeps settling record evidence and sets the snapshot generation', async () => {
    const error = legacyExecutionFailure('retained evidence', true);
    const source = record({
      delegationId: 'child',
      runGeneration: 2,
      sequence: 1,
      status: 'failed',
      outputTruncated: true,
      startedAt: 120,
      error,
      usage: { inputTokens: 5 },
      stopReason: 'shutdown',
    });
    const { port } = readPort({
      generations: [generation(generationEntry(2, 'missing'))],
    });
    const resolved = await createDelegationRecordReader({
      port,
      scope,
    }).resolveGenerationHeader(
      { record: source, readMetadata: metadata('stream', true) },
      2,
    );
    expect(resolved).toMatchObject({
      kind: 'settling',
      snapshot: {
        runGeneration: 2,
        status: 'running',
        error,
        usage: { inputTokens: 5 },
        stopReason: 'shutdown',
        outputTruncated: true,
      },
    });
  });

  it('resolves a legacy-prefix generation of a stream-backed record without a registry read', async () => {
    const { port, counts } = readPort();
    const legacyPrefix = {
      ...record(),
      history: [
        {
          delegationId: target.delegationId,
          runGeneration: 1,
          sequence: 3,
          parentHarnessId: 'codex',
          parentTurnId: 'turn',
          parentToolCallId: 'call',
          createdAt: 100,
          task: {
            description: 'Legacy prefix',
            prompt: 'Legacy prompt',
            executionMode: 'background' as const,
          },
          snapshot: {
            delegationId: target.delegationId,
            status: 'completed' as const,
            outputTruncated: false,
          },
          transcript: [],
        },
      ],
    };
    await expect(
      createDelegationRecordReader({ port, scope }).resolveGenerationHeader(
        { record: legacyPrefix, readMetadata: metadata() },
        1,
      ),
    ).resolves.toEqual({ kind: 'legacy', runGeneration: 1 });
    expect(counts.generation).toBe(0);
  });

  it('marks an absent generation without an orphan result unavailable for watcher retry', async () => {
    const { port, counts } = readPort();
    const resolved = await createDelegationRecordReader({
      port,
      scope,
    }).resolveGenerationOutcome(
      { record: record(), readMetadata: metadata() },
      1,
    );
    expect(resolved).toMatchObject({
      kind: 'unavailable',
      failure: { code: 'not_found' },
    });
    expect(counts.generation).toBe(1);
    expect(counts.resultByGeneration).toBe(1);
  });

  it('sets the stream snapshot generation independently of the current record', async () => {
    const { port } = readPort({
      generations: [generation(generationEntry(1, 'missing'))],
    });
    const resolved = await createDelegationRecordReader({
      port,
      scope,
    }).resolveGenerationHeader(
      { record: record(), readMetadata: metadata() },
      1,
    );
    expect(resolved).toMatchObject({
      kind: 'stream',
      snapshot: { runGeneration: 1 },
    });
  });
  it('projects queued current metadata instead of stale stored-card execution fields', async () => {
    const source: StoredDelegation = {
      ...record(),
      state: {
        delegationId: 'child',
        runGeneration: 2,
        sequence: 0,
        status: 'pending',
        outputTruncated: false,
      },
      admission: { runGeneration: 2, state: 'waiting', queuedAt: 110 },
    };
    const { port } = readPort({
      generations: [generation(generationEntry(2, 'current'))],
      cards: [
        cardMessage('current', 2, {
          description: 'Own',
          prompt: 'Own',
          snapshot: {
            phase: 'running',
            depth: 8,
            permissions: { writePaths: ['stale'] },
          },
        }),
      ],
    });
    const resolved = await createDelegationRecordReader({
      port,
      scope,
    }).resolveGenerationHeader({ record: source, readMetadata: metadata() }, 2);
    expect(resolved).toMatchObject({
      kind: 'stream',
      snapshot: {
        status: 'pending',
        phase: 'queued',
        depth: 1,
        nestedDelegation: 'not_enabled',
        requestedModelId: 'logical-model',
        permissions: { writePaths: [] },
      },
    });
  });

  it('enumerates over one hundred generations with metadata pages and one card read per generation', async () => {
    const generations = Array.from({ length: 205 }, (_, index) =>
      generation(generationEntry(index + 1, `card-${index + 1}`)),
    );
    const { port, counts } = readPort();
    const paged: DelegationRecordReadPort = {
      ...port,
      generationsPage: (_scope, request) => {
        counts.generationsPage += 1;
        const offset =
          request.cursor === undefined ? 0 : Number(request.cursor);
        const end = Math.min(generations.length, offset + request.limit);
        return Promise.resolve({
          generations: generations.slice(offset, end),
          ...(end < generations.length ? { cursor: String(end) } : {}),
        });
      },
    };
    const resolved = await createDelegationRecordReader({
      port: paged,
      scope,
    }).resolveGenerationList({ record: record(), readMetadata: metadata() });
    expect(resolved).toHaveLength(205);
    expect(counts).toEqual({
      generation: 0,
      resultByGeneration: 0,
      generationsPage: 3,
      getChildStreamState: 0,
      readStoredParentMessage: 205,
    });
  });
  it.each([
    'stale_identity',
    'conflict',
    'corruption',
    'unsupported_format',
    'storage_failure',
  ] satisfies readonly DelegationTranscriptPortErrorCode[])(
    'preserves typed registry %s failures without a card or answer read',
    async (code) => {
      const { port, counts } = readPort();
      const failure = new DelegationRegistryOperationError({
        code,
        message: 'registry unavailable',
        retryable: true,
      });
      const failing: DelegationRecordReadPort = {
        ...port,
        generation: () => Promise.reject(failure),
        generationsPage: () => Promise.reject(failure),
      };
      const reader = createDelegationRecordReader({ port: failing, scope });
      const input = { record: record(), readMetadata: metadata() };
      await expect(
        reader.resolveGenerationOutcome(input, 2),
      ).resolves.toMatchObject({ kind: 'unavailable', failure: { code } });
      await expect(
        reader.resolveGenerationHeader(input, 2),
      ).resolves.toMatchObject({
        kind: 'content_unavailable',
        failure: { code },
      });
      await expect(reader.resolveGenerationList(input)).rejects.toBe(failure);
      expect(counts.readStoredParentMessage).toBe(0);
      expect(counts.resultByGeneration).toBe(0);
    },
  );

  it('keeps a canonical lost-answer outcome without inspecting answer content', async () => {
    const guarded = settledResult(1);
    Object.defineProperty(guarded, 'answer', {
      get(): never {
        throw new Error('answer read');
      },
    });
    const { port } = readPort({
      generations: [generation(generationEntry(1, 'missing'), guarded)],
    });
    const reader = createDelegationRecordReader({ port, scope });
    const input = { record: record(), readMetadata: metadata() };
    await expect(
      reader.resolveGenerationOutcome(input, 1),
    ).resolves.toMatchObject({ kind: 'settled' });
    await expect(
      reader.resolveGenerationHeader(input, 1),
    ).resolves.toMatchObject({
      kind: 'stream',
      snapshot: { status: 'completed', resultIndex: 3 },
      finishedAt: 180,
    });
  });
  it('reads a historical own-card snapshot and missing-generation outcome through the real repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'record-reader-repository-'));
    const fixture = await createRepositoryTranscriptPortFixture(root)();
    try {
      await fixture.repository.transact(
        fixture.scope,
        [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: cardMessage('own-card', 1, {
              description: 'Historical own task',
              prompt: 'Historical own prompt',
              finalText: 'Own stored preview',
            }),
          },
        ],
        { source: 'provider' },
      );
      await fixture.repository.registerGeneration(
        fixture.scope,
        generationEntry(1, 'own-card'),
      );
      const reader = createDelegationRecordReader({
        port: fixture.repository,
        scope: fixture.scope,
      });
      const input = { record: record(), readMetadata: metadata() };
      await expect(
        reader.resolveGenerationHeader(input, 1),
      ).resolves.toMatchObject({
        kind: 'stream',
        status: 'interrupted',
        task: {
          description: 'Historical own task',
          prompt: 'Historical own prompt',
        },
        snapshot: { runGeneration: 1, finalText: 'Own stored preview' },
      });
      await expect(
        reader.resolveGenerationHeader(input, 2),
      ).resolves.toMatchObject({
        kind: 'content_unavailable',
        failure: { code: 'not_found' },
      });
      await expect(
        reader.resolveGenerationOutcome(input, 2),
      ).resolves.toMatchObject({
        kind: 'unavailable',
        failure: { code: 'not_found' },
      });
      const list = await reader.resolveGenerationList(input);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ runGeneration: 1 });
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
