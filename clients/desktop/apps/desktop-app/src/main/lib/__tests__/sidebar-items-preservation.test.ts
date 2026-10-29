import { getSidebarItemsPreserveWorkspaceIds } from '../sidebar-items-preservation';

describe('getSidebarItemsPreserveWorkspaceIds', () => {
  it('unions load warnings with save-result preservation ids', () => {
    expect(
      getSidebarItemsPreserveWorkspaceIds({
        warnings: [
          {
            code: 'workspace-load-failed',
            workspaceId: 'failed',
            workspaceName: 'Failed',
            reason: 'transient failure',
          },
        ],
        preservedWorkspaceIds: ['preserved', 'failed'],
      }),
    ).toEqual(['preserved', 'failed']);
  });
});
