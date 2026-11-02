/**
 * @jest-environment jsdom
 */
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: null });
  useProjectsStore.setState({ projects: [] });
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
});

describe('buildCurrentUiStateSnapshot delegate lifetime limit', () => {
  it('reports the Settings lifetime limit with the managed delegation policy', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.managedDelegation': {
        loaded: true,
        mode: 'explicit-only',
        maxDepth: 2,
        lifetimeLimit: 512,
        revocationIncomplete: false,
      },
    });
    expect(snapshot.settings?.managedDelegation?.lifetimeLimit).toBe(512);
  });

  it('reports the Subagents panel lifetime notice as status fields only', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'subagents.lifetimeLimit': {
        projectId: 'p-1',
        worktreeId: 'w-1',
        notice: 'full_at_cap',
        atLimit: true,
        limit: 512,
        canExtend: false,
        refusedChatIds: ['c-1'],
      },
    });
    expect(snapshot.subagentsLifetimeLimit).toEqual({
      projectId: 'p-1',
      worktreeId: 'w-1',
      notice: 'full_at_cap',
      atLimit: true,
      limit: 512,
      canExtend: false,
    });
  });

  it('keeps unknown counts as null and drops a malformed notice', () => {
    expect(
      buildCurrentUiStateSnapshot({
        'subagents.lifetimeLimit': {
          projectId: 'p-1',
          worktreeId: 'w-1',
          notice: 'unavailable',
          canExtend: false,
        },
      }).subagentsLifetimeLimit,
    ).toEqual({
      projectId: 'p-1',
      worktreeId: 'w-1',
      notice: 'unavailable',
      atLimit: null,
      limit: null,
      canExtend: false,
    });
    expect(
      buildCurrentUiStateSnapshot({
        'subagents.lifetimeLimit': {
          projectId: 'p-1',
          worktreeId: 'w-1',
          notice: 'limit reached',
          canExtend: true,
        },
      }).subagentsLifetimeLimit,
    ).toBeUndefined();
    expect(
      buildCurrentUiStateSnapshot({}).subagentsLifetimeLimit,
    ).toBeUndefined();
  });
});
