import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryDelegationTranscriptPort } from '@canopy/desktop-shared/node/delegation/in-memory-transcript-port';
import type {
  DelegationTranscriptPort,
  DelegationTranscriptPortResult,
  DelegationTranscriptSettleAnswer,
  DelegationTranscriptSettleRequest,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import type {
  CardStateDraft,
  CardStateCanonical,
} from '@canopy/protocol/canopy-core';
import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';
import type { DeltaJournalCommitInput } from '../lib/chat-delta-journal/writer';
import { chatChildDeleteFence } from '../lib/chat-child-delete-fence';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStateService } from '../services/chat-state-service';
import { RepositoryDelegationTranscriptPort } from '../agents/delegation/repository-transcript-port';
import { scopeSource } from './helpers/chat-delta-journal-harness';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';

jest.setTimeout(120_000);
const draft: CardStateDraft = {
  version: 2,
  status: 'running',
  outputTruncated: false,
  prompt: 'Amended',
};
const route: NonNullable<CardStateDraft['routeSnapshot']> = {
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
};
function value<T>(result: DelegationTranscriptPortResult<T>): T {
  expect(result.ok ? undefined : result.error).toBeUndefined();
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
function settle(
  target: DelegationTranscriptTarget,
  answer: DelegationTranscriptSettleAnswer = { role: 'final', text: 'abc' },
): DelegationTranscriptSettleRequest {
  return {
    target,
    settlementKey: 'settle',
    resultIndex: 1,
    outcome: { status: 'completed', finishedAt: 5 },
    answer,
    finalChanges: [],
  };
}

describe('12a S2a durable card-state rules', () => {
  let root = '';
  let fixture: RepositoryTranscriptPortFixture;
  beforeAll(() => {
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 200_000 },
    ]);
    initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 's2a-card-'));
    fixture = await createRepositoryTranscriptPortFixture(root)();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });

  it('E5 descriptor commits use zero parent writes, no forced checkpoint or rewrite diagnostic, and persist bytes', async () => {
    const target = fixture.ownedTarget('chat', 'io', 1);
    value(await fixture.port.open({ target }));
    const commit = jest.spyOn(ChatDeltaJournalWriter.prototype, 'commit');
    const checkpoint = jest.spyOn(
      ChatStateV2Backend.prototype,
      'checkpointPendingJournal',
    );
    const forcedCheckpoint = jest.spyOn(ChatStateV2Backend.prototype, 'flush');
    const events: unknown[] = [];
    const diagnostics: unknown[] = [];
    fixture.repository.subscribeStorageDiagnostics((diagnostic) => {
      diagnostics.push(diagnostic);
    });
    fixture.service.subscribe((event) => {
      events.push(event);
    });
    const state = value(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    expect(state).toMatchObject({
      streamRevision: 1,
      cardState: { ...draft, cardRevision: 1 },
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({
      writes: [],
      streamDescriptorUpdates: [
        { target, update: { cardState: { ...draft, cardRevision: 1 } } },
      ],
    });
    expect(checkpoint.mock.calls).toEqual([]);
    expect(forcedCheckpoint).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics)).not.toContain(
      'chat_transcript_full_rewrite',
    );
    expect(JSON.stringify(events)).not.toContain('message.upserted');
    const journal = await fixture.store.journalFile();
    expect(journal).toBeDefined();
    if (journal === undefined) throw new Error('Expected journal');
    expect(
      await readFile(join(fixture.store.directory, journal), 'utf8'),
    ).toContain('Amended');
    await fixture.checkpoint();
    await fixture.reopen();
    expect(value(await fixture.port.open({ target })).cardState).toEqual({
      ...draft,
      cardRevision: 1,
    });
  });

  it('E5/E6 freezes content across failed apply, successful apply, discard, replay, checkpoint and reopen', async () => {
    const target = fixture.ownedTarget('chat', 'freeze', 1);
    value(await fixture.port.open({ target }));
    value(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    const accepted = value(
      await fixture.port.settle({
        ...settle(target),
        finalChanges: [
          {
            row: {
              id: 'final-row',
              role: 'assistant',
              timestamp: 4,
              parentBlockId: 'parent',
              delegationSequence: 1,
              blocks: [{ type: 'text', text: 'abc' }],
              itemRevision: 0,
              final: true,
            },
          },
        ],
        cardDraft: draft,
        cardRevision: 1,
      }),
    );
    const canonical = value(await fixture.port.open({ target })).cardState;
    expect(canonical).toMatchObject({
      version: 2,
      canonical: {
        status: 'completed',
        resultIndex: 1,
        finalText: 'abc',
        finalTextRef: {
          sha256:
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
          byteLength: 3,
        },
      },
    });
    const updates: CardStateDraft[] = [
      {
        ...draft,
        control: {
          operationId: 'apply',
          operation: 'apply',
          status: 'failed',
          error: 'Nope',
        },
      },
      {
        ...draft,
        control: {
          operationId: 'apply',
          operation: 'apply',
          status: 'completed',
        },
        isolatedWorkspace: {
          revision: 'applied',
          dirtyParentChangesIncluded: false,
        },
      },
      {
        ...draft,
        workspaceDiscarded: true,
        control: {
          operationId: 'discard',
          operation: 'discard',
          status: 'completed',
        },
      },
    ];
    for (let index = 0; index < updates.length; index += 1) {
      const cardDraft = updates[index];
      if (cardDraft === undefined) throw new Error('Missing update');
      const next = value(
        await fixture.port.updateCardState({
          target,
          cardRevision: index + 2,
          cardDraft,
        }),
      );
      expect(next.cardState?.version === 2 && next.cardState.canonical).toEqual(
        canonical?.version === 2 ? canonical.canonical : undefined,
      );
      const page = value(
        await fixture.port.page({
          target,
          streamRevision: accepted.settlement.contentRevision,
        }),
      );
      expect(page.streamRevision).toBe(accepted.settlement.contentRevision);
      expect(page.rows[0]?.blocks).toEqual([{ type: 'text', text: 'abc' }]);
    }
    expect(
      await fixture.port.updateCardState({
        target,
        cardRevision: 5,
        cardDraft: { ...draft, prompt: 'Changed' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
    const before = value(await fixture.port.open({ target }));
    expect(
      value(
        await fixture.port.updateCardState({
          target,
          cardRevision: 4,
          cardDraft: updates[2] ?? draft,
        }),
      ),
    ).toEqual(before);
    await fixture.checkpoint();
    await fixture.reopen();
    const replayRequest: DelegationTranscriptSettleRequest = {
      ...settle(target),
      finalChanges: [
        {
          row: {
            id: 'final-row',
            role: 'assistant',
            timestamp: 4,
            parentBlockId: 'parent',
            delegationSequence: 1,
            blocks: [{ type: 'text', text: 'abc' }],
            itemRevision: 0,
            final: true,
          },
        },
      ],
    };
    const replay = value(
      await fixture.port.settle({
        ...replayRequest,
        cardRevision: -1,
        cardDraft: { ...draft, prompt: 'Ignored malformed replay' },
      }),
    );
    expect(replay).toEqual({
      ...accepted,
      settlement: { ...accepted.settlement, replayed: true },
    });
    expect(value(await fixture.port.open({ target }))).toEqual(before);
    expect(
      value(
        await fixture.port.resultAnswerRange({
          chatId: target.chatId,
          delegationId: target.delegationId,
          resultIndex: 1,
          offset: 0,
          limit: 4,
        }),
      ).text,
    ).toBe('abc');
    expect(
      await fixture.port.settle({
        ...replayRequest,
        answer: { role: 'final', text: 'different' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(
      value(
        await fixture.port.result({
          chatId: target.chatId,
          delegationId: target.delegationId,
          resultIndex: 1,
        }),
      ),
    ).toEqual(accepted.result);
  });

  it('E5 equivalence table runs unchanged through both ports', async () => {
    const target = fixture.ownedTarget('chat', 'equivalence', 1);
    const memory = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    async function operations(
      port: DelegationTranscriptPort,
    ): Promise<unknown[]> {
      const observed: unknown[] = [];
      value(await port.open({ target }));
      for (const [cardRevision, cardDraft] of [
        [1, { ...draft, status: 'pending' }],
        [2, draft],
        [1, draft],
        [2, draft],
        [2, { ...draft, workspaceDiscarded: true }],
        [3, { ...draft, status: 'pending' }],
        [3, { version: 2, status: 'running', outputTruncated: false }],
        [3, { ...draft, prompt: 'Wrong' }],
        [3, { ...draft, childDelegationIds: ['child'] }],
        [Number.MAX_SAFE_INTEGER + 1, draft],
      ] satisfies [number, CardStateDraft][]) {
        const result = await port.updateCardState({
          target,
          cardRevision,
          cardDraft,
        });
        observed.push(
          result.ok
            ? {
                streamRevision: result.value.streamRevision,
                cardState: result.value.cardState,
              }
            : result.error.code,
        );
      }
      value(await port.settle(settle(target, null)));
      for (const [cardRevision, cardDraft] of [
        [
          4,
          { ...draft, childDelegationIds: ['child'], workspaceDiscarded: true },
        ],
        [5, { ...draft, status: 'pending' }],
        [5, { ...draft, outputTruncated: true }],
      ] satisfies [number, CardStateDraft][]) {
        const result = await port.updateCardState({
          target,
          cardRevision,
          cardDraft,
        });
        observed.push(
          result.ok
            ? {
                streamRevision: result.value.streamRevision,
                cardState: result.value.cardState,
              }
            : result.error.code,
        );
      }
      return observed;
    }
    const expected = await operations(memory);
    expect(await operations(fixture.port)).toEqual(expected);
    expect(expected.slice(2, 8)).toEqual([
      'stale_identity',
      { streamRevision: 2, cardState: { ...draft, cardRevision: 2 } },
      'conflict',
      'stale_identity',
      'stale_identity',
      'stale_identity',
    ]);
  });

  it('E5 canonical-only settle accepts a first later baseline but freezes subsequent drafts', async () => {
    const target = fixture.ownedTarget('chat', 'baseline', 1);
    value(await fixture.port.open({ target }));
    value(await fixture.port.settle(settle(target, null)));
    value(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    await fixture.checkpoint();
    await fixture.reopen();
    expect(
      await fixture.port.updateCardState({
        target,
        cardRevision: 2,
        cardDraft: { ...draft, nativeSessionId: 'changed' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
    expect(value(await fixture.port.open({ target })).cardState).toEqual({
      ...draft,
      cardRevision: 1,
      canonical: { status: 'completed', resultIndex: 1 },
    });
  });

  it('E5 retained route, requested model and prompt sources cannot disappear after reopen', async () => {
    const target = fixture.ownedTarget('chat', 'presence', 1);
    value(await fixture.port.open({ target }));
    const stored: CardStateDraft = {
      ...draft,
      requestedModelId: 'requested',
      routeSnapshot: route,
    };
    value(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: stored,
      }),
    );
    await fixture.checkpoint();
    await fixture.reopen();
    for (const cardDraft of [
      { ...draft, requestedModelId: 'requested' },
      { ...draft, routeSnapshot: route },
      {
        version: 2,
        status: 'running',
        outputTruncated: false,
        requestedModelId: 'requested',
        routeSnapshot: route,
      },
    ] satisfies CardStateDraft[]) {
      expect(
        await fixture.port.updateCardState({
          target,
          cardRevision: 2,
          cardDraft,
        }),
      ).toMatchObject({ ok: false, error: { code: 'stale_identity' } });
    }
    expect(value(await fixture.port.open({ target })).cardState).toEqual({
      ...stored,
      cardRevision: 1,
    });
  });

  it('E5 deletion at the descriptor publication boundary fails closed', async () => {
    const target = fixture.ownedTarget('chat', 'delete-race', 1);
    value(await fixture.port.open({ target }));
    const fence = chatChildDeleteFence(
      join(fixture.store.directory, 'transcripts'),
    );
    let retired: Promise<number> | undefined;
    const commit = jest.spyOn(ChatDeltaJournalWriter.prototype, 'commit');
    const original = commit.getMockImplementation();
    if (original === undefined)
      throw new Error('Commit implementation missing');
    commit.mockImplementationOnce(function (
      this: ChatDeltaJournalWriter,
      input,
    ) {
      retired = fence.retire('chat');
      return original.call(this, input);
    });
    try {
      expect(
        await fixture.port.updateCardState({
          target,
          cardRevision: 1,
          cardDraft: draft,
        }),
      ).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(commit).toHaveBeenCalledTimes(1);
      expect(retired).toBeDefined();
      await retired;
    } finally {
      fence.restore('chat');
    }
    expect(value(await fixture.port.open({ target })).cardState).toBeNull();
  });

  it('E5 a rejecting repository commit observer cannot reject durable publication', async () => {
    const target = fixture.ownedTarget('chat', 'observer', 1);
    value(await fixture.port.open({ target }));
    const observer = jest.fn(
      (): Promise<void> => Promise.reject(new Error('Observer failed')),
    );
    fixture.repository.setCommitListener(observer);
    const accepted = value(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    expect(observer).toHaveBeenCalledTimes(1);
    await fixture.checkpoint();
    await fixture.reopen();
    expect(value(await fixture.port.open({ target })).cardState).toEqual(
      accepted.cardState,
    );
  });

  it('E5 a format-3 repository rejects descriptor publication through the port', async () => {
    const directory = join(root, 'format3');
    const store = new ChatStorageV2(directory, 'scope');
    await store.migrate(
      scopeSource(['chat'].map((id) => ({ id, messages: [] }))),
    );
    const backend = new ChatStateV2Backend(store, { deltaJournal: {} });
    await backend.promoteToDeltaJournal();
    backend.releaseJournal();
    await backend.disposeArtifactMaintenance();
    const repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(directory, 'scope.json'),
        archives: join(directory, 'archives.json'),
        journal: join(directory, 'journal.json'),
      }),
      // The option would promote this scope to format 4 at load.
    });
    const service = new ChatStateService({
      repository,
      recordDiagnostic: jest.fn(),
    });
    try {
      const port = new RepositoryDelegationTranscriptPort(
        service,
        fixture.scope,
      );
      expect(
        await port.updateCardState({
          target: fixture.ownedTarget('chat', 'format3', 1),
          cardRevision: 1,
          cardDraft: draft,
        }),
      ).toMatchObject({ ok: false, error: { code: 'unsupported_format' } });
    } finally {
      await repository.drainAll();
    }
  });

  it('E6 generic raw journal replay still compares cardState integrity', async () => {
    const target = fixture.ownedTarget('chat', 'integrity', 1);
    value(await fixture.port.open({ target }));
    let captured:
      | { writer: ChatDeltaJournalWriter; input: DeltaJournalCommitInput }
      | undefined;
    const commit = jest.spyOn(ChatDeltaJournalWriter.prototype, 'commit');
    const original = commit.getMockImplementation();
    if (original === undefined)
      throw new Error('Commit implementation missing');
    commit.mockImplementationOnce(function (
      this: ChatDeltaJournalWriter,
      input,
    ) {
      captured = { writer: this, input };
      return original.call(this, input);
    });
    value(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: draft,
      }),
    );
    if (captured === undefined)
      throw new Error('Descriptor commit was not captured');
    const { writer, input } = captured;
    await expect(writer.commit(input)).resolves.toMatchObject({
      applied: false,
    });
    await expect(
      writer.commit({
        ...input,
        streamDescriptorUpdates: input.streamDescriptorUpdates?.map(
          (entry) => ({
            ...entry,
            update: {
              ...entry.update,
              cardState: { ...draft, cardRevision: 1, prompt: 'Different' },
            },
          }),
        ),
      }),
    ).rejects.toThrow();
  });

  it('E5 rejects unknown generation, unauthorized scope, deletion and counter exhaustion', async () => {
    const target = fixture.ownedTarget('chat', 'fences', 1);
    value(await fixture.port.open({ target }));
    expect(
      await fixture.port.updateCardState({
        target: { ...target, runGeneration: 2 },
        cardRevision: 1,
        cardDraft: draft,
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(
      await fixture.port.updateCardState({
        target: fixture.foreignTarget,
        cardRevision: 1,
        cardDraft: draft,
      }),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    value(
      await fixture.port.updateCardState({
        target,
        cardRevision: Number.MAX_SAFE_INTEGER,
        cardDraft: draft,
      }),
    );
    expect(
      await fixture.port.updateCardState({
        target,
        cardRevision: Number.MAX_SAFE_INTEGER + 1,
        cardDraft: draft,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    if (fixture.removeChat === undefined)
      throw new Error('Removal hook missing');
    await fixture.removeChat('chat');
    expect(
      await fixture.port.updateCardState({
        target,
        cardRevision: 1,
        cardDraft: draft,
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it.each(['follow_up', 'resume', 'steer', 'apply', 'discard'] as const)(
    'E5 settled failed %s metadata is allowed without changing content',
    async (operation) => {
      const target = fixture.ownedTarget('chat', 'control', 1);
      value(await fixture.port.open({ target }));
      value(
        await fixture.port.updateCardState({
          target,
          cardRevision: 1,
          cardDraft: draft,
        }),
      );
      const accepted = value(await fixture.port.settle(settle(target)));
      const control = {
        operationId: 'operation',
        operation,
        status: 'failed' as const,
        error: 'Failure',
      };
      const state = value(
        await fixture.port.updateCardState({
          target,
          cardRevision: 2,
          cardDraft: { ...draft, control },
        }),
      );
      expect(state.cardState).toMatchObject({
        control,
        canonical: { status: 'completed', finalText: 'abc' },
      });
      expect(value(await fixture.port.settle(settle(target))).result).toEqual(
        accepted.result,
      );
    },
  );

  it.each([
    ['none', undefined, undefined, 3, draft],
    ['stale', { ...draft, childDelegationIds: ['stale'] }, 2, 3, draft],
    ['tie', { ...draft, childDelegationIds: ['tie'] }, 3, 3, draft],
    [
      'newer',
      { ...draft, childDelegationIds: ['newer'] },
      4,
      4,
      { ...draft, childDelegationIds: ['newer'] },
    ],
    [
      'drops prompt',
      { version: 2, status: 'running', outputTruncated: false },
      4,
      3,
      draft,
    ],
    ['regresses status', { ...draft, status: 'pending' }, 4, 3, draft],
    ['locked prompt', { ...draft, prompt: 'Changed' }, 4, 3, draft],
  ] satisfies [
    string,
    CardStateDraft | undefined,
    number | undefined,
    number,
    CardStateDraft,
  ][])(
    'E6 first settle selects %s supplied draft without failing settlement',
    async (_name, cardDraft, cardRevision, expectedRevision, expectedDraft) => {
      const target = fixture.ownedTarget('chat', 'choice', 1);
      value(await fixture.port.open({ target }));
      value(
        await fixture.port.updateCardState({
          target,
          cardRevision: 3,
          cardDraft: draft,
        }),
      );
      value(
        await fixture.port.settle({
          ...settle(target, null),
          cardDraft,
          cardRevision,
        }),
      );
      expect(value(await fixture.port.open({ target })).cardState).toEqual({
        ...expectedDraft,
        cardRevision: expectedRevision,
        canonical: { status: 'completed', resultIndex: 1 },
      });
    },
  );

  it.each([
    { cardDraft: draft },
    { cardRevision: 2 },
    { cardRevision: -1, cardDraft: draft },
    { cardRevision: Number.MAX_SAFE_INTEGER + 1, cardDraft: draft },
    {
      cardRevision: 1,
      cardDraft: { ...draft, nativeSessionId: 'x'.repeat(1025) },
    },
  ] satisfies Partial<DelegationTranscriptSettleRequest>[])(
    'E6 invalid card metadata rejects without consuming the result and keyed replay ignores it (%j)',
    async (metadata) => {
      const target = fixture.ownedTarget('chat', 'validation', 1);
      value(await fixture.port.open({ target }));
      expect(
        await fixture.port.settle({ ...settle(target), ...metadata }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      expect(value(await fixture.port.open({ target })).status).toBe('open');
      const accepted = value(await fixture.port.settle(settle(target)));
      const replay = value(
        await fixture.port.settle({ ...settle(target), ...metadata }),
      );
      expect(replay.result).toEqual(accepted.result);
      expect(replay.settlement.replayed).toBe(true);
    },
  );

  it.each([
    [null, { status: 'completed', resultIndex: 1 }],
    [
      { role: 'final', text: '' },
      { status: 'completed', resultIndex: 1, finalText: '' },
    ],
    [
      { role: 'partial', text: '' },
      { status: 'completed', resultIndex: 1, partialText: '' },
    ],
    [
      { role: 'final', text: 'abc' },
      { status: 'completed', resultIndex: 1, finalText: 'abc' },
    ],
    [
      { role: 'partial', text: 'abc' },
      { status: 'completed', resultIndex: 1, partialText: 'abc' },
    ],
    [
      { role: 'partial', lost: { sha256: 'a'.repeat(64), length: 3 } },
      { status: 'completed', resultIndex: 1, answerUnavailable: true },
    ],
  ] satisfies [DelegationTranscriptSettleAnswer, CardStateCanonical][])(
    'E6 canonical coherence for answer %j',
    async (answer, expected) => {
      const target = fixture.ownedTarget('chat', 'answer', 1);
      value(await fixture.port.open({ target }));
      const result = value(await fixture.port.settle(settle(target, answer)));
      await fixture.checkpoint();
      await fixture.reopen();
      const card = value(await fixture.port.open({ target })).cardState;
      expect(card?.version).toBe(2);
      if (card?.version !== 2) throw new Error('Expected V2 card');
      const canonical = { ...card.canonical };
      if (result.result.answer.kind === 'body') {
        expect(answer).not.toBeNull();
        if (answer !== null && answer.role === 'final') {
          expect(canonical.finalTextRef).toEqual(result.result.answer.ref);
          delete canonical.finalTextRef;
        } else {
          expect(canonical.partialTextRef).toEqual(result.result.answer.ref);
          delete canonical.partialTextRef;
        }
      }
      expect(canonical).toEqual(expected);
    },
  );

  it.each([
    'registry-answer-published',
    'registry-settle-admitted',
    'finalize-artifact',
    'finalize-journal',
  ] as const)(
    'E6 fault at %s has no pre-durable terminal state and keyed replay converges',
    async (boundary) => {
      const target = fixture.ownedTarget('chat', 'fault', 1);
      value(await fixture.port.open({ target }));
      value(
        await fixture.port.updateCardState({
          target,
          cardRevision: 1,
          cardDraft: draft,
        }),
      );
      value(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'open-row',
          changes: [
            {
              row: {
                id: 'row',
                role: 'assistant',
                timestamp: 1,
                parentBlockId: 'parent',
                delegationSequence: 1,
                blocks: [{ type: 'text', text: 'open' }],
                itemRevision: 0,
                final: false,
              },
            },
          ],
        }),
      );
      const seen: string[] = [];
      const commit = jest.spyOn(
        ChatDeltaJournalWriter.prototype,
        'settleDelegationResult',
      );
      if (
        boundary === 'registry-answer-published' ||
        boundary === 'registry-settle-admitted'
      )
        fixture.injectRegistryFailure(boundary);
      else {
        if (fixture.injectRegistryFault === undefined)
          throw new Error('Fault hook missing');
        await fixture.injectRegistryFault(boundary);
      }
      const request = {
        ...settle(target),
        openRows: 'finalize' as const,
        cardDraft: draft,
        cardRevision: 1,
      };
      const failed = await fixture.port.settle(request);
      expect(failed).toMatchObject({
        ok: false,
        error: { code: 'storage_failure' },
      });
      // The armed one-shot fault must have been reached: a storage failure is
      // not sufficient without the writer's injected boundary error.
      const first = commit.mock.results[0];
      if (first?.type !== 'return') throw new Error('Writer was not called');
      await expect(first.value).rejects.toThrow(boundary);
      seen.push(boundary);
      expect(seen).toEqual([boundary]);
      const stored = value(await fixture.port.open({ target }));
      expect(stored.status).toBe(
        boundary === 'registry-settle-admitted' ? 'settled' : 'open',
      );
      expect(
        stored.cardState?.version === 2 &&
          stored.cardState.canonical !== undefined,
      ).toBe(boundary === 'registry-settle-admitted');
      await fixture.reopen();
      const replay = value(await fixture.port.settle(request));
      expect(replay.settlement.replayed).toBe(
        boundary === 'registry-settle-admitted',
      );
      const final = value(await fixture.port.open({ target }));
      expect(final.cardState).toMatchObject({
        ...draft,
        canonical: { status: 'completed', finalText: 'abc', resultIndex: 1 },
      });
    },
  );

  it('E6 canonical fitting preserves the execution draft, accepted answer, error, usage and attribution', async () => {
    const target = fixture.ownedTarget('chat', 'fitting', 1);
    value(await fixture.port.open({ target }));
    const cardDraft: CardStateDraft = {
      ...draft,
      cancelledByUser: true,
      stoppedBy: { kind: 'user' },
    };
    const request: DelegationTranscriptSettleRequest = {
      ...settle(target, { role: 'partial', text: '\u0000'.repeat(9000) }),
      outcome: {
        status: 'cancelled',
        finishedAt: 2,
        error: {
          code: 'runtime_error',
          message: '\u0000'.repeat(1000),
          retryable: false,
        },
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 4,
          costUsd: 0.5,
        },
        stopReason: 'user_cancelled',
      },
      cardDraft,
      cardRevision: 1,
    };
    const accepted = value(await fixture.port.settle(request));
    await fixture.checkpoint();
    await fixture.reopen();
    const card = value(await fixture.port.open({ target })).cardState;
    expect(card).toEqual({
      ...cardDraft,
      cardRevision: 1,
      canonical: {
        status: 'cancelled',
        resultIndex: 1,
        error: {
          code: 'runtime_error',
          message: '\u0000'.repeat(682),
          retryable: false,
        },
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 4,
          costUsd: 0.5,
        },
        stopReason: 'user_cancelled',
        partialText: '\u0000'.repeat(8192),
        detailOmitted: true,
        partialTextRef:
          accepted.result.answer.kind === 'body'
            ? accepted.result.answer.ref
            : undefined,
      },
    });
    expect(accepted.result.outcome).toEqual(request.outcome);
    expect(value(await fixture.port.settle(request)).result).toEqual(
      accepted.result,
    );
    expect(
      value(
        await fixture.port.resultAnswerRange({
          chatId: target.chatId,
          delegationId: target.delegationId,
          resultIndex: 1,
          offset: 0,
          limit: 9000,
        }),
      ).text,
    ).toBe('\u0000'.repeat(9000));
  });
});
