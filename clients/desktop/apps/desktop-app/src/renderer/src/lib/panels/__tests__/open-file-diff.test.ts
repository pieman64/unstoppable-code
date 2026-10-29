/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { openFileInDiff } from '../open-file-diff';
import { useChatStore } from '@/stores/chatStore';
import type * as ChatStoreModule from '@/stores/chatStore';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
jest.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: jest.fn() },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: () => ({ addToast: jest.fn() }) },
}));
jest.mock('../chat-panel-sync', () => ({
  requestFilePanelPlacementAsSibling: jest.fn(),
  requestFilePanelPlacementBesideChat: jest.fn(),
}));
it('opens a scoped file comparison with a JSON-safe context and immutable turn refs', async () => {
  const setFileTabViewMode = jest.fn();
  const openFileTab = jest.fn(() => 'file-tab');
  const actualStore =
    jest.requireActual<typeof ChatStoreModule>(
      '@/stores/chatStore',
    ).useChatStore;
  jest.mocked(useChatStore.getState).mockReturnValue({
    ...actualStore.getState(),
    openFileTab,
    setFileTabViewMode,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getWorktreePath: jest.fn().mockResolvedValue('/repo') },
  });
  const scope = { projectId: 'project', worktreeId: 'worktree' };
  const file = {
    path: 'deleted.ts',
    status: 'deleted' as const,
    insertions: 0,
    deletions: 1,
  };
  await openFileInDiff(scope, file, 'uncommitted');
  const context = setFileTabViewMode.mock.calls[0][3];
  expect(context).toEqual({ path: 'deleted.ts', source: 'uncommitted' });
  expect(context).toStrictEqual(JSON.parse(JSON.stringify(context)));
  expect(openFileTab).toHaveBeenCalledWith(
    { absolutePath: '/repo/deleted.ts', filename: 'deleted.ts' },
    scope,
  );
  await openFileInDiff(scope, file, 'combined', undefined, {
    files: [file],
    totalInsertions: 0,
    totalDeletions: 1,
    capturedAt: 1,
    treeRefs: [{ startTree: 'before', endTree: 'after' }],
  });
  expect(setFileTabViewMode).toHaveBeenLastCalledWith(
    'file-tab',
    'diff',
    scope,
    {
      path: 'deleted.ts',
      source: 'turn',
      startTree: 'before',
      endTree: 'after',
      turnDiff: expect.objectContaining({ files: [file] }),
    },
  );
});

it('opens recipient diffs from the sealed replica root instead of the run copy', async () => {
  const setFileTabViewMode = jest.fn();
  const openFileTab = jest.fn(() => 'recipient-file-tab');
  const actualStore =
    jest.requireActual<typeof ChatStoreModule>(
      '@/stores/chatStore',
    ).useChatStore;
  jest.mocked(useChatStore.getState).mockReturnValue({
    ...actualStore.getState(),
    openFileTab,
    setFileTabViewMode,
  });
  const getWorktreePath = jest.fn();
  const getFileTreeRoots = jest.fn().mockResolvedValue({
    roots: [
      {
        repoId: 'repo-1',
        repoName: 'recipient-fixture',
        absolutePath: '/sealed/revisions/revision-1/repos/repo-1',
        rootKind: 'repository',
      },
    ],
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { getWorktreePath, getFileTreeRoots },
  });

  const scope = {
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: 'container-1',
  };
  await openFileInDiff(
    scope,
    {
      path: 'committed-change.ts',
      status: 'modified',
      insertions: 1,
      deletions: 1,
      repoId: 'repo-1',
    },
    'committed',
  );

  expect(getFileTreeRoots).toHaveBeenCalledWith(scope);
  expect(getWorktreePath).not.toHaveBeenCalled();
  expect(openFileTab).toHaveBeenCalledWith(
    {
      absolutePath:
        '/sealed/revisions/revision-1/repos/repo-1/committed-change.ts',
      filename: 'committed-change.ts',
    },
    scope,
  );
});
