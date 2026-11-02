import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  delegationBlockId,
  type DelegationChildRow,
  type PersistedChatMessage,
} from '@canopy/agent-transcript';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import { FixtureDelegationReadMetadata } from '@canopy/desktop-shared/node/delegation/testing/record-read-metadata-fixture';
import type { DelegationTranscriptTarget } from '@canopy/desktop-shared/node/delegation/transcript-port';
import { projectAgentRoute } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type { ChildStreamCompatibilityPageRequest } from '../agents/delegation/record-reader-contract';
import { createDelegationRecordReader } from '../agents/delegation/record-reader';
import {
  configureManagedDelegationReaders,
  readManagedDelegationRootsForUser,
  readManagedDelegationTranscriptForUser,
  readManagedDelegationTreeForUser,
} from '../agents/delegation/service';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';

// The service reaches the stored compatibility page through this facade; route
// it to the real format-4 repository fixture under test.
let mockFixture: RepositoryTranscriptPortFixture | undefined;
let mockDataRoot = '';
jest.mock('../lib/paths', () => {
  const actual = jest.requireActual<object>('../lib/paths');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      getWorktreeDataDir: {
        value: (projectId: string, worktreeId: string): string =>
          `${mockDataRoot}/${projectId}/${worktreeId}`,
        enumerable: true,
      },
    },
  );
});
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../services/chat-state-service', () => {
  const actual = jest.requireActual<object>('../services/chat-state-service');
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      getChatStateService: {
        value: (): object => ({
          subscribe: (): (() => void) => () => undefined,
          childStreamCompatibilityPage: (
            scope: ChatScopeKey,
            request: ChildStreamCompatibilityPageRequest,
          ): Promise<unknown> => {
            if (!mockFixture) throw new Error('No repository fixture');
            return mockFixture.service.childStreamCompatibilityPage(
              scope,
              request,
            );
          },
        }),
        enumerable: true,
      },
    },
  );
});

const chatId = 'chat';
const delegationId = 'child';

function streamTarget(runGeneration: number): DelegationTranscriptTarget {
  return { kind: 'delegation', chatId, delegationId, runGeneration };
}

function cardMessage(
  messageId: string,
  runGeneration: number,
  description: string,
): PersistedChatMessage {
  return {
    id: messageId,
    role: 'assistant',
    timestamp: 100 + runGeneration,
    blocks: [
      {
        type: 'delegated_agent_call',
        agentBlockId: delegationBlockId(delegationId, runGeneration),
        delegationId,
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
        description,
        prompt: `${description} prompt`,
        executionMode: 'foreground',
        status: 'running',
        outputTruncated: false,
      },
    ],
  };
}

function textRow(
  id: string,
  text: string,
  sequence: number,
): DelegationChildRow {
  return {
    // Production child rows carry their card's block id as an id prefix.
    id: `${delegationBlockId(delegationId, 2)}:${id}`,
    role: 'assistant',
    timestamp: 120 + sequence,
    parentBlockId: delegationBlockId(delegationId, 2),
    delegationSequence: sequence,
    delegationSegment: 'segment-1',
    blocks: [{ type: 'text', text }],
    itemRevision: 0,
    final: true,
  };
}

function storedRecord(scope: ChatScopeKey): StoredDelegation {
  return {
    version: 2,
    parent: {
      harnessId: 'codex',
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId,
      turnId: 'turn',
      toolCallId: 'call',
      sessionKey: `${scope.projectId}/${scope.worktreeId}/${chatId}`,
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'logical-model',
      description: 'Stale record task',
      prompt: 'Stale record prompt',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
      executionMode: 'background',
    },
    callKey: 'call-key',
    requestHash: 'request-hash',
    createdAt: 100,
    state: {
      delegationId,
      runGeneration: 2,
      sequence: 4,
      status: 'running',
      outputTruncated: false,
    },
    delivery: { status: 'unclaimed' },
    launch: {
      version: 1,
      delegationId,
      launchKey: 'call-key',
      runGeneration: 2,
      phase: 'starting',
    },
    history: [],
  };
}

function successValue<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('stream-backed managed delegation readers over the real repository', () => {
  let root: string;
  let fixture: RepositoryTranscriptPortFixture;
  let record: StoredDelegation;
  let restore: () => void;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'delegation-real-reader-'));
    mockDataRoot = join(root, 'data');
    fixture = await createRepositoryTranscriptPortFixture(join(root, 'repo'))();
    mockFixture = fixture;
    const scope = fixture.scope;
    await fixture.repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId,
          message: cardMessage('card-1', 1, 'First run'),
        },
        {
          type: 'message.upserted',
          chatId,
          message: cardMessage('card-2', 2, 'Second run'),
        },
      ],
      { source: 'provider' },
    );
    for (const [runGeneration, anchorMessageId] of [
      [1, 'card-1'],
      [2, 'card-2'],
    ] as const)
      successValue(
        await fixture.port.registerGeneration({
          chatId,
          delegationId,
          runGeneration,
          createdAt: 100 + runGeneration,
          store: 'stream',
          origin: {
            kind: runGeneration === 1 ? 'launch' : 'follow_up',
            anchorMessageId,
          },
          executionMode: 'foreground',
        }),
      );
    const current = streamTarget(2);
    successValue(await fixture.port.open({ target: current }));
    successValue(
      await fixture.port.appendChanges({
        target: current,
        mutationKey: 'rows',
        changes: [
          { row: textRow('row-1', 'first answer', 1) },
          { row: textRow('row-2', 'second answer', 2) },
        ],
      }),
    );
    successValue(
      await fixture.port.settle({
        target: current,
        settlementKey: 'settle-2',
        resultIndex: 1,
        outcome: { status: 'completed', startedAt: 110, finishedAt: 456 },
        finalChanges: [],
        answer: null,
      }),
    );

    record = storedRecord(scope);
    jest
      .spyOn(FileDelegationStorage.prototype, 'load')
      .mockResolvedValue([record]);
    jest
      .spyOn(FileDelegationStorage.prototype, 'loadOne')
      .mockResolvedValue(record);
    const metadata = new FixtureDelegationReadMetadata();
    metadata.stream(delegationId, { originAt: 50, lastActivityAt: 125 });
    restore = configureManagedDelegationReaders({
      readMetadata: metadata.source,
      reader: createDelegationRecordReader({ port: fixture.repository, scope }),
    });
  }, 60_000);

  afterAll(async () => {
    restore?.();
    jest.restoreAllMocks();
    await fixture?.close();
    await rm(root, { recursive: true, force: true });
  });

  function chatTarget(): {
    projectId: string;
    worktreeId: string;
    chatId: string;
  } {
    return { ...fixture.scope, chatId };
  }

  it('lists each generation with its own card task and the canonical outcome', async () => {
    const tree = await readManagedDelegationTreeForUser(chatTarget());
    expect(tree).toHaveLength(2);
    expect(tree[0]).toMatchObject({
      runGeneration: 1,
      description: 'First run',
      prompt: 'First run prompt',
      snapshot: { runGeneration: 1, status: 'interrupted' },
    });
    expect(tree[1]).toMatchObject({
      runGeneration: 2,
      description: 'Second run',
      prompt: 'Second run prompt',
      runStartedAt: 110,
      runSettledAt: 456,
      snapshot: { runGeneration: 2, status: 'completed', resultIndex: 1 },
    });
    expect(JSON.stringify(tree)).not.toContain('Stale record');
  });

  it('pages stored rows through the real compatibility page at the descriptor revision', async () => {
    const state = await fixture.repository.getChildStreamState(
      fixture.scope,
      streamTarget(2),
    );
    const page = await readManagedDelegationTranscriptForUser({
      ...chatTarget(),
      delegationId,
    });
    expect(page).toMatchObject({
      ok: true,
      runGeneration: 2,
      revision: state?.streamRevision,
      hasMore: false,
      task: { description: 'Second run' },
    });
    expect(
      page.ok && page.items.map((item) => item.type === 'text' && item.text),
    ).toEqual(['first answer', 'second answer']);
    await expect(
      readManagedDelegationTranscriptForUser({
        ...chatTarget(),
        delegationId,
        sinceRevision: state?.streamRevision,
      }),
    ).resolves.toMatchObject({ ok: true, unchanged: true, items: [] });
  });

  it('serves a stream-less historical generation as an empty page and a missing one as not found', async () => {
    await expect(
      readManagedDelegationTranscriptForUser({
        ...chatTarget(),
        delegationId,
        runGeneration: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      runGeneration: 1,
      items: [],
      hasMore: false,
    });
    await expect(
      readManagedDelegationTranscriptForUser({
        ...chatTarget(),
        delegationId,
        runGeneration: 3,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
  });

  it('derives roots activity from the capsule and the current descriptor', async () => {
    const state = await fixture.repository.getChildStreamState(
      fixture.scope,
      streamTarget(2),
    );
    const roots = await readManagedDelegationRootsForUser(fixture.scope);
    expect(roots).toEqual([
      expect.objectContaining({
        chatId,
        total: 1,
        lastActivityAt: Math.max(
          125,
          state?.openedAt ?? 0,
          state?.latestRowTimestamp ?? 0,
        ),
      }),
    ]);
  });

  it('returns to the unchanged legacy readers once the injection is disposed', async () => {
    restore();
    try {
      const tree = await readManagedDelegationTreeForUser(chatTarget());
      expect(tree).toEqual([
        expect.objectContaining({
          runGeneration: 2,
          description: 'Stale record task',
        }),
      ]);
    } finally {
      const metadata = new FixtureDelegationReadMetadata();
      metadata.stream(delegationId, { originAt: 50, lastActivityAt: 125 });
      restore = configureManagedDelegationReaders({
        readMetadata: metadata.source,
        reader: createDelegationRecordReader({
          port: fixture.repository,
          scope: fixture.scope,
        }),
      });
    }
  });
});
