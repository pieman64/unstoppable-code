/**
 * Navigation to a freshly forked container (CAN-2552).
 *
 * Two things here are ordering hazards rather than routing preferences:
 *
 * - The sidebar reload has to complete BEFORE the selection. Main created the
 *   workspace after the renderer's last listing, so selecting first points
 *   chat state at a row the store has never seen.
 * - A Cowork fork keys as `(workspaceId, entryId)` with the entry id in the
 *   `worktreeId` slot, and lands on the 'chat' page. Routing it through
 *   `selectWorktree` would look plausible and select nothing.
 *
 * This file mocks the chat store wholesale, so it structurally cannot observe
 * the stale-`chatProjects` bug that made a forked workspace unselectable. The
 * real coverage for that lives in
 * `stores/__tests__/standaloneChatStore.test.ts` ('standaloneChatStore sidebar
 * multi-project'), against `switchChatProject`'s own listing. What this file
 * does own is the contract that a failed navigation propagates rather than
 * resolving quietly — which is what makes the caller-side toasts necessary.
 */
const loadProjects = jest.fn(() => Promise.resolve());
const selectWorktree = jest.fn();
const navigate = jest.fn();
const openWorkEntryFromSidebar = jest.fn(() => Promise.resolve());
const order: string[] = [];

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): unknown => ({
      loadProjects: (...args: unknown[]): Promise<void> => {
        order.push('loadProjects');
        return loadProjects(...args);
      },
    }),
  },
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => ({
      selectWorktree: (...args: unknown[]): void => {
        order.push('selectWorktree');
        selectWorktree(...args);
      },
    }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: { getState: (): unknown => ({ navigate }) },
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): unknown => ({ openWorkEntryFromSidebar }),
  },
}));

import { openForkedContainer } from '../open-forked-container';

const PROVENANCE = {
  sourceContainerId: 'container-1',
  sourceRevisionId: 'revision-1',
  sourceOwnerDisplayName: 'Dana',
  organizationId: 'org-1',
  forkedAt: '2026-09-09T10:00:00.000Z',
};

beforeEach(() => {
  order.length = 0;
  jest.clearAllMocks();
});

describe('openForkedContainer', () => {
  it('reloads the sidebar before selecting a forked worktree', async () => {
    await openForkedContainer({
      containerType: 'CODE_WORKTREE',
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      warnings: [],
      provenance: PROVENANCE,
    });

    expect(order).toEqual(['loadProjects', 'selectWorktree']);
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
    expect(selectWorktree).toHaveBeenCalledWith('workspace-1', 'worktree-1');
    expect(navigate).toHaveBeenCalledWith('main');
  });

  it('opens a Cowork fork as a Work Entry on the chat page', async () => {
    await openForkedContainer({
      containerType: 'COWORK_WORK_ENTRY',
      projectId: 'cowork-1',
      worktreeId: 'entry-1',
      warnings: [],
      provenance: PROVENANCE,
    });

    expect(openWorkEntryFromSidebar).toHaveBeenCalledWith(
      'cowork-1',
      'entry-1',
    );
    expect(selectWorktree).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('chat');
  });

  it('propagates a failed Cowork selection instead of navigating anyway', async () => {
    openWorkEntryFromSidebar.mockRejectedValueOnce(
      new Error('Chat project not found'),
    );

    await expect(
      openForkedContainer({
        containerType: 'COWORK_WORK_ENTRY',
        projectId: 'cowork-1',
        worktreeId: 'entry-1',
        warnings: [],
        provenance: PROVENANCE,
      }),
    ).rejects.toThrow('Chat project not found');

    // Navigating to a page that would render the previously active workspace
    // is worse than staying put: it looks like the copy opened.
    expect(navigate).not.toHaveBeenCalled();
  });
});
