/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { WorktreeRemovalConfirmDialog } from '../WorktreeRemovalConfirmDialog';
import { getWorktreeDeleteLabels } from '@canopy/ui-app';

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const target = {
  workspaceId: 'ws',
  workspaceName: 'Demo',
  worktreeId: 'wt',
  worktreeName: 'feature',
  worktreeCreatedAt: '2026-01-01T00:00:00.000Z',
  branchName: 'feature/x',
};

describe('WorktreeRemovalConfirmDialog', () => {
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

  it('names the row, abbreviates the retention warning, and commits through Preserve local', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    act(() =>
      root.render(
        <WorktreeRemovalConfirmDialog
          target={target}
          labels={getWorktreeDeleteLabels('delete', 7, target.branchName)}
          hasLocalWork
          hasLineChanges
          stats={{ insertions: 3, deletions: 1 }}
          archiveInProgress={false}
          blocked={false}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />,
      ),
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Delete worktree?');
    // Portaled to <body> as a browser-native overlay root, so the in-app
    // browser's native view never paints over it.
    const overlay = dialog?.closest('[data-canopy-browser-native-overlay]');
    expect(overlay?.getAttribute('data-canopy-browser-native-overlay')).toBe(
      'true',
    );
    expect(overlay?.parentElement).toBe(document.body);
    const identity = document.querySelector(
      '[data-testid="worktree-removal-target-identity"]',
    );
    expect(identity?.textContent).toContain('Worktreefeature wt');
    expect(identity?.textContent).toContain('Branchfeature/x');
    expect(identity?.textContent).toContain('ProjectDemo');
    expect(
      document.querySelector('[data-testid="worktree-removal-summary"]')
        ?.textContent,
    ).toBe(
      'Has local changes +3 -1. Restorable for 7 days when an archive can be created.',
    );
    // The full explanation lives behind the info button, not in the body.
    expect(dialog?.textContent).not.toContain(
      'Otherwise, deletion is permanent',
    );
    const info = document.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-removal-retention-info"]',
    );
    expect(info?.getAttribute('aria-label')).toBe(
      'About restoring this worktree',
    );
    expect(jest.mocked(useCurrentUiStateReporter)).toHaveBeenCalledWith(
      'worktree.archiveDialog.wt',
      {
        open: true,
        workspaceId: 'ws',
        worktreeId: 'wt',
        branchName: 'feature/x',
        archiveInProgress: false,
        blocked: false,
      },
    );

    const labels = Array.from(dialog?.querySelectorAll('button') ?? [])
      .map((button) => button.textContent)
      .filter((label) => label !== '');
    expect(labels).toEqual(['Cancel', 'Preserve local', 'Delete local']);
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="worktree-removal-preserve-branch"]',
        )
        ?.click();
    });
    expect(onConfirm).toHaveBeenCalledWith(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('shows the full retention explanation from the info button', () => {
    act(() =>
      root.render(
        <WorktreeRemovalConfirmDialog
          target={target}
          labels={getWorktreeDeleteLabels('delete', 7, target.branchName)}
          hasLocalWork={false}
          hasLineChanges={false}
          archiveInProgress={false}
          blocked={false}
          onCancel={jest.fn()}
          onConfirm={jest.fn()}
        />,
      ),
    );
    const info = document.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-removal-retention-info"]',
    );
    act(() => {
      info?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      info?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    expect(
      document.querySelector(
        '[data-testid="worktree-removal-retention-detail"]',
      )?.textContent,
    ).toBe(
      'Deleting removes the worktree from disk and its chat from the sidebar. ' +
        'When a restorable archive can be created, its Git state, chats, and ' +
        'eligible pipeline history are kept for 7 days. Otherwise, deletion ' +
        'is permanent.',
    );
  });

  it('commits Delete local with the branch deleted', () => {
    const onConfirm = jest.fn();
    act(() =>
      root.render(
        <WorktreeRemovalConfirmDialog
          target={target}
          labels={getWorktreeDeleteLabels('delete', 7, target.branchName)}
          hasLocalWork={false}
          hasLineChanges={false}
          archiveInProgress={false}
          blocked={false}
          requestedDeleteBranch
          onCancel={jest.fn()}
          onConfirm={onConfirm}
        />,
      ),
    );
    expect(document.body.textContent).toContain(
      'Advisor suggested Delete local.',
    );
    const deleteLocal = document.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-removal-delete-branch"]',
    );
    expect(deleteLocal?.getAttribute('data-requested')).toBe('true');
    act(() => deleteLocal?.click());
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('keeps both removal actions locked while removal is blocked and cancels on Escape', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    act(() =>
      root.render(
        <WorktreeRemovalConfirmDialog
          target={target}
          labels={getWorktreeDeleteLabels('archive', 7, target.branchName)}
          hasLocalWork={false}
          hasLineChanges={false}
          archiveInProgress={false}
          blocked
          onCancel={onCancel}
          onConfirm={onConfirm}
        />,
      ),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('Archive worktree?');
    expect(dialog?.textContent).toContain('Kept until you delete the archive.');
    for (const testId of [
      'worktree-removal-preserve-branch',
      'worktree-removal-delete-branch',
    ]) {
      const button = document.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      );
      expect(button?.disabled).toBe(true);
      act(() => button?.click());
    }
    expect(onConfirm).not.toHaveBeenCalled();
    // Focus lands on Cancel, the safe default, so Escape reaches the dialog
    // from wherever the keyboard is rather than only after a click inside.
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(dialog?.contains(document.activeElement)).toBe(true);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not let a backdrop click reach the row that opened it', () => {
    const onCancel = jest.fn();
    const onRowClick = jest.fn();
    act(() =>
      root.render(
        <div onClick={onRowClick}>
          <WorktreeRemovalConfirmDialog
            target={target}
            labels={getWorktreeDeleteLabels('delete', 7, target.branchName)}
            hasLocalWork={false}
            hasLineChanges={false}
            archiveInProgress={false}
            blocked={false}
            onCancel={onCancel}
            onConfirm={jest.fn()}
          />
        </div>,
      ),
    );
    act(() => {
      document
        .querySelector<HTMLElement>('[data-canopy-overlay-root="modal"]')
        ?.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
