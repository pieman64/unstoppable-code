import { detachInputDelivery } from '../chat-input-delivery';
import type { PersistedChatTab } from '../types';

function tabWithPendingRow(): PersistedChatTab {
  return {
    id: 'chat-source',
    title: 'Source',
    createdAt: '2026-06-01T00:00:00.000Z',
    messages: [],
    inputDelivery: {
      version: 1,
      epoch: 3,
      rows: [
        {
          id: 'row-1',
          revision: 2,
          createdAt: 1,
          text: 'Tighten phase 2.',
          settingsKey: 'settings',
          state: 'pending',
          payload: {
            projectId: 'source-project',
            worktreeId: 'source-worktree',
            chatId: 'chat-source',
            userMessageId: 'user-1',
            text: 'Tighten phase 2.',
            pendingSystemInstructions: [{ id: 'one-shot', text: 'Private' }],
            activePlan: { planId: 'plan-roadmap', viewedRevisionNumber: 1 },
            admittedApproval: { approvalMode: 'ask', sessionApprovalRules: [] },
          },
          attempts: [],
        },
      ],
    },
  };
}

describe('detachInputDelivery', () => {
  it('drops the source worktree plan context from rows copied to another chat', () => {
    const detached = detachInputDelivery(
      tabWithPendingRow(),
      {
        projectId: 'target-project',
        worktreeId: 'target-worktree',
        chatId: 'chat-target',
      },
      () => 'row-copied',
    );

    const [row] = detached?.rows ?? [];
    expect(row?.payload).toMatchObject({
      projectId: 'target-project',
      worktreeId: 'target-worktree',
      chatId: 'chat-target',
      userMessageId: 'row-copied',
    });
    // Plan ids are scoped to the source worktree; a copy must not carry one
    // into another chat's turn.
    expect(row?.payload).not.toHaveProperty('activePlan');
    expect(row?.payload).not.toHaveProperty('pendingSystemInstructions');
    // The source chat's admission limit says nothing about the target chat.
    expect(row?.payload).not.toHaveProperty('admittedApproval');
  });
});

describe('detachInputDelivery generated rows', () => {
  type Ledger = Extract<PersistedChatTab['inputDelivery'], { version: 1 }>;
  type Row = Ledger['rows'][number];
  type Payload = Row['payload'];
  const target = {
    projectId: 'target-project',
    worktreeId: 'target-worktree',
    chatId: 'chat-target',
  };
  const base: Payload = {
    projectId: 'source-project',
    worktreeId: 'source-worktree',
    chatId: 'chat-source',
    userMessageId: 'user-1',
    text: 'Canopy watcher fired.',
  };
  const generated: Array<[string, Partial<Payload>]> = [
    ['watcher', { watcherFired: { kind: 'Delegate watch completed' } }],
    ['delegation', { managedDelegationDeliveryId: 'delivery-1' }],
    ['async answer', { asyncQuestionId: 'question-1' }],
    [
      'automation',
      { initiationSource: 'automation', automationName: 'Nightly' },
    ],
  ];
  const states: Row['state'][] = [
    'sending',
    'pending',
    'cancelling',
    'editing',
    'cancelled',
    'uncertain',
    'queued',
  ];

  function source(
    state: Row['state'],
    patch: Partial<Payload>,
  ): PersistedChatTab {
    return {
      ...tabWithPendingRow(),
      inputDelivery: {
        version: 1 as const,
        epoch: 1,
        rows: [
          {
            id: 'row-1',
            revision: 3,
            createdAt: 1,
            text: 'Canopy watcher fired.',
            settingsKey: 'settings',
            state,
            payload: { ...base, ...patch },
            attempts: [],
          },
        ],
      },
    };
  }

  // The source chat owns its watchers, delegates, questions and automations;
  // an undelivered event of theirs is not a message the copy's user sent.
  it.each(
    generated.flatMap(([kind, patch]) =>
      states.map((state) => [kind, state, patch] as const),
    ),
  )('drops an undelivered %s row in state %s', (_kind, state, patch) => {
    const detached = detachInputDelivery(
      source(state, patch),
      target,
      () => 'copy',
    );
    expect(detached && 'rows' in detached ? detached.rows : []).toEqual([]);
  });

  it.each(generated)('keeps a picked-up %s row as history', (_kind, patch) => {
    const detached = detachInputDelivery(
      source('picked-up', patch),
      target,
      () => 'copy',
    );
    expect(detached && 'rows' in detached ? detached.rows : []).toHaveLength(1);
  });

  it('keeps an undelivered ordinary row', () => {
    const detached = detachInputDelivery(
      source('queued', {}),
      target,
      () => 'copy',
    );
    const rows = detached && 'rows' in detached ? detached.rows : [];
    expect(rows.map((row) => row.state)).toEqual(['cancelled']);
  });
});

it('drops main-only saved merge snapshots on detach', () => {
  const tab = tabWithPendingRow();
  Object.assign(tab.inputDelivery?.rows[0]?.payload ?? {}, {
    watcherPartSnapshots: [
      { userMessageId: 'notice', kind: 'Delegate finished', text: 'Private' },
    ],
  });
  const detached = detachInputDelivery(
    tab,
    { projectId: 'target', worktreeId: 'target', chatId: 'target' },
    () => 'copied',
  );
  expect(detached?.rows[0]?.payload).not.toHaveProperty('watcherPartSnapshots');
});
