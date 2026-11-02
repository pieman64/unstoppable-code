import type { PendingPlanExit } from '@/stores/chatStore';
import { resolveComposerPendingPlanExit } from '../resolveComposerPendingPlanExit';

const scope = { projectId: 'project', worktreeId: 'waiting-worktree' };
const tab = {
  id: 'same-chat-id',
  pendingPlanExit: { plan: 'Restored proposal' },
};
const foreign: PendingPlanExit = {
  requestId: 'foreign-request',
  projectId: 'project',
  worktreeId: 'selected-worktree',
  chatId: tab.id,
  source: 'claude',
  toolInput: { plan: 'Another proposal' },
};

it('uses the live exit in the composer scope when another worktree reuses the chat id', () => {
  const own = { ...foreign, ...scope, requestId: 'own-request' };
  expect(resolveComposerPendingPlanExit(tab, scope, { foreign, own })).toBe(
    own,
  );
});

it('restores only this tab in its own scope despite a selected-worktree exit', () => {
  expect(resolveComposerPendingPlanExit(tab, scope, { foreign })).toEqual({
    ...scope,
    chatId: tab.id,
    requestId: '',
    source: 'claude',
    toolInput: tab.pendingPlanExit,
  });
});

it('does not borrow another scope or invent waiting state', () => {
  expect(
    resolveComposerPendingPlanExit({ id: tab.id }, scope, { foreign }),
  ).toBeNull();
  expect(resolveComposerPendingPlanExit(tab, null, { foreign })).toBeNull();
  expect(resolveComposerPendingPlanExit(null, scope, { foreign })).toBeNull();
});
