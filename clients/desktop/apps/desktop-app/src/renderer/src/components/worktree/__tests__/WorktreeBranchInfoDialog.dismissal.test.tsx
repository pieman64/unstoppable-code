/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorktreeData } from '@canopy/desktop-shared/types';

jest.mock('../CodeGraphSummaryPanel', () => ({
  CodeGraphSummaryPanel: (): null => null,
}));
jest.mock('../BaseBranchDropdown', () => ({
  BaseBranchDropdown: (): null => null,
}));
jest.mock('../BranchPicker', () => ({
  BranchPicker: (): null => null,
}));

import { WorktreeBranchInfoDialog } from '../WorktreeBranchInfoDialog';

const WORKTREE: WorktreeData = {
  id: 'wt-1',
  branchName: 'feature/branch',
  createdAt: '2026-07-01T00:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getWorktreePath: jest.fn(
        () =>
          new Promise(() => {
            // Left pending: these tests only dismiss the dialog.
          }),
      ),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function pressEscape(target: EventTarget): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function renameInput(): HTMLInputElement | null {
  return document.body.querySelector<HTMLInputElement>(
    'input[aria-label="New branch name"]',
  );
}

describe('WorktreeBranchInfoDialog dismissal', () => {
  it('opens as the shared dialog, named by its title', () => {
    act(() => {
      root.render(
        <WorktreeBranchInfoDialog
          open
          worktree={WORKTREE}
          projectId="proj-1"
          onClose={jest.fn()}
        />,
      );
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    const titleId = dialog?.getAttribute('aria-labelledby');
    expect(titleId).toBe('branch-info-wt-1');
    expect(document.getElementById(titleId ?? '')?.textContent).toBe(
      'Branch info',
    );
  });

  it('cancels an open rename on the first Escape and closes on the next', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(
        <WorktreeBranchInfoDialog
          open
          worktree={WORKTREE}
          projectId="proj-1"
          onClose={onClose}
          pendingRename={{ id: 'single', branch: 'feature/branch' }}
        />,
      );
    });
    const input = renameInput();
    if (!input) throw new Error('rename input missing');

    pressEscape(input);
    expect(renameInput()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button', () => {
    const onClose = jest.fn();
    act(() => {
      root.render(
        <WorktreeBranchInfoDialog
          open
          worktree={WORKTREE}
          projectId="proj-1"
          onClose={onClose}
        />,
      );
    });
    const close = document.body.querySelector<HTMLButtonElement>(
      '[role="dialog"] button[aria-label="Close"]',
    );
    act(() => close?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
