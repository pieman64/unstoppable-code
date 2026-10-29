/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PullRequestActions,
  PullRequestCreateAction,
} from '../PullRequestActions';
import {
  IDLE_PULL_REQUEST_ACTIVITY,
  planPullRequestActions,
  type PullRequestActionsFacts,
  type PullRequestActionsPr,
} from '../pull-request-actions-plan';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function pr(
  overrides: Partial<PullRequestActionsPr> = {},
): PullRequestActionsPr {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'open',
    checkStatus: 'pending',
    checkDetails: [{ name: 'unit', status: 'pending', detailsUrl: null }],
    readyToMerge: false,
    inMergeQueue: false,
    hasConflicts: false,
    reviewThreadsWarning: false,
    mergeRoute: 'direct',
    ...overrides,
  };
}

function facts(
  overrides: Partial<PullRequestActionsFacts> = {},
): PullRequestActionsFacts {
  return {
    isMultiRepo: false,
    repos: [{ repoId: 'r', repoName: 'r', pr: pr() }],
    worktree: {
      repoId: 'r',
      commitsAhead: true,
      hasRemoteTrackingBranch: true,
      hasOriginRemote: true,
    },
    splitPr: null,
    agentHelpers: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
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

function render(
  input: PullRequestActionsFacts,
  onAction = jest.fn(),
): jest.Mock {
  const plan = planPullRequestActions(input, IDLE_PULL_REQUEST_ACTIVITY);
  act(() => {
    root.render(
      <PullRequestActions
        plan={plan}
        activity={IDLE_PULL_REQUEST_ACTIVITY}
        onAction={onAction}
        onCancel={jest.fn()}
      />,
    );
  });
  return onAction;
}

function byTestId(id: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
}

describe('PullRequestActions blocked controls', () => {
  it('keeps a waiting Merge in place, unavailable, and does nothing on click', () => {
    const onAction = render(facts());
    const merge = byTestId('pr-status-bar-merge-pr');
    expect(merge?.textContent).toBe('Merge');
    expect(merge?.getAttribute('aria-disabled')).toBe('true');
    // Still focusable, so its tooltip can say why.
    expect(merge?.disabled).toBe(false);
    expect(merge?.className).toContain('aria-disabled:opacity-60');
    act(() => merge?.click());
    expect(onAction).not.toHaveBeenCalled();
  });

  it('merges a ready PR', () => {
    const onAction = render(
      facts({
        repos: [
          {
            repoId: 'r',
            repoName: 'r',
            pr: pr({ readyToMerge: true, checkStatus: 'passing' }),
          },
        ],
      }),
    );
    const merge = byTestId('pr-status-bar-merge-pr');
    expect(merge?.getAttribute('aria-disabled')).toBeNull();
    // An action, not a run state: the accent ink, not the merged purple.
    expect(merge?.classList.contains('fg-accent')).toBe(true);
    expect(merge?.classList.contains('fg-special-strong')).toBe(false);
    act(() => merge?.click());
    expect(onAction).toHaveBeenCalledWith({ kind: 'merge' });
  });

  it('shows Fix and Resolve unavailable without agent helpers', () => {
    const onAction = render(
      facts({
        repos: [
          {
            repoId: 'r',
            repoName: 'r',
            pr: pr({
              hasConflicts: true,
              checkStatus: 'failing',
              checkDetails: [
                { name: 'lint', status: 'failing', detailsUrl: null },
              ],
            }),
          },
        ],
      }),
    );
    for (const id of [
      'pr-status-bar-fix-ci',
      'pr-status-bar-resolve-conflicts',
    ]) {
      const button = byTestId(id);
      expect(button?.getAttribute('aria-disabled')).toBe('true');
      act(() => button?.click());
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it('runs Fix and Resolve on a host with agent helpers', () => {
    const onAction = render(
      facts({
        agentHelpers: true,
        repos: [
          {
            repoId: 'r',
            repoName: 'r',
            pr: pr({
              hasConflicts: true,
              checkStatus: 'failing',
              checkDetails: [
                { name: 'lint', status: 'failing', detailsUrl: null },
              ],
            }),
          },
        ],
      }),
    );
    act(() => byTestId('pr-status-bar-fix-ci')?.click());
    act(() => byTestId('pr-status-bar-resolve-conflicts')?.click());
    expect(onAction.mock.calls).toEqual([
      [{ kind: 'fix-ci' }],
      [{ kind: 'resolve-conflicts' }],
    ]);
  });

  it('tints Merge as a warning for unresolved review threads', () => {
    render(
      facts({
        repos: [
          {
            repoId: 'r',
            repoName: 'r',
            pr: pr({
              readyToMerge: true,
              checkStatus: 'passing',
              reviewThreadsWarning: true,
            }),
          },
        ],
      }),
    );
    const merge = byTestId('pr-status-bar-merge-pr');
    expect(merge?.classList.contains('fg-warning')).toBe(true);
    expect(merge?.classList.contains('fg-accent')).toBe(false);
  });

  it('renders the cancel merge control in the accent tone', () => {
    const input = facts({
      repos: [
        {
          repoId: 'r',
          repoName: 'r',
          pr: pr({ readyToMerge: true, checkStatus: 'passing' }),
        },
      ],
    });
    const activity = { ...IDLE_PULL_REQUEST_ACTIVITY, mergingPr: true };
    act(() => {
      root.render(
        <PullRequestActions
          plan={planPullRequestActions(input, activity)}
          activity={activity}
          onAction={jest.fn()}
          onCancel={jest.fn()}
        />,
      );
    });
    const merge = byTestId('pr-status-bar-merge-pr');
    expect(merge?.classList.contains('fg-accent')).toBe(true);
    const cancel = byTestId('pr-status-bar-cancel-git-action');
    expect(cancel?.getAttribute('aria-label')).toBe('Cancel merge');
    expect(cancel?.classList.contains('fg-accent')).toBe(true);
    expect(cancel?.classList.contains('fg-special-strong')).toBe(false);
  });
});

describe('PullRequestActions branch-sync cancel', () => {
  it('names the running branch sync in sentence case', () => {
    const input = facts({
      repos: [{ repoId: 'r', repoName: 'r', pr: pr() }],
      worktree: {
        repoId: 'r',
        commitsAhead: true,
        hasUncommittedChanges: true,
        hasRemoteTrackingBranch: true,
        hasOriginRemote: true,
      },
    });
    const activity = {
      ...IDLE_PULL_REQUEST_ACTIVITY,
      committingAndPushing: true,
      activeBranchSyncAction: 'commit-and-push' as const,
    };
    act(() => {
      root.render(
        <PullRequestActions
          plan={planPullRequestActions(input, activity)}
          activity={activity}
          onAction={jest.fn()}
          onCancel={jest.fn()}
        />,
      );
    });
    expect(
      byTestId('pr-status-bar-branch-sync')?.getAttribute('aria-label'),
    ).toBe('Cancel commit & push');
    expect(
      byTestId('pr-status-bar-cancel-git-action')?.getAttribute('aria-label'),
    ).toBe('Cancel commit & push');
  });
});

describe('PullRequestCreateAction cancel', () => {
  function renderCreating(createCancellable: boolean | undefined): void {
    const input = facts({
      repos: [{ repoId: 'r', repoName: 'r', pr: null }],
      worktree: {
        repoId: 'r',
        commitsAhead: true,
        hasUncommittedChanges: true,
        hasRemoteTrackingBranch: true,
        hasOriginRemote: true,
      },
    });
    const activity = {
      ...IDLE_PULL_REQUEST_ACTIVITY,
      creatingPr: true,
      ...(createCancellable === undefined ? {} : { createCancellable }),
    };
    act(() => {
      root.render(
        <PullRequestCreateAction
          plan={planPullRequestActions(input, activity)}
          activity={activity}
          onAction={jest.fn()}
          onCancel={jest.fn()}
        />,
      );
    });
  }

  it('offers Cancel while the host can still stop Create PR', () => {
    renderCreating(undefined);
    expect(
      container.querySelector('[aria-label="Cancel create PR"]'),
    ).not.toBeNull();
  });

  it('keeps Create PR cancellation mounted after a busy refresh clears git facts', () => {
    const activity = { ...IDLE_PULL_REQUEST_ACTIVITY, creatingPr: true };
    const onCancel = jest.fn();
    function renderState(worktree: PullRequestActionsFacts['worktree']): void {
      const input = facts({
        repos: [{ repoId: 'r', repoName: 'r', pr: null }],
        worktree,
      });
      act(() => {
        root.render(
          <PullRequestCreateAction
            plan={planPullRequestActions(input, activity)}
            activity={activity}
            onAction={jest.fn()}
            onCancel={onCancel}
          />,
        );
      });
    }
    renderState({ repoId: 'r', commitsAhead: true, hasOriginRemote: true });
    renderState({ repoId: 'r' });
    const cancel = container.querySelector<HTMLButtonElement>(
      '[aria-label="Cancel create PR"]',
    );
    expect(cancel).not.toBeNull();
    act(() => cancel?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers no Cancel once the host says the create can no longer stop', () => {
    renderCreating(false);
    expect(
      container.querySelector('[aria-label="Cancel create PR"]'),
    ).toBeNull();
  });
});
