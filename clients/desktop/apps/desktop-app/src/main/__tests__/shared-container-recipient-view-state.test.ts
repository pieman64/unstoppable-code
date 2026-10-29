import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { removeTreeWithoutAsar } from '../lib/remove-tree-without-asar';

const mockDeleteScope = jest.fn<Promise<void>, [unknown]>();
const mockRemoveWorktreeData = jest.fn<
  Promise<void>,
  [string, string, unknown]
>();

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { deleteScope: typeof mockDeleteScope } => ({
    deleteScope: mockDeleteScope,
  }),
}));

jest.mock('@canopy/desktop-shared/node/lib/worktree-data-cleanup', () => ({
  removePersistedWorktreeDataDirectory: (
    projectId: string,
    worktreeId: string,
    options: unknown,
  ): Promise<void> => mockRemoveWorktreeData(projectId, worktreeId, options),
}));

jest.mock('../lib/paths', () => ({
  getWorktreeDataRootDir: (projectId: string): string =>
    `/data/workspaces/${projectId}/worktree-data`,
}));

import { cleanupSharedContainerRecipientViewState } from '../shared-containers/recipient-view-state';

describe('shared-container recipient view-state cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeleteScope.mockResolvedValue();
    mockRemoveWorktreeData.mockResolvedValue();
  });

  it('deletes the canonical chat closure before removing local view state', async () => {
    await cleanupSharedContainerRecipientViewState('container-1');

    expect(mockDeleteScope).toHaveBeenCalledWith({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container-1',
    });
    expect(mockRemoveWorktreeData).toHaveBeenCalledWith(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      'container-1',
      {
        worktreeDataRootDir:
          '/data/workspaces/shared-container-viewer/worktree-data',
        removeTree: removeTreeWithoutAsar,
      },
    );
    expect(mockDeleteScope.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoveWorktreeData.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
