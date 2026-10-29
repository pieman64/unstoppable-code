import {
  isWorktreeSurfaceVisible,
  type WorktreeSurfaceVisibilityInput,
} from '../worktreeSurfaceVisibility';

const ON_SCREEN: WorktreeSurfaceVisibilityInput = {
  activePage: 'main',
  settingsOpen: false,
  splitLocked: false,
  archivedViewerOpen: false,
  archivedOverviewOpen: false,
  sharedContainerPastSharesOpen: false,
  sharedContainerViewerOpen: false,
};

describe('isWorktreeSurfaceVisible', () => {
  it('is visible on the main and kanban pages with nothing covering it', () => {
    expect(isWorktreeSurfaceVisible(ON_SCREEN)).toBe(true);
    expect(
      isWorktreeSurfaceVisible({ ...ON_SCREEN, activePage: 'kanban' }),
    ).toBe(true);
  });

  it.each([
    'feed',
    'plugins',
    'pipelines',
    'workflows',
    'chat',
    'home',
    'overview',
  ] as const)('is hidden on the %s page', (activePage) => {
    expect(isWorktreeSurfaceVisible({ ...ON_SCREEN, activePage })).toBe(false);
  });

  it('is hidden while Settings or a split workflow covers it', () => {
    expect(isWorktreeSurfaceVisible({ ...ON_SCREEN, settingsOpen: true })).toBe(
      false,
    );
    expect(isWorktreeSurfaceVisible({ ...ON_SCREEN, splitLocked: true })).toBe(
      false,
    );
  });

  // Each of these renders as a full-surface overlay above the panel grid. A
  // native Browser view in the grid would otherwise stay painted over it.
  it.each([
    'archivedViewerOpen',
    'archivedOverviewOpen',
    'sharedContainerPastSharesOpen',
    'sharedContainerViewerOpen',
  ] as const)('is hidden while the %s overlay covers it', (overlay) => {
    expect(isWorktreeSurfaceVisible({ ...ON_SCREEN, [overlay]: true })).toBe(
      false,
    );
  });
});
