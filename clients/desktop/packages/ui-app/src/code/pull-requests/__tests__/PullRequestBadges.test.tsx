/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CiStatusBadgeWithPopover,
  MultiRepoPrBadge,
} from '../PullRequestBadges';
import type {
  PullRequestActionsPr,
  PullRequestActionsRepo,
} from '../pull-request-actions-plan';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function pr(
  overrides: Partial<PullRequestActionsPr> = {},
): PullRequestActionsPr {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'open',
    checkStatus: 'failing',
    checkDetails: [{ name: 'app-build', status: 'failing', detailsUrl: null }],
    readyToMerge: false,
    inMergeQueue: false,
    hasConflicts: false,
    reviewThreadsWarning: false,
    mergeRoute: 'direct',
    ...overrides,
  };
}

const REPOS: readonly PullRequestActionsRepo[] = [
  { repoId: 'repo-app', repoName: 'App', pr: pr() },
  { repoId: 'repo-docs', repoName: 'Docs', pr: pr({ number: 8 }) },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.useRealTimers();
});

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function required(element: Element | null | undefined, name: string): Element {
  if (!element) throw new Error(`${name} missing`);
  return element;
}

/** Move the pointer from one element to another, as the browser reports it. */
function movePointer(from: Element, to: Element): void {
  act(() => {
    from.dispatchEvent(
      new MouseEvent('mouseout', { bubbles: true, relatedTarget: to }),
    );
    to.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true, relatedTarget: from }),
    );
  });
}

function settle(): void {
  act(() => {
    jest.advanceTimersByTime(500);
  });
}

describe('CiStatusBadgeWithPopover', () => {
  it('lists the checks on hover and closes once the pointer leaves', () => {
    act(() => {
      root.render(
        <CiStatusBadgeWithPopover
          status="failing"
          checkDetails={pr().checkDetails}
        />,
      );
    });
    const badge = required(byTestId('pr-status-bar-ci-badge'), 'badge');

    movePointer(document.body, badge);
    const card = required(byTestId('pr-status-bar-ci-popover'), 'card');
    expect(card.textContent).toContain('app-build');

    // The pointer can travel into the card without it closing.
    movePointer(badge, card);
    settle();
    expect(byTestId('pr-status-bar-ci-popover')).not.toBeNull();

    movePointer(card, document.body);
    settle();
    expect(byTestId('pr-status-bar-ci-popover')).toBeNull();
  });

  it('opens no card without per-check details', () => {
    act(() => {
      root.render(
        <CiStatusBadgeWithPopover status="neutral" checkDetails={[]} />,
      );
    });
    const badge = required(byTestId('pr-status-bar-ci-badge'), 'badge');

    movePointer(document.body, badge);
    settle();
    expect(byTestId('pr-status-bar-ci-popover')).toBeNull();
  });
});

describe('MultiRepoPrBadge', () => {
  it('lists each repository and keeps the list open over a nested CI card', () => {
    act(() => {
      root.render(<MultiRepoPrBadge openRepos={REPOS} onOpen={jest.fn()} />);
    });
    const badge = required(document.querySelector('button'), 'badge');
    expect(badge.textContent).toBe('2 PRs');

    movePointer(document.body, badge);
    const list = required(byTestId('pr-status-bar-repo-popover'), 'list');
    expect(list.textContent).toContain('App');
    expect(list.textContent).toContain('Docs');

    const ciBadge = required(
      byTestId('pr-status-bar-repo-ci-badge-repo-app'),
      'nested badge',
    );
    movePointer(badge, ciBadge);
    const ciCard = required(
      byTestId('pr-status-bar-repo-ci-popover-repo-app'),
      'nested card',
    );
    expect(ciCard.textContent).toContain('app-build');

    movePointer(ciBadge, ciCard);
    settle();
    expect(byTestId('pr-status-bar-repo-popover')).not.toBeNull();
    expect(byTestId('pr-status-bar-repo-ci-popover-repo-app')).not.toBeNull();

    // Back on a row of the list, the nested card closes and the list stays.
    const appRow = required(
      Array.from(list.querySelectorAll('span')).find(
        (span) => span.textContent === 'App',
      ),
      'row',
    );
    movePointer(ciCard, appRow);
    settle();
    expect(byTestId('pr-status-bar-repo-ci-popover-repo-app')).toBeNull();
    expect(byTestId('pr-status-bar-repo-popover')).not.toBeNull();

    movePointer(appRow, document.body);
    settle();
    expect(byTestId('pr-status-bar-repo-popover')).toBeNull();
  });

  it('opens the PR details on click and leaves Enter to the button', () => {
    const onOpen = jest.fn();
    act(() => {
      root.render(<MultiRepoPrBadge openRepos={REPOS} onOpen={onOpen} />);
    });
    const badge = document.querySelector('button');
    if (!badge) throw new Error('badge missing');

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      badge.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(false);
    expect(byTestId('pr-status-bar-repo-popover')).toBeNull();

    act(() => {
      badge.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
