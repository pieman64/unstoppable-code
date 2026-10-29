/** @jest-environment jsdom */
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

it('reports script review counts and target without commands or source text', () => {
  const result = buildCurrentUiStateSnapshot({
    'scriptActions.active': {
      projectId: 'p',
      worktreeId: 'w',
      pendingCount: 3,
      approvedCount: 2,
      dismissedCount: 1,
      scanStatus: 'complete',
      command: 'secret command',
    },
    'scriptActions.review': {
      projectId: 'p',
      worktreeId: 'w',
      sourceText: 'secret file',
    },
  });
  expect(result.scriptActions).toEqual({
    projectId: 'p',
    worktreeId: 'w',
    pendingCount: 3,
    approvedCount: 2,
    dismissedCount: 1,
    scanStatus: 'complete',
  });
  expect(result.scriptActionsReview).toEqual({
    projectId: 'p',
    worktreeId: 'w',
  });
  expect(JSON.stringify(result)).not.toContain('secret');
});
