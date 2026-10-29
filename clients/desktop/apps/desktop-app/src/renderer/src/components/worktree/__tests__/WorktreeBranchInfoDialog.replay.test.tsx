/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

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
  branchName: 'feature/private-branch',
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
            // Left pending: the test only inspects the dialog card.
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

describe('WorktreeBranchInfoDialog session-replay privacy', () => {
  it('records the portaled card and the branch name in it', () => {
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

    const card = document.body.querySelector(
      ':scope > [data-canopy-browser-native-overlay="true"] > [role="dialog"]',
    );
    expect(card?.textContent).toContain('feature/private-branch');
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
  });
});
