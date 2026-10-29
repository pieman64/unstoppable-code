/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { Notification } from '@/stores/githubStore';
import { NotificationsPanel } from '../NotificationsPanel';

const notifications: Notification[] = [
  {
    id: 'n-1',
    message: 'Pushed feature/secret-branch to /Users/me/secret-repo',
    type: 'success',
    createdAt: Date.now(),
    meta: {
      category: 'Git Commit',
      workspaceName: 'Secret Project',
      projectId: 'project-1',
      worktreeId: 'secret-worktree',
    },
  },
  {
    id: 'n-2',
    message: 'Reviewer: I fixed the failing request.',
    type: 'success',
    createdAt: Date.now(),
    meta: { category: 'Chat', projectId: 'project-1' },
  },
  {
    id: 'n-3',
    message: 'Invited friend@example.com',
    type: 'success',
    createdAt: Date.now(),
    meta: { blockMessageFromReplay: true },
  },
];

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: (
    selector: (state: {
      notifications: Notification[];
      dismissNotification: () => void;
    }) => unknown,
  ): unknown => selector({ notifications, dismissNotification: jest.fn() }),
}));

jest.mock('@/hooks/useContextScopedWorkspaces', () => ({
  useContextScopedWorkspaces: (): {
    context: undefined;
    workspaces: never[];
    linkedPersonalWorkspaceIds: never[];
    isInContext: () => boolean;
  } => ({
    context: undefined,
    workspaces: [],
    linkedPersonalWorkspaceIds: [],
    isInContext: (): boolean => true,
  }),
}));

function findTextElement(container: HTMLElement, text: string): Element {
  const match = Array.from(container.querySelectorAll('*')).find((element) =>
    Array.from(element.childNodes).some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent?.includes(text),
    ),
  );
  if (!match) throw new Error(`No element renders text: ${text}`);
  return match;
}

describe('NotificationsPanel', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the category, project, worktree, and message', () => {
    act(() => root.render(<NotificationsPanel />));

    for (const text of [
      'Git Commit',
      'Secret Project',
      'secret-worktree',
      'Pushed feature/secret-branch to /Users/me/secret-repo',
    ]) {
      expect(findTextElement(container, text)).toBeDefined();
    }
  });

  it('blocks chat messages, which quote the agent reply, and records the rest', () => {
    act(() => root.render(<NotificationsPanel />));

    const blocked = (text: string): boolean =>
      findTextElement(container, text)?.closest(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      ) != null;
    expect(blocked('Reviewer: I fixed the failing request.')).toBe(true);
    expect(
      blocked('Pushed feature/secret-branch to /Users/me/secret-repo'),
    ).toBe(false);
    expect(blocked('Git Commit')).toBe(false);
    expect(blocked('Secret Project')).toBe(false);
  });

  it('blocks a message whose toast opted in, such as an invite naming a person', () => {
    act(() => root.render(<NotificationsPanel />));

    expect(
      findTextElement(container, 'Invited friend@example.com').closest(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      ),
    ).not.toBeNull();
  });
});
