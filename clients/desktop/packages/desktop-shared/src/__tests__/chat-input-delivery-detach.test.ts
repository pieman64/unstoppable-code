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
  });
});
