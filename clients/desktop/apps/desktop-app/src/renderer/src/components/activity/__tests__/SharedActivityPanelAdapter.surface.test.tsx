/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ActivitySurface } from '@canopy/desktop-shared/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let mockAttachmentsHaveContent = false;

// Render the real adapter, replacing section data sources and display bodies.
// The surface passed to the real policy boundary must come from access scope,
// including when the recipient's project ID is not a local Cowork target.
jest.mock('@/hooks/useActivityEventSubscriptions', () => ({
  useActivityEventSubscriptions: jest.fn(),
}));
jest.mock('@/lib/cowork', () => ({ isCoworkChatTarget: jest.fn(() => false) }));
jest.mock('@/lib/workspace-access', () => ({ useWorkspaceAccess: jest.fn() }));
jest.mock('@/lib/panels/panel-host-context', () => ({
  usePanelHostState: (): unknown => ({}),
}));
jest.mock('@/stores/activitySectionRevealStore', () => ({
  useActivitySectionRevealStore: (
    select: (state: unknown) => unknown,
  ): unknown => select({ expandRequests: {} }),
}));
jest.mock('@/stores/activityStore', () => ({
  useActivityStore: (select: (state: unknown) => unknown): unknown =>
    select({ worktreeSummaries: {}, summaryGenerating: {}, bgProcesses: {} }),
}));
jest.mock('@/stores/changedFilesRefreshRuntime', () => ({
  requestChangedFilesRefresh: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown): unknown =>
    select({ selectedWorktree: null }),
  useWorktreeChatRenderState: (): unknown => undefined,
  useActiveChatTabRenderState: (): unknown => ({}),
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: (select: (state: unknown) => unknown): unknown =>
    select({ prStatuses: {} }),
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: (select: (state: unknown) => unknown): unknown =>
    select({ projects: [], diffStats: {} }),
}));
jest.mock('@/stores/scriptsStore', () => ({
  useScriptsStore: {
    getState: (): unknown => ({
      loadWorktreeRuns: (): Promise<void> => Promise.resolve(),
    }),
  },
}));
jest.mock('@/stores/hooksStore', () => ({
  useHooksStore: {
    getState: (): unknown => ({
      loadWorktreeRuns: (): Promise<void> => Promise.resolve(),
    }),
  },
}));
jest.mock('../activity-sections', () => {
  const chrome = (): object => ({
    collapsedIconColor: 'muted',
    hasContent: false,
  });
  return {
    getActivitySectionsForSurface: (): unknown => [],
    useMcpServersActivityModel: (): unknown => ({
      servers: [],
      initializing: false,
    }),
    useSummaryHeaderChrome: chrome,
    usePullRequestHeaderChrome: chrome,
    useBackgroundProcessesHeaderChrome: chrome,
    useMcpServersHeaderChrome: chrome,
    usePlansHeaderChrome: chrome,
    usePipelineRunsHeaderChrome: chrome,
    useScriptsHeaderChrome: chrome,
    useHooksHeaderChrome: chrome,
    useTodoHeaderChrome: chrome,
    useNotesHeaderChrome: chrome,
    usePromptsHeaderChrome: chrome,
    useAttachmentsHeaderChrome: (): object => ({
      collapsedIconColor: 'muted',
      hasContent: mockAttachmentsHaveContent,
    }),
  };
});
jest.mock('../BackgroundProcessesSection', () => ({
  useBackgroundProcessesSectionHostModel: (): unknown => ({}),
}));
jest.mock('../ChangedFilesSection', () => ({
  useChangedFilesSectionHostModel: (): unknown => ({}),
}));
jest.mock('../ChatPluginsSection', () => ({
  useChatPluginsHasContent: (): unknown => false,
}));
jest.mock('../HooksSection', () => ({
  useHooksSectionHostModel: (): unknown => ({}),
}));
jest.mock('../ScriptsSection', () => ({
  useScriptsSectionHostModel: (): unknown => ({}),
}));
jest.mock('../MemorySection', () => ({ MemorySection: (): unknown => null }));
jest.mock('../RunOutputControls', () => ({
  SettingsGearButton: (): unknown => null,
}));
jest.mock('../cost/CostActivityScopeHost', () => ({
  CostActivityScopeHost: ({ children }: { children: ReactNode }): ReactNode =>
    children,
}));
jest.mock('@canopy/ui-app', () => ({
  ActivityPanel: (): unknown => null,
  changedFilesHeaderHasContent: (): unknown => false,
}));
jest.mock('../useAutoExpandActivityRail', () => ({
  useAutoExpandActivityRail: jest.fn(),
}));

import { isCoworkChatTarget } from '@/lib/cowork';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { SharedActivityPanelAdapter } from '../SharedActivityPanelAdapter';
import { useAutoExpandActivityRail } from '../useAutoExpandActivityRail';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mockAttachmentsHaveContent = false;
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

it('keeps the guest attachment action in rail presence with a muted icon and no count', () => {
  mockAttachmentsHaveContent = true;
  jest.mocked(useWorkspaceAccess).mockReturnValue({ mode: 'read-write' });
  act(() =>
    root.render(
      <SharedActivityPanelAdapter
        worktreeSelection={{ projectId: 'project', worktreeId: 'worktree' }}
      />,
    ),
  );
  const [options] = jest.mocked(useAutoExpandActivityRail).mock.lastCall ?? [];
  expect(options?.sectionHasContent.attachments).toBe(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.clearAllTimers();
  jest.clearAllMocks();
  jest.useRealTimers();
});

it.each<{
  containerType: 'COWORK_WORK_ENTRY' | 'CODE_WORKTREE';
  expected: ActivitySurface;
}>([
  { containerType: 'COWORK_WORK_ENTRY', expected: 'cowork' },
  { containerType: 'CODE_WORKTREE', expected: 'worktree' },
])(
  'classifies a read-only $containerType recipient as $expected',
  ({ containerType, expected }) => {
    jest.mocked(useWorkspaceAccess).mockReturnValue({
      mode: 'read-only',
      reason: 'shared-container',
      containerType,
      runAllowed: false,
    });
    act(() =>
      root.render(
        <SharedActivityPanelAdapter
          worktreeSelection={{ projectId: 'recipient', worktreeId: 'entry' }}
        />,
      ),
    );
    expect(isCoworkChatTarget).toHaveBeenCalledWith('recipient');
    expect(useAutoExpandActivityRail).toHaveBeenLastCalledWith(
      expect.objectContaining({ surface: expected }),
    );
  },
);
