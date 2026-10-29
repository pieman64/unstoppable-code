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
import { HomeContinueSection } from '../HomeContinueSection';

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
  });

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
});
