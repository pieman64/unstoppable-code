/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStartupResumeStore } from '@/stores/startupResumeStore';
import type { StoreApi } from 'zustand';
import type * as ZustandModule from 'zustand';
import { HomeContinueSection } from '../HomeContinueSection';

// The sidebar store is derived from the chat store; drive its two key sets.
jest.mock('@/stores/chatSidebarStore', () => ({
  useChatSidebarStore: jest
    .requireActual<typeof ZustandModule>('zustand')
    .create(() => ({
      badgeKeys: { streaming: '' },
      unreadWorktreeKeys: new Set<string>(),
    })),
}));
const mockSidebarStore = jest.requireMock<{
  useChatSidebarStore: StoreApi<{
    badgeKeys: { streaming: string };
    unreadWorktreeKeys: Set<string>;
  }>;
}>('@/stores/chatSidebarStore').useChatSidebarStore;

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

jest.mock('@/hooks/useContextScopedWorkspaces', () => ({
  useContextScopedWorkspaces: (): { isInContext: () => boolean } => ({
    isInContext: (): boolean => true,
  }),
}));

const workspace: SidebarItem = {
  type: 'single-repo',
  id: 'ws-1',
  name: 'Secret Workspace',
  repoPath: '/repo',
  color: '#000000',
  collapsed: false,
  order: 0,
  worktrees: [
    {
      id: 'wt-1',
      branchName: 'feature/secret-branch',
      createdAt: '2026-01-01T00:00:00.000Z',
      label: 'Secret worktree label',
    },
  ],
};

describe('HomeContinueSection resume offer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { listUsageLimitedIdleSessions: jest.fn().mockResolvedValue([]) },
    });
    useProjectsStore.setState({ projects: [workspace] });
    useStartupResumeStore.setState({
      offer: { kind: 'worktree', projectId: 'ws-1', worktreeId: 'wt-1' },
    });
    setActivity({ streaming: [], unread: [] });
  });

  function setActivity({
    streaming,
    unread,
  }: {
    streaming: string[];
    unread: string[];
  }): void {
    mockSidebarStore.setState({
      badgeKeys: { streaming: streaming.join(',') },
      unreadWorktreeKeys: new Set(unread),
    });
  }

  async function renderSection(): Promise<void> {
    await act(async () => {
      root.render(
        createElement(HomeContinueSection, { interruptedActive: false }),
      );
      await Promise.resolve();
    });
  }

  const activity = (): string | null | undefined =>
    container.querySelector('[data-testid="home-resume-activity"]')
      ?.textContent;

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('names the resume destination and its workspace', async () => {
    await act(async () => {
      root.render(
        createElement(HomeContinueSection, { interruptedActive: false }),
      );
      await Promise.resolve();
    });

    const destination = container.querySelector(
      '[data-testid="home-resume-destination"]',
    );
    expect(destination?.textContent).toBe('Secret worktree label');

    const workspaceName = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'Secret Workspace',
    );
    expect(workspaceName).toBeDefined();
  });

  it.each<
    [string, { streaming: string[]; unread: string[] }, string | undefined]
  >([
    [
      'a running chat',
      { streaming: ['ws-1/wt-1'], unread: [] },
      'Agent working',
    ],
    [
      'unread activity',
      { streaming: [], unread: ['ws-1/wt-1'] },
      'New activity',
    ],
    [
      'running and unread together',
      { streaming: ['ws-1/wt-1'], unread: ['ws-1/wt-1'] },
      'Agent working',
    ],
    [
      'activity on unrelated worktrees',
      { streaming: ['ws-1/other'], unread: ['ws-2/wt-1'] },
      undefined,
    ],
    ['no known activity', { streaming: [], unread: [] }, undefined],
  ])('shows status for %s', async (_label, state, expected) => {
    setActivity(state);
    await renderSection();
    expect(activity()).toBe(
      expected === undefined ? undefined : `· ${expected}`,
    );
    expect(container.textContent).not.toMatch(/finished|repl(y|ies)/i);
  });

  it('clears the activity cue when unread state clears', async () => {
    setActivity({ streaming: [], unread: ['ws-1/wt-1'] });
    await renderSection();
    expect(activity()).toBe('· New activity');

    act(() => setActivity({ streaming: [], unread: [] }));
    expect(activity()).toBeUndefined();
    // The shared row is named by its visible text, so the cue leaves it too.
    const button = container.querySelector(
      '[data-testid="home-resume-button"]',
    );
    expect(button?.hasAttribute('aria-label')).toBe(false);
    expect(button?.textContent).toContain('Secret worktree label');
    expect(button?.textContent).not.toContain('New activity');
  });
});
