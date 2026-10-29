/** @jest-environment jsdom */
import { useCodeReviewStore } from '../codeReviewStore';
import { openFileInDiff } from '@/lib/panels/open-file-diff';
import { openChangeDiagram } from '@/lib/panels/chat-panel-sync';
jest.mock('@/lib/panels/open-file-diff', () => ({ openFileInDiff: jest.fn() }));
jest.mock('@/lib/panels/chat-panel-sync', () => ({
  openChangeDiagram: jest.fn(),
}));
it('routes legacy navigation to workspace panels without arming or creating a chat', async () => {
  const scope = { projectId: 'project', worktreeId: 'worktree' };
  const file = {
    path: 'old.ts',
    status: 'deleted' as const,
    insertions: 0,
    deletions: 2,
  };
  await useCodeReviewStore.getState().openCodeReview(scope, { arm: true });
  expect(openChangeDiagram).toHaveBeenCalledWith('project/worktree');
  await useCodeReviewStore
    .getState()
    .openCodeReview(scope, { initialFile: file, initialSource: 'committed' });
  expect(openFileInDiff).toHaveBeenCalledWith(scope, file, 'committed');
});
