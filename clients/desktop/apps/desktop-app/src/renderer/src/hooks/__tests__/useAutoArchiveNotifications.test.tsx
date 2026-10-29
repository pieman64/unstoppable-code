/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AutoArchiveNotification } from '@canopy/desktop-shared/types';

const addToastMock = jest.fn();
const reconcileArchivedWorktreeMock = jest.fn().mockResolvedValue(undefined);
const reconcileArchivedWorkEntryMock = jest.fn().mockResolvedValue(undefined);

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: typeof addToastMock } => ({
      addToast: addToastMock,
    }),
  },
}));

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: {
    getState: (): object => ({
      reconcileArchivedWorktree: reconcileArchivedWorktreeMock,
    }),
  },
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): object => ({
      reconcileArchivedWorkEntry: reconcileArchivedWorkEntryMock,
    }),
  },
}));

import { useAutoArchiveNotifications } from '../useAutoArchiveNotifications';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Harness(): null {
  useAutoArchiveNotifications();
  return null;
}

describe('useAutoArchiveNotifications', () => {
  let container: HTMLDivElement;
  let root: Root;
  let callback: ((notification: AutoArchiveNotification) => void) | undefined;
  const unsubscribe = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    callback = undefined;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        onAutoArchiveCompleted: (
          next: (notification: AutoArchiveNotification) => void,
        ): (() => void) => {
          callback = next;
          return unsubscribe;
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps committed deletions reconciled while surfacing cleanup warnings', () => {
    act(() =>
      callback?.({
        workspaceId: 'workspace-1',
        workspaceName: 'Workspace',
        targetId: 'worktree-1',
        targetName: 'old',
        surface: 'single-repo',
        inactivityDays: 7,
        status: 'success',
        warnings: ['Browser cleanup failed'],
      } as AutoArchiveNotification & { warnings: string[] }),
    );
    expect(reconcileArchivedWorktreeMock).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
    );
    expect(addToastMock).toHaveBeenCalledWith(
      expect.stringContaining('Browser cleanup failed'),
      'warning',
      undefined,
      expect.objectContaining({ persistent: true }),
    );
  });

  it('toasts successful automatic deletions', () => {
    act(() =>
      callback?.({
        workspaceId: 'workspace-1',
        workspaceName: 'Workspace',
        targetId: 'worktree-1',
        targetName: 'feature/old',
        surface: 'single-repo',
        inactivityDays: 7,
        status: 'success',
      }),
    );

    expect(addToastMock).toHaveBeenCalledWith(
      '“feature/old” was automatically deleted after 7 days of inactivity.',
      'success',
      undefined,
      expect.objectContaining({
        category: 'Automation',
        title: 'Auto delete',
        forceInApp: true,
      }),
    );
    expect(reconcileArchivedWorktreeMock).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
    );
  });

  it('reconciles an automatically deleted Work Entry', () => {
    act(() =>
      callback?.({
        workspaceId: 'cowork-1',
        workspaceName: 'Cowork',
        targetId: 'entry-1',
        targetName: 'Old task',
        surface: 'cowork',
        inactivityDays: 7,
        status: 'success',
      }),
    );

    expect(reconcileArchivedWorkEntryMock).toHaveBeenCalledWith(
      'cowork-1',
      'entry-1',
    );
  });

  it('keeps failure notifications visible with the backend error', () => {
    act(() =>
      callback?.({
        workspaceId: 'cowork-1',
        workspaceName: 'Cowork',
        targetId: 'entry-1',
        targetName: 'Old task',
        surface: 'cowork',
        inactivityDays: 1,
        status: 'failure',
        error: 'Archive capture failed',
      }),
    );

    expect(addToastMock).toHaveBeenCalledWith(
      '“Old task” could not be automatically deleted: Archive capture failed',
      'error',
      undefined,
      expect.objectContaining({ persistent: true, forceInApp: true }),
    );
  });
});
