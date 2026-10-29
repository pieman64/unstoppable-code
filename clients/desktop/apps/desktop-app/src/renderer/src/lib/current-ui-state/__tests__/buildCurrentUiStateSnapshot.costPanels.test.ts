/**
 * @jest-environment jsdom
 */
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  costPanelUiState,
  costPanelUiStateKey,
  sessionBreakdownUiState,
  sessionBreakdownUiStateKey,
} from '@/lib/cost/cost-panel-ui-state';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: null });
  useProjectsStore.setState({ projects: [] });
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
});

describe('buildCurrentUiStateSnapshot costPanels', () => {
  it('omits the slice when no cost panel is open', () => {
    expect(buildCurrentUiStateSnapshot({}).costPanels).toBeUndefined();
  });

  it('reports open cost panels as status, counts and IDs only', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      [costPanelUiStateKey('p-1', 'w-1')]: costPanelUiState(
        'p-1',
        'w-1',
        'ready',
        null,
      ),
      [sessionBreakdownUiStateKey('p-1', 'w-1', 'c-1')]:
        sessionBreakdownUiState('p-1', 'w-1', 'c-1', 'loading', null),
    });
    expect(snapshot.costPanels).toEqual([
      { kind: 'cost', projectId: 'p-1', worktreeId: 'w-1', status: 'ready' },
      {
        kind: 'session-breakdown',
        projectId: 'p-1',
        worktreeId: 'w-1',
        chatId: 'c-1',
        status: 'loading',
      },
    ]);
  });

  it('drops malformed slices and fields outside the contract', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'cost.panel.bad-kind': {
        kind: 'other',
        projectId: 'p',
        worktreeId: 'w',
        status: 'ready',
      },
      'cost.panel.no-chat': {
        kind: 'session-breakdown',
        projectId: 'p',
        worktreeId: 'w',
        status: 'ready',
      },
      'cost.panel.cost/p/w': {
        kind: 'cost',
        projectId: 'p',
        worktreeId: 'w',
        status: 'ready',
        chatCount: 3,
        chatNames: ['secret'],
        totalUsd: 4.2,
      },
    });
    expect(snapshot.costPanels).toEqual([
      {
        kind: 'cost',
        projectId: 'p',
        worktreeId: 'w',
        status: 'ready',
        chatCount: 3,
      },
    ]);
  });
});
