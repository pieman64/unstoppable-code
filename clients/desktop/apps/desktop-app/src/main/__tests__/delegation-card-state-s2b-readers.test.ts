import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as transcript from '@canopy/agent-transcript';
import * as overlayModule from '@canopy/agent-transcript/lib/delegation-transcript';
import type {
  DelegatedAgentCallBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript';
import type { CardState, CardStateDraft } from '@canopy/protocol/canopy-core';
import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import type {
  DelegationTranscriptGeneration,
  DelegationTranscriptPortResult,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { FixtureDelegationReadMetadata } from '@canopy/desktop-shared/node/delegation/testing/record-read-metadata-fixture';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import {
  createDelegationRecordReader,
  type DelegationRecordReadPort,
} from '../agents/delegation/record-reader';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';
import { snapshotFormat4Files } from './helpers/chat-format4-scope';

jest.setTimeout(120_000);

function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function rawCard(generation = 1): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    agentBlockId: transcript.delegationBlockId('matrix', generation),
    delegationId: 'matrix',
    runGeneration: generation,
    sequence: 1,
    parentHarnessId: 'codex',
    parentTurnId: 'turn',
    parentToolCallId: 'call',
    createdAt: 100,
    status: 'pending',
    outputTruncated: false,
    requestedModelId: 'creation-model',
    selectedModelId: 'creation-model',
    runtimeModelId: '',
    targetHarnessId: '',
    description: 'Creation description',
    prompt: 'Creation prompt',
    executionMode: 'background',
    nativeSessionId: 'creation-session',
    childDelegationIds: ['creation-child'],
    transcriptStore: 'chat-stream-v2',
  };
}

function row(card: DelegatedAgentCallBlock): PersistedChatMessage {
  return {
    id: card.agentBlockId,
    role: 'assistant',
    timestamp: 100,
    blocks: [card, { type: 'text', text: 'ordinary searchable text' }],
  };
}

const durableRoute: NonNullable<CardStateDraft['routeSnapshot']> = {
  selectedModelId: 'selected',
  runtimeModelId: 'runtime',
  harnessId: 'codex',
  runtimeKind: 'sdk',
  runnerRegistrationId: 'runner',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'agent',
  providerType: 'openai',
  assignmentRevision: '1',
  billingAuthority: 'local',
  aiCreditsRouted: false,
  capabilities: [],
  supportedThinkingLevels: [],
  capabilitySnapshotHash: 'hash',
  capabilityGeneration: 1,
  policyRevision: '1',
  requestedThinkingLevel: 'high',
  effectiveThinkingLevel: 'medium',
};

const draft: CardStateDraft = {
  version: 2,
  status: 'running',
  outputTruncated: true,
  prompt: 'Amended prompt',
  requestedModelId: 'durable-model',
  routeSnapshot: durableRoute,
  nativeSessionId: 'durable-session',
  childDelegationIds: ['durable-child'],
  nestedDelegation: 'not_enabled',
  isolatedWorkspace: {
    revision: 'durable-workspace',
    dirtyParentChangesIncluded: false,
  },
};

/** Independent durable-field oracle: never calls the projection or overlay. */
const running = {
  status: 'running',
  outputTruncated: true,
  requestedModelId: 'durable-model',
  routeSnapshot: {
    selectedModelId: 'selected',
    runtimeModelId: 'runtime',
    harnessId: 'codex',
    runtimeKind: 'sdk',
    runnerRegistrationId: 'runner',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'agent',
    providerType: 'openai',
    assignmentRevision: '1',
    billingAuthority: 'local',
    aiCreditsRouted: false,
    capabilities: [],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'hash',
    capabilityGeneration: 1,
    policyRevision: '1',
    requestedThinkingLevel: 'high',
    effectiveThinkingLevel: 'medium',
  },
  nativeSessionId: 'durable-session',
  childDelegationIds: ['durable-child'],
  nestedDelegation: 'not_enabled',
  isolatedWorkspace: {
    revision: 'durable-workspace',
    dirtyParentChangesIncluded: false,
  },
};

function durable(snapshot: AgentDelegationSnapshot): object {
  const {
    status,
    outputTruncated,
    requestedModelId,
    routeSnapshot,
    capabilities,
    nativeSessionId,
    childDelegationIds,
    nestedDelegation,
    isolatedWorkspace,
    workspaceDiscarded,
    control,
    resultIndex,
    finalText,
    partialText,
    error,
    usage,
    stopReason,
    cancelledByUser,
    stoppedBy,
  } = snapshot;
  return Object.fromEntries(
    Object.entries({
      status,
      outputTruncated,
      requestedModelId,
      routeSnapshot,
      capabilities,
      nativeSessionId,
      childDelegationIds,
      nestedDelegation,
      isolatedWorkspace,
      workspaceDiscarded,
      control,
      resultIndex,
      finalText,
      partialText,
      error,
      usage,
      stopReason,
      cancelledByUser,
      stoppedBy,
    }).filter(([, field]) => field !== undefined),
  );
}

function record(
  fixture: RepositoryTranscriptPortFixture,
  generation = 1,
): StoredDelegation {
  return {
    version: 2,
    parent: {
      harnessId: 'codex',
      ...fixture.scope,
      chatId: 'chat',
      turnId: 'turn',
      toolCallId: 'call',
      sessionKey: 'matrix',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'stale-live-model',
      description: 'Stale live description',
      prompt: 'Stale live prompt',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
      executionMode: 'background',
    },
    callKey: 'call',
    requestHash: 'hash',
    createdAt: 100,
    state: {
      delegationId: 'matrix',
      runGeneration: generation,
      sequence: 9,
      status: 'running',
      outputTruncated: false,
      nativeSessionId: 'stale-live-session',
      approvalPending: true,
    },
    launch: {
      version: 1,
      delegationId: 'matrix',
      launchKey: 'call',
      runGeneration: generation,
      phase: 'identified',
    },
    delivery: { status: 'unclaimed' },
    history: [],
  };
}

function readerPort(
  fixture: RepositoryTranscriptPortFixture,
  transform: (
    entry: DelegationTranscriptGeneration,
  ) => DelegationTranscriptGeneration = (entry) => entry,
): DelegationRecordReadPort {
  const repository = fixture.repository;
  return {
    generation: async (
      scope,
      input,
    ): ReturnType<DelegationRecordReadPort['generation']> => {
      const entry = await repository.generation(scope, input);
      return entry && transform(entry);
    },
    resultByGeneration: (scope, input) =>
      repository.resultByGeneration(scope, input),
    generationsPage: async (
      scope,
      input,
    ): ReturnType<DelegationRecordReadPort['generationsPage']> => {
      const page = await repository.generationsPage(scope, input);
      return { ...page, generations: page.generations.map(transform) };
    },
    getChildStreamState: async (
      scope,
      target,
    ): ReturnType<DelegationRecordReadPort['getChildStreamState']> => {
      const descriptor = await repository.getChildStreamState(scope, target);
      if (!descriptor) return undefined;
      return {
        target,
        status: descriptor.status,
        streamRevision: descriptor.streamRevision,
        ...(descriptor.openedAt === null
          ? {}
          : { openedAt: descriptor.openedAt }),
        latestRowTimestamp: descriptor.latestRowTimestamp,
        cardState: descriptor.cardState,
      };
    },
    readStoredParentMessage: (scope, chatId, messageId) =>
      repository.readStoredParentMessage(scope, chatId, messageId),
  };
}

async function checkReaders(
  fixture: RepositoryTranscriptPortFixture,
  expected: object,
  options: {
    settling?: boolean;
    old?: boolean;
    generation?: number;
    transform?: (
      entry: DelegationTranscriptGeneration,
    ) => DelegationTranscriptGeneration;
    recordExpected?: object;
    amended?: boolean;
  } = {},
): Promise<void> {
  const card = rawCard(options.generation);
  const snapshot = await fixture.repository.getState(fixture.scope, {
    chatIds: ['chat'],
    fullTranscript: true,
  });
  const page = await fixture.repository.page(fixture.scope, 'chat');
  const blocks = await fixture.repository.blocks({
    ...fixture.scope,
    chatId: 'chat',
    messageId: card.agentBlockId,
    limit: 10,
  });
  const snapshotCard = snapshot.tabsFile.tabs
    .find((tab) => tab.id === 'chat')
    ?.messages.find((message) => message.id === card.agentBlockId)
    ?.blocks.find((block) => block.type === 'delegated_agent_call');
  const pageCard = page.messages
    .find((message) => message.id === card.agentBlockId)
    ?.blocks.find((block) => block.type === 'delegated_agent_call');
  const blockCard = blocks.blocks.find(
    (block) => block.type === 'delegated_agent_call',
  );
  for (const displayed of [snapshotCard, pageCard, blockCard]) {
    if (!displayed) throw new Error('Missing displayed card');
    expect(durable(displayed)).toEqual(expected);
    expect(displayed.prompt).toBe(
      options.amended ? 'Amended prompt' : 'Creation prompt',
    );
    expect(displayed.description).toBe('Creation description');
    expect({
      selectedModelId: displayed.selectedModelId,
      runtimeModelId: displayed.runtimeModelId,
      targetHarnessId: displayed.targetHarnessId,
      requestedThinkingLevel: displayed.requestedThinkingLevel,
      effectiveThinkingLevel: displayed.effectiveThinkingLevel,
    }).toEqual(
      options.amended
        ? {
            selectedModelId: 'selected',
            runtimeModelId: 'runtime',
            targetHarnessId: 'codex',
            requestedThinkingLevel: 'high',
            effectiveThinkingLevel: 'medium',
          }
        : {
            selectedModelId: 'creation-model',
            runtimeModelId: '',
            targetHarnessId: '',
            requestedThinkingLevel: undefined,
            effectiveThinkingLevel: undefined,
          },
    );
  }
  expect(
    await fixture.readStoredParentMessage('chat', card.agentBlockId),
  ).toEqual(row(card));
  const recovery = await fixture.repository.getState(fixture.scope, {
    chatIds: ['chat'],
    fullTranscript: true,
    rawStreamCards: true,
  });
  expect(
    recovery.tabsFile.tabs
      .find((tab) => tab.id === 'chat')
      ?.messages.find((message) => message.id === card.agentBlockId),
  ).toEqual(row(card));
  const source = record(
    fixture,
    options.old ? card.runGeneration + 1 : card.runGeneration,
  );
  const metadata = new FixtureDelegationReadMetadata();
  metadata.stream('matrix', {
    originAt: 100,
    lastActivityAt: 200,
    settling: options.settling,
  });
  const input = { record: source, readMetadata: metadata.source(source) };
  const reader = createDelegationRecordReader({
    scope: fixture.scope,
    port: readerPort(fixture, options.transform),
  });
  const header = await reader.resolveGenerationHeader(
    input,
    card.runGeneration,
  );
  const list = await reader.resolveGenerationList(input);
  for (const resolved of [
    header,
    ...list.filter((entry) => entry.runGeneration === card.runGeneration),
  ]) {
    if (resolved.kind !== 'stream' && resolved.kind !== 'settling')
      throw new Error('Missing stream generation');
    expect(durable(resolved.snapshot)).toEqual(
      options.recordExpected ?? expected,
    );
    expect(resolved.stream?.cardState).toEqual(
      (
        await fixture.repository.getChildStreamState(
          fixture.scope,
          fixture.ownedTarget('chat', 'matrix', card.runGeneration),
        )
      )?.cardState,
    );
    expect(resolved.task).toEqual({
      description: 'Creation description',
      prompt: options.amended ? 'Amended prompt' : 'Creation prompt',
      executionMode: 'background',
    });
  }
}

describe('12a S2b desktop reader matrix', () => {
  let root = '';
  let fixture: RepositoryTranscriptPortFixture;
  beforeAll(() => {
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet', contextWindow: 200_000 },
    ]);
    initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 's2b-readers-'));
    fixture = await createRepositoryTranscriptPortFixture(root)();
    const card = rawCard();
    await fixture.repository.transact(
      fixture.scope,
      [{ type: 'message.upserted', chatId: 'chat', message: row(card) }],
      { source: 'provider' },
    );
    value(
      await fixture.port.open({
        target: fixture.ownedTarget('chat', 'matrix', 1),
      }),
    );
    value(
      await fixture.port.registerGeneration({
        chatId: 'chat',
        delegationId: 'matrix',
        runGeneration: 1,
        createdAt: 100,
        store: 'stream',
        origin: { kind: 'launch', anchorMessageId: card.agentBlockId },
        executionMode: 'background',
      }),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });

  describe.each(['open journal', 'cold catalog'] as const)(
    '%s record reads',
    (mode) => {
      describe.each(['null', 'V1', 'V2'] as const)(
        '%s descriptor revision',
        (version) => {
          it.each(['current', 'old', 'settling', 'registry'] as const)(
            'stamps the known descriptor on the transient card and preserves %s precedence',
            async (precedence) => {
              if (precedence === 'registry')
                value(
                  await fixture.port.settle({
                    target: fixture.ownedTarget('chat', 'matrix', 1),
                    settlementKey: 'revision-precedence',
                    resultIndex: 1,
                    outcome: { status: 'completed', finishedAt: 200 },
                    answer: { role: 'final', text: 'Registry answer' },
                    finalChanges: [],
                    cardRevision: 1,
                    cardDraft: draft,
                  }),
                );
              const cardState: CardState | null =
                version === 'null'
                  ? null
                  : version === 'V1'
                    ? {
                        version: 1,
                        status: 'failed',
                        resultIndex: null,
                        error: null,
                        usage: null,
                        workspaceRevision: null,
                        workspaceDiscarded: false,
                        stopOutcome: null,
                        controlOutcome: null,
                        attribution: null,
                        capabilitySummary: null,
                        nestedChildSummary: null,
                        partialPreview: null,
                        finalPreview: 'Descriptor answer',
                      }
                    : {
                        version: 2,
                        cardRevision: 1,
                        status: 'running',
                        outputTruncated: false,
                        canonical: {
                          status: 'failed',
                          resultIndex: 2,
                          answerUnavailable: true,
                        },
                      };
              await fixture.service.getState(fixture.scope);
              if (mode === 'cold catalog') await fixture.noJournal();
              const overlay = jest.spyOn(
                overlayModule,
                'overlayStreamBackedDelegationCard',
              );
              const source = record(fixture, precedence === 'old' ? 2 : 1);
              const metadata = new FixtureDelegationReadMetadata();
              metadata.stream('matrix', {
                originAt: 100,
                lastActivityAt: 200,
                settling:
                  precedence === 'settling' || precedence === 'registry',
              });
              const input = {
                record: source,
                readMetadata: metadata.source(source),
              };
              const reader = createDelegationRecordReader({
                scope: fixture.scope,
                port: readerPort(fixture, (entry) => ({
                  ...entry,
                  stream: entry.stream && {
                    ...entry.stream,
                    streamRevision: 17,
                    cardState,
                  },
                })),
              });
              await reader.resolveGenerationHeader(input, 1);
              overlay.mockClear();
              const revisionBefore = (await fixture.store.indexes()).live
                .revision;
              const filesBefore = await snapshotFormat4Files(root);
              const header = await reader.resolveGenerationHeader(input, 1);
              const list = await reader.resolveGenerationList(input);
              expect((await fixture.store.indexes()).live.revision).toBe(
                revisionBefore,
              );
              expect(await snapshotFormat4Files(root)).toEqual(filesBefore);
              expect(await fixture.store.journalFile()).toEqual(
                mode === 'cold catalog' ? undefined : expect.any(String),
              );
              const expectedStatus =
                precedence === 'registry'
                  ? 'completed'
                  : precedence === 'old'
                    ? 'interrupted'
                    : precedence === 'settling'
                      ? 'running'
                      : version === 'V2'
                        ? 'failed'
                        : 'running';
              for (const resolved of [
                header,
                ...list.filter((entry) => entry.runGeneration === 1),
              ]) {
                expect(resolved).toMatchObject({
                  kind: precedence === 'settling' ? 'settling' : 'stream',
                  stream: { streamRevision: 17, cardState },
                  snapshot: { runGeneration: 1, status: expectedStatus },
                });
                // The hint is display-only, never an AgentDelegationSnapshot field.
                if (resolved.kind === 'stream' || resolved.kind === 'settling')
                  expect(resolved.snapshot).not.toHaveProperty(
                    'streamRevision',
                  );
              }
              // Observe the real shared overlay's output, not a mocked replacement.
              // Null/V1 previously skipped it; V2 previously dropped the revision.
              expect(
                overlay.mock.results.map((result) => {
                  const overlaid: unknown = result.value;
                  return overlaid;
                }),
              ).toEqual([
                expect.objectContaining({ streamRevision: 17 }),
                expect.objectContaining({ streamRevision: 17 }),
              ]);
            },
          );
        },
      );
    },
  );

  it('running: durable descriptor fields override stale record data, but live phase/queue/approval survive', async () => {
    const target = fixture.ownedTarget('chat', 'matrix', 1);
    value(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    await checkReaders(fixture, running, { amended: true });
    const source = record(fixture);
    const metadata = new FixtureDelegationReadMetadata();
    metadata.stream('matrix', { originAt: 100, lastActivityAt: 200 });
    const header = await createDelegationRecordReader({
      scope: fixture.scope,
      port: readerPort(fixture),
    }).resolveGenerationHeader(
      { record: source, readMetadata: metadata.source(source) },
      1,
    );
    expect(header).toMatchObject({
      snapshot: {
        phase: 'running',
        queue: { id: 'default' },
        approvalPending: true,
      },
    });
  });

  it('settling and old generations keep their existing status precedence', async () => {
    value(
      await fixture.port.updateCardState({
        target: fixture.ownedTarget('chat', 'matrix', 1),
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    await checkReaders(fixture, running, { amended: true, settling: true });
    await checkReaders(fixture, running, {
      amended: true,
      old: true,
      recordExpected: { ...running, status: 'interrupted' },
    });
  });

  it('new generation display uses its own descriptor without changing the old raw row', async () => {
    value(
      await fixture.port.updateCardState({
        target: fixture.ownedTarget('chat', 'matrix', 1),
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    const card = rawCard(2);
    await fixture.repository.transact(
      fixture.scope,
      [{ type: 'message.upserted', chatId: 'chat', message: row(card) }],
      { source: 'provider' },
    );
    const target = fixture.ownedTarget('chat', 'matrix', 2);
    value(await fixture.port.open({ target }));
    value(
      await fixture.port.registerGeneration({
        chatId: 'chat',
        delegationId: 'matrix',
        runGeneration: 2,
        createdAt: 200,
        store: 'stream',
        origin: { kind: 'follow_up', anchorMessageId: card.agentBlockId },
        executionMode: 'background',
      }),
    );
    value(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: { ...draft, nativeSessionId: 'generation-two' },
      }),
    );
    await checkReaders(
      fixture,
      { ...running, nativeSessionId: 'generation-two' },
      { amended: true, generation: 2 },
    );
    await checkReaders(fixture, running, {
      amended: true,
      old: true,
      recordExpected: { ...running, status: 'interrupted' },
    });
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    '%s and post-settle metadata share one durable oracle after checkpoint/reopen',
    async (status) => {
      const target = fixture.ownedTarget('chat', 'matrix', 1);
      value(
        await fixture.port.settle({
          target,
          settlementKey: 'settle',
          resultIndex: 1,
          outcome: {
            status,
            finishedAt: 200,
            error: {
              code: 'runtime_error',
              message: 'Durable error text',
              retryable: false,
            },
            usage: { inputTokens: 7, outputTokens: 9 },
          },
          answer: { role: 'final', text: 'Durable final text' },
          finalChanges: [],
          cardRevision: 1,
          cardDraft: draft,
        }),
      );
      const expected = {
        ...running,
        status,
        resultIndex: 1,
        finalText: 'Durable final text',
        error: {
          code: 'runtime_error',
          message: 'Durable error text',
          retryable: false,
        },
        usage: { inputTokens: 7, outputTokens: 9 },
      };
      await checkReaders(fixture, expected, { amended: true });
      // A canonical descriptor remains authoritative even before a locator is visible.
      await checkReaders(fixture, expected, {
        amended: true,
        transform: (entry) => ({ ...entry, result: null }),
      });
      await checkReaders(fixture, expected, {
        amended: true,
        transform: (entry) => ({
          ...entry,
          result: entry.result && {
            ...entry.result,
            resultIndex: 8,
            outcome: { status: 'failed', finishedAt: 201 },
          },
        }),
        recordExpected: {
          ...running,
          status: 'failed',
          resultIndex: 8,
          finalText: 'Durable final text',
        },
      });
      const applied: CardStateDraft = {
        ...draft,
        isolatedWorkspace: {
          revision: 'applied',
          dirtyParentChangesIncluded: false,
        },
        control: {
          operationId: 'apply',
          operation: 'apply',
          status: 'completed',
        },
      };
      value(
        await fixture.port.updateCardState({
          target,
          cardRevision: 2,
          cardDraft: applied,
        }),
      );
      await checkReaders(
        fixture,
        {
          ...expected,
          isolatedWorkspace: {
            revision: 'applied',
            dirtyParentChangesIncluded: false,
          },
          control: {
            operationId: 'apply',
            operation: 'apply',
            status: 'completed',
          },
        },
        { amended: true },
      );
      value(
        await fixture.port.updateCardState({
          target,
          cardRevision: 3,
          cardDraft: {
            ...applied,
            workspaceDiscarded: true,
            control: {
              operationId: 'discard',
              operation: 'discard',
              status: 'completed',
            },
          },
        }),
      );
      await fixture.checkpoint();
      await fixture.reopen();
      await checkReaders(
        fixture,
        {
          ...expected,
          isolatedWorkspace: {
            revision: 'applied',
            dirtyParentChangesIncluded: false,
          },
          workspaceDiscarded: true,
          control: {
            operationId: 'discard',
            operation: 'discard',
            status: 'completed',
          },
        },
        { amended: true },
      );
    },
  );

  it.each(['before locator', 'after apply', 'after discard'] as const)(
    '%s is an independently observed reader state',
    async (stage) => {
      const target = fixture.ownedTarget('chat', 'matrix', 1);
      value(
        await fixture.port.settle({
          target,
          settlementKey: 'independent-state',
          resultIndex: 1,
          outcome: { status: 'completed', finishedAt: 200 },
          answer: { role: 'final', text: 'Durable final text' },
          finalChanges: [],
          cardRevision: 1,
          cardDraft: draft,
        }),
      );
      const settled = {
        ...running,
        status: 'completed',
        resultIndex: 1,
        finalText: 'Durable final text',
      };
      if (stage === 'before locator') {
        await checkReaders(fixture, settled, {
          amended: true,
          transform: (entry) => ({ ...entry, result: null }),
        });
        return;
      }
      const operation = stage === 'after apply' ? 'apply' : 'discard';
      value(
        await fixture.port.updateCardState({
          target,
          cardRevision: 2,
          cardDraft: {
            ...draft,
            workspaceDiscarded: operation === 'discard',
            control: { operationId: operation, operation, status: 'completed' },
          },
        }),
      );
      await fixture.checkpoint();
      await fixture.reopen();
      await checkReaders(
        fixture,
        {
          ...settled,
          workspaceDiscarded: operation === 'discard',
          control: { operationId: operation, operation, status: 'completed' },
        },
        { amended: true },
      );
    },
  );

  it('null and pre-12a V1 retain live metadata precedence while V1 overlays its preview', async () => {
    const creation = {
      status: 'pending',
      outputTruncated: false,
      requestedModelId: 'creation-model',
      nativeSessionId: 'creation-session',
      childDelegationIds: ['creation-child'],
    };
    const retained = {
      status: 'running',
      outputTruncated: false,
      requestedModelId: 'stale-live-model',
      nativeSessionId: 'stale-live-session',
      nestedDelegation: 'not_enabled',
    };
    await checkReaders(fixture, creation, { recordExpected: retained });
    await fixture.updateCardState(fixture.ownedTarget('chat', 'matrix', 1));
    await checkReaders(
      fixture,
      {
        ...creation,
        status: 'completed',
        resultIndex: 1,
        workspaceDiscarded: false,
        finalText: 'Updated by repository conformance fixture',
      },
      {
        recordExpected: {
          ...retained,
          finalText: 'Updated by repository conformance fixture',
        },
      },
    );
  });

  it('primary search overlays transient stream rows before matching; card-text parity stays empty for stream and legacy', async () => {
    value(
      await fixture.port.settle({
        target: fixture.ownedTarget('chat', 'matrix', 1),
        settlementKey: 'search',
        resultIndex: 1,
        outcome: {
          status: 'failed',
          finishedAt: 200,
          error: {
            code: 'runtime_error',
            message: 'Durable error text',
            retryable: false,
          },
        },
        answer: { role: 'final', text: 'Durable final text' },
        finalChanges: [],
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    const overlay = jest.spyOn(
      overlayModule,
      'overlayStreamBackedDelegationCard',
    );
    for (const query of ['Durable final text', 'Durable error text']) {
      expect(
        await fixture.repository.search({
          ...fixture.scope,
          requestId: 'search',
          chatId: 'chat',
          query,
        }),
      ).toEqual({ matches: [], totalCount: 0 });
    }
    expect(overlay).toHaveBeenCalled();
    expect(
      await fixture.repository.search({
        ...fixture.scope,
        requestId: 'search',
        chatId: 'chat',
        query: 'ordinary searchable',
      }),
    ).toEqual({
      matches: [
        { messageId: rawCard().agentBlockId, turnId: 'parent-chat', count: 1 },
      ],
      totalCount: 1,
    });
    const legacy = {
      ...rawCard(),
      transcriptStore: 'chat-log-v1' as const,
      finalText: 'Durable final text',
      error: {
        code: 'runtime_error' as const,
        message: 'Durable error text',
        retryable: false,
      },
    };
    await fixture.repository.transact(
      fixture.scope,
      [{ type: 'message.upserted', chatId: 'chat', message: row(legacy) }],
      { source: 'provider' },
    );
    overlay.mockClear();
    for (const query of ['Durable final text', 'Durable error text'])
      expect(
        await fixture.repository.search({
          ...fixture.scope,
          requestId: 'search',
          chatId: 'chat',
          query,
        }),
      ).toEqual({ matches: [], totalCount: 0 });
    expect(overlay).not.toHaveBeenCalled();
  });
});
