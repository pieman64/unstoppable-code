import type * as FsPromises from 'node:fs/promises';
const mockStat = jest.fn<ReturnType<typeof FsPromises.stat>, [string]>();
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromises>('node:fs/promises'),
  stat: (path: string): ReturnType<typeof FsPromises.stat> => mockStat(path),
}));
import {
  delegationRecoveryMutations,
  hasDelegationRecoveryRecords,
  loadDelegationRecoveryMutations,
} from '../agents/delegation/recovery';
import { setDelegationActivity } from '../agents/delegation/activity';
import type { StoredDelegation } from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import type { ChatTabsFile } from '@canopy/desktop-shared/types';
import { routeFixture } from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/fixtures';

const record: StoredDelegation = {
  version: 1,
  parent: {
    harnessId: 'codex',
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'c',
    turnId: 'u',
    toolCallId: 'call',
    sessionKey: 'p/w/c',
    runtimeGeneration: 1,
    depth: 0,
  },
  task: {
    modelId: 'logical-review-model',
    description: 'Review',
    prompt: 'Inspect source',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
    executionMode: 'background',
  },
  route: routeFixture(),
  callKey: 'key',
  requestHash: 'hash',
  createdAt: 100,
  deadlineAt: 200,
  state: {
    delegationId: 'child',
    runGeneration: 1,
    sequence: 3,
    status: 'running',
    approvalPending: true,
    outputTruncated: false,
    nativeSessionId: 'native-child',
    transcript: [
      {
        id: 'answer',
        type: 'text',
        text: 'Retained finding',
        sequence: 1,
        occurredAt: 110,
      },
    ],
  },
  launch: {
    version: 1,
    delegationId: 'child',
    runGeneration: 1,
    launchKey: 'key',
    phase: 'identified',
    nativeSessionId: 'native-child',
  },
  delivery: { status: 'unclaimed' },
};
const tabs: ChatTabsFile = {
  version: 1,
  activeTabId: 'c',
  tabs: [
    {
      id: 'c',
      title: 'Review',
      createdAt: '2026-09-11T00:00:00.000Z',
      messages: [
        {
          id: 'u',
          role: 'user',
          timestamp: 90,
          blocks: [{ type: 'text', text: 'Review' }],
        },
      ],
    },
  ],
};

it('keeps optional recovery preflight failures from blocking chat loading', async () => {
  const failure = Object.assign(new Error('registry unavailable'), {
    code: 'EACCES',
  });
  mockStat.mockRejectedValueOnce(failure);
  await expect(
    hasDelegationRecoveryRecords({ projectId: 'p', worktreeId: 'w' }),
  ).resolves.toBe(false);
});

it.each([
  'running',
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
] as const)(
  'recovers %s evidence without a parent turn or delivery claim',
  (status) => {
    const retained = { ...record, state: { ...record.state, status } };
    const before = JSON.stringify(retained);
    const mutations = delegationRecoveryMutations(
      { projectId: 'p', worktreeId: 'w' },
      tabs,
      { version: 1, archived: [] },
      [retained],
    );
    expect(mutations).toHaveLength(1);
    const mutation = mutations[0];
    expect(mutation).toMatchObject({ type: 'messages.replaced', chatId: 'c' });
    if (mutation.type !== 'messages.replaced')
      throw new Error('Expected recovered messages');
    expect(
      mutation.messages
        .flatMap((message) => message.blocks)
        .find((block) => block.type === 'delegated_agent_call'),
    ).toMatchObject({
      status: status === 'running' ? 'interrupted' : status,
      approvalPending: false,
      nativeSessionId: 'native-child',
    });
    expect(
      mutation.messages.find(
        (message) => message.parentBlockId === 'delegated-agent-child',
      )?.blocks,
    ).toEqual([{ type: 'text', text: 'Retained finding' }]);
    expect(JSON.stringify(mutations)).not.toContain('private-account');
    expect(JSON.stringify(retained)).toBe(before);
  },
);

it('does not resurrect cleared turns or import another worktree’s evidence', () => {
  expect(
    delegationRecoveryMutations(
      { projectId: 'p', worktreeId: 'other' },
      tabs,
      { version: 1, archived: [] },
      [record],
    ),
  ).toEqual([]);
  expect(
    delegationRecoveryMutations(
      { projectId: 'p', worktreeId: 'w' },
      { ...tabs, tabs: tabs.tabs.map((tab) => ({ ...tab, messages: [] })) },
      { version: 1, archived: [] },
      [record],
    ),
  ).toEqual([]);
});

it('recovers an older Codex record through its native tool call when no host message tag was stored', () => {
  const historicalTabs: ChatTabsFile = {
    ...tabs,
    tabs: tabs.tabs.map((tab) => ({
      ...tab,
      messages: [
        ...tab.messages,
        {
          id: 'tool',
          role: 'assistant' as const,
          timestamp: 95,
          blocks: [
            {
              type: 'tool_use' as const,
              toolUseId: 'call',
              toolName: 'spawn',
              input: '{}',
            },
          ],
        },
      ],
    })),
  };
  const mutations = delegationRecoveryMutations(
    { projectId: 'p', worktreeId: 'w' },
    historicalTabs,
    { version: 1, archived: [] },
    [
      {
        ...record,
        parent: { ...record.parent, turnId: 'native-provider-turn' },
      },
    ],
  );
  expect(mutations).toHaveLength(1);
  const mutation = mutations[0];
  if (mutation.type !== 'messages.replaced')
    throw new Error('Expected recovered messages');
  expect(
    mutation.messages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'delegated_agent_call'),
  ).toMatchObject({ parentTurnId: 'u' });
});

it('recovers every retained generation in order without losing newer host-only metadata', () => {
  const route = record.route;
  if (!route) throw new Error('Missing route fixture');
  const publicRoute = { ...route };
  delete publicRoute.authAccountKey;
  const retained: StoredDelegation = {
    ...record,
    notificationOnly: true,
    transcriptRevision: 11,
    state: { ...record.state, status: 'completed', runGeneration: 2 },
    history: [
      {
        delegationId: 'child',
        runGeneration: 1,
        sequence: 3,
        parentHarnessId: 'codex',
        parentTurnId: 'u',
        parentToolCallId: 'first-call',
        createdAt: 90,
        task: record.task,
        transcript: [],
        snapshot: {
          delegationId: 'child',
          runGeneration: 1,
          status: 'completed',
          routeSnapshot: publicRoute,
          outputTruncated: false,
          finalText: 'First result',
        },
      },
    ],
  };
  const mutation = delegationRecoveryMutations(
    { projectId: 'p', worktreeId: 'w' },
    tabs,
    { version: 1, archived: [] },
    [retained],
  )[0];
  if (mutation.type !== 'messages.replaced')
    throw new Error('Expected messages');
  const blocks = mutation.messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === 'delegated_agent_call');
  expect(blocks.map((block) => block.runGeneration)).toEqual([1, 2]);
  expect(blocks[1]).toMatchObject({ sequence: 11 });
  expect(blocks[1]).not.toHaveProperty('nativeSessionId');
  expect(JSON.stringify(blocks)).not.toContain('authAccountKey');
});

it('cancels a delegation that was still queued for a slot, without an uncertain-interruption error', () => {
  const queued: StoredDelegation = {
    ...record,
    state: { ...record.state, status: 'pending' },
    admission: { runGeneration: 1, state: 'waiting', queuedAt: 90 },
    launch: { ...record.launch, phase: 'reserved' },
  };
  const mutations = delegationRecoveryMutations(
    { projectId: 'p', worktreeId: 'w' },
    tabs,
    { version: 1, archived: [] },
    [queued],
  );
  expect(mutations).toHaveLength(1);
  const mutation = mutations[0];
  if (mutation.type !== 'messages.replaced')
    throw new Error('Expected recovered messages');
  const block = mutation.messages
    .flatMap((message) => message.blocks)
    .find((entry) => entry.type === 'delegated_agent_call');
  expect(block).toMatchObject({
    status: 'cancelled',
    stopReason: 'shutdown',
    cancelledByUser: false,
    error: undefined,
  });
});

it('cancels a delegation that was reserved but never dispatched, even without a queue admission record', () => {
  const neverDispatched: StoredDelegation = {
    ...record,
    state: { ...record.state, status: 'pending' },
    launch: { ...record.launch, phase: 'reserved' },
  };
  const mutations = delegationRecoveryMutations(
    { projectId: 'p', worktreeId: 'w' },
    tabs,
    { version: 1, archived: [] },
    [neverDispatched],
  );
  expect(mutations).toHaveLength(1);
  const mutation = mutations[0];
  if (mutation.type !== 'messages.replaced')
    throw new Error('Expected recovered messages');
  const block = mutation.messages
    .flatMap((message) => message.blocks)
    .find((entry) => entry.type === 'delegated_agent_call');
  expect(block).toMatchObject({
    status: 'cancelled',
    stopReason: 'shutdown',
    cancelledByUser: false,
    error: undefined,
  });
});

it('reports a dispatched pending delegation as interrupted with launch_uncertain, not cancelled', () => {
  const dispatched: StoredDelegation = {
    ...record,
    state: { ...record.state, status: 'pending' },
    launch: { ...record.launch, phase: 'starting' },
  };
  const mutations = delegationRecoveryMutations(
    { projectId: 'p', worktreeId: 'w' },
    tabs,
    { version: 1, archived: [] },
    [dispatched],
  );
  expect(mutations).toHaveLength(1);
  const mutation = mutations[0];
  if (mutation.type !== 'messages.replaced')
    throw new Error('Expected recovered messages');
  const block = mutation.messages
    .flatMap((message) => message.blocks)
    .find((entry) => entry.type === 'delegated_agent_call');
  expect(block).toMatchObject({
    status: 'interrupted',
    error: { code: 'launch_uncertain' },
  });
});

it('leaves a live queued delegation’s chat card untouched', async () => {
  const queued: StoredDelegation = {
    ...record,
    state: { ...record.state, status: 'pending' },
    admission: { runGeneration: 1, state: 'waiting', queuedAt: 90 },
    launch: { ...record.launch, phase: 'reserved' },
  };
  mockStat.mockResolvedValueOnce(
    await jest
      .requireActual<typeof FsPromises>('node:fs/promises')
      .stat(process.cwd()),
  );
  const load = jest
    .spyOn(FileDelegationStorage.prototype, 'load')
    .mockResolvedValueOnce([queued]);
  setDelegationActivity('recovery-owner', queued.parent.sessionKey, 0, 1);
  try {
    await expect(
      loadDelegationRecoveryMutations(
        { projectId: 'p', worktreeId: 'w' },
        tabs,
        { version: 1, archived: [] },
      ),
    ).resolves.toEqual([]);
  } finally {
    setDelegationActivity('recovery-owner', queued.parent.sessionKey, 0, 0);
    load.mockRestore();
  }
});

it('recovers a logged card as a card patch, leaving its children in the delegate log', () => {
  const [card] = delegationRecoveryMutations(
    { projectId: 'p', worktreeId: 'w' },
    tabs,
    { version: 1, archived: [] },
    [{ ...record, state: { ...record.state, status: 'completed' } }],
  );
  if (card?.type !== 'messages.replaced') throw new Error('Expected a card');
  const recoveredCard = card.messages.find((message) =>
    message.blocks.some((block) => block.type === 'delegated_agent_call'),
  );
  if (!recoveredCard) throw new Error('Expected the recovered card');
  // The chat now holds that card, written with a delegate log.
  const logged: ChatTabsFile = {
    ...tabs,
    tabs: [
      {
        ...tabs.tabs[0],
        messages: [
          ...tabs.tabs[0].messages,
          {
            ...recoveredCard,
            blocks: recoveredCard.blocks.map((block) =>
              block.type === 'delegated_agent_call'
                ? { ...block, sequence: 1, transcriptStore: 'chat-log-v1' }
                : block,
            ),
          },
        ],
      },
    ],
  };
  const mutations = delegationRecoveryMutations(
    { projectId: 'p', worktreeId: 'w' },
    logged,
    { version: 1, archived: [] },
    [record],
  );
  expect(mutations).toHaveLength(1);
  const mutation = mutations[0];
  if (mutation?.type !== 'messages.replaced')
    throw new Error('Expected a replacement');
  expect(
    mutation.messages.filter(
      (message) => message.parentBlockId === 'delegated-agent-child',
    ),
  ).toEqual([]);
  const recovered = mutation.messages
    .flatMap((message) => message.blocks)
    .find((block) => block.type === 'delegated_agent_call');
  expect(recovered).toEqual(
    expect.objectContaining({
      status: 'interrupted',
      transcriptStore: 'chat-log-v1',
    }),
  );
  expect(recovered).not.toHaveProperty('approvalPending');
});

it('keeps an earlier legacy generation legacy when a later one is logged', () => {
  const scope = { projectId: 'p', worktreeId: 'w' };
  const archives = { version: 1 as const, archived: [] };
  // The parent's last commit of the first generation lags its final record.
  const first: StoredDelegation = {
    ...record,
    state: { ...record.state, sequence: 2, status: 'completed' },
  };
  const [legacy] = delegationRecoveryMutations(scope, tabs, archives, [first]);
  if (legacy?.type !== 'messages.replaced')
    throw new Error('Expected the first generation');
  const second: StoredDelegation = {
    ...record,
    state: {
      ...record.state,
      runGeneration: 2,
      sequence: 1,
      status: 'completed',
      transcript: [
        {
          id: 'second',
          type: 'text',
          text: 'Second finding',
          sequence: 1,
          occurredAt: 120,
        },
      ],
    },
    launch: { ...record.launch, runGeneration: 2 },
    history: [
      {
        delegationId: 'child',
        runGeneration: 1,
        sequence: 3,
        parentHarnessId: 'codex',
        parentTurnId: 'u',
        parentToolCallId: 'call',
        createdAt: 100,
        task: {
          description: 'Review',
          prompt: 'Inspect source',
          executionMode: 'background',
        },
        snapshot: {
          delegationId: 'child',
          status: 'completed',
          outputTruncated: false,
          routeSnapshot: routeFixture(),
        },
        transcript: first.state.transcript ?? [],
      },
    ],
  };
  const withLegacy: ChatTabsFile = {
    ...tabs,
    tabs: [{ ...tabs.tabs[0], messages: legacy.messages }],
  };
  const [both] = delegationRecoveryMutations(scope, withLegacy, archives, [
    second,
  ]);
  if (both?.type !== 'messages.replaced')
    throw new Error('Expected the second generation');
  // The chat holds the lagging legacy first generation and the second
  // generation's card, whose children are in the delegate log.
  const secondCard = both.messages.find((message) =>
    message.blocks.some(
      (block) =>
        block.type === 'delegated_agent_call' && block.runGeneration === 2,
    ),
  );
  if (!secondCard) throw new Error('Expected the second card');
  const mixed: ChatTabsFile = {
    ...tabs,
    tabs: [
      {
        ...tabs.tabs[0],
        messages: [
          ...legacy.messages,
          {
            ...secondCard,
            blocks: secondCard.blocks.map((block) =>
              block.type === 'delegated_agent_call'
                ? { ...block, transcriptStore: 'chat-log-v1' as const }
                : block,
            ),
          },
        ],
      },
    ],
  };
  const [recovered] = delegationRecoveryMutations(scope, mixed, archives, [
    { ...second, state: { ...second.state, status: 'running' } },
  ]);
  if (recovered?.type !== 'messages.replaced')
    throw new Error('Expected a replacement');
  const cards = recovered.messages
    .flatMap((message) => message.blocks)
    .filter((block) => block.type === 'delegated_agent_call');
  expect(
    cards.map((card) =>
      card.type === 'delegated_agent_call'
        ? [card.runGeneration, card.transcriptStore]
        : [],
    ),
  ).toEqual([
    [1, undefined],
    [2, 'chat-log-v1'],
  ]);
  // The legacy generation still renders from its child rows.
  expect(
    recovered.messages.some((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.text === 'Retained finding',
      ),
    ),
  ).toBe(true);
});
