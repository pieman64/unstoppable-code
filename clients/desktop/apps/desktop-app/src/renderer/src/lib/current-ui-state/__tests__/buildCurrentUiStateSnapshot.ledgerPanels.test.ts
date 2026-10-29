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

describe('buildCurrentUiStateSnapshot ledgerPanels', () => {
  it('omits the slice when no Ledger panel is open', () => {
    expect(buildCurrentUiStateSnapshot({}).ledgerPanels).toBeUndefined();
  });

  it('reports each open panel as counts and IDs only', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'ledger.panel.project-2/wt-1': {
        projectId: 'project-2',
        worktreeId: 'wt-1',
        listStatus: 'problem',
        entryCount: 0,
        hasMore: false,
        searching: false,
        filtered: false,
      },
      'ledger.panel.project-1/wt-1': {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        listStatus: 'ready',
        entryCount: 12,
        hasMore: true,
        searching: true,
        filtered: false,
        selectedEntryId: 'entry-1',
        detailStatus: 'ready',
        draft: 'set_aside',
        // Anything else a reporter adds never reaches the App Advisor.
        title: 'Private entry title',
        draftTitle: 'Private draft title',
      },
    });

    expect(snapshot.ledgerPanels).toEqual([
      {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        listStatus: 'ready',
        entryCount: 12,
        hasMore: true,
        searching: true,
        filtered: false,
        selectedEntryId: 'entry-1',
        detailStatus: 'ready',
        draft: 'set_aside',
      },
      {
        projectId: 'project-2',
        worktreeId: 'wt-1',
        listStatus: 'problem',
        entryCount: 0,
        hasMore: false,
        searching: false,
        filtered: false,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('Private entry title');
    expect(JSON.stringify(snapshot)).not.toContain('Private draft title');
  });

  it('skips a slice whose state it cannot read', () => {
    expect(
      buildCurrentUiStateSnapshot({
        'ledger.panel.project-1/wt-1': {
          projectId: 'project-1',
          worktreeId: 'wt-1',
          listStatus: 'exploded',
          entryCount: 1,
          hasMore: false,
          searching: false,
          filtered: false,
        },
      }).ledgerPanels,
    ).toBeUndefined();
  });
});
