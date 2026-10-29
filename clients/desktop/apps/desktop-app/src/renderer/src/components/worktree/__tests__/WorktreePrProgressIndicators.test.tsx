/** @jest-environment jsdom */
import { act, type JSX, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/*
 * CAN-3053 attempt-2: the badge's own `data-testid` was already suffixed for
 * a pinned copy (`worktree-row-pr-creating${testIdSuffix}`, threaded in by
 * `desktopWorktreeRowOverrides.tsx`), but its tooltip's `dataTestId` was a
 * bare literal (`worktree-row-pr-creating-tooltip`) regardless of the
 * caller's suffix — a pinned copy's tooltip would collide with the in-flow
 * row's, the same class of bug CAN-3127 fixed for the badges themselves.
 * `GitActionProgressTooltip` is mocked here so the test can assert the
 * suffixed id directly without simulating its active-tooltip store state.
 */

const capturedDataTestIds: Array<string | undefined> = [];

jest.mock('@/components/github/GitActionProgressTooltip', () => ({
  __esModule: true,
  GitActionProgressTooltip: ({
    dataTestId,
    children,
  }: {
    dataTestId?: string;
    children: ReactElement;
  }): JSX.Element => {
    capturedDataTestIds.push(dataTestId);
    return <div data-testid={dataTestId}>{children}</div>;
  },
}));

import {
  WorktreePrCreatingIndicator,
  WorktreePrMergingIndicator,
} from '../WorktreePrProgressIndicators';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(element: ReactElement): { root: Root; cleanup: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    root,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('WorktreePrProgressIndicators tooltip test ids', () => {
  beforeEach(() => {
    capturedDataTestIds.length = 0;
  });

  it('suffixes the creating-indicator tooltip id the same way the badge itself is suffixed', () => {
    const { cleanup } = render(
      <WorktreePrCreatingIndicator
        projectId="project"
        worktreeId="worktree"
        testId="worktree-row-pr-creating-pin-top"
      />,
    );
    expect(capturedDataTestIds).toEqual([
      'worktree-row-pr-creating-pin-top-tooltip',
    ]);
    cleanup();
  });

  it('leaves the bare (unsuffixed, in-flow) creating tooltip id unchanged', () => {
    const { cleanup } = render(
      <WorktreePrCreatingIndicator
        projectId="project"
        worktreeId="worktree"
        testId="worktree-row-pr-creating"
      />,
    );
    expect(capturedDataTestIds).toEqual(['worktree-row-pr-creating-tooltip']);
    cleanup();
  });

  it('suffixes the merging-indicator tooltip id the same way the badge itself is suffixed', () => {
    const { cleanup } = render(
      <WorktreePrMergingIndicator
        projectId="project"
        worktreeId="worktree"
        testId="worktree-row-pr-merging-sticky-slot"
      />,
    );
    expect(capturedDataTestIds).toEqual([
      'worktree-row-pr-merging-sticky-slot-tooltip',
    ]);
    cleanup();
  });
});
