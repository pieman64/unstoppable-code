/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorktreeDiscardDescription } from '@canopy/protocol/portal/worktree-discard';
import {
  WORKTREE_DISCARD_DIALOG_TEST_ID,
  WorktreeDiscardDialog,
} from '../WorktreeDiscardDialog';
import {
  WORKTREE_DISCARD_DISCONNECTED_WARNING,
  worktreeDiscardBatchPointer,
} from '../../lib/worktree-discard-copy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BASE: WorktreeDiscardDescription = {
  version: 1,
  workspaceId: 'ws',
  worktreeId: 'wt',
  createdAt: '2026-10-30T00:00:00.000Z',
  status: 'discardable',
  causes: ['source-gone'],
  sources: [
    { repoId: 'a', path: '/Volumes/Share/repo-a', state: 'gone-absent' },
    { repoId: 'b', path: '/repos/repo-b', state: 'available' },
  ],
  targets: [
    {
      kind: 'live-checkout',
      path: '/data/workspaces/ws/worktrees/wt',
      identity: '1:2',
      identityVerified: true,
      reason: 'source-gone',
    },
    {
      kind: 'git-quarantine',
      path: '/data/workspaces/ws/worktrees/.wt.archive-quarantine',
      identity: '1:3',
      identityVerified: true,
      reason: 'pending-checkout-quarantine',
    },
  ],
  alsoDeleted: ['chats', 'plans', 'cost-history'],
  preserved: ['source-working-files', 'branches'],
  mayRemain: [],
  confirmation: 'token',
};

let root: Root | null = null;

function render(
  description: WorktreeDiscardDescription,
  handlers: Partial<{
    onConfirm: () => void;
    onRetry: () => void;
    onCancel: () => void;
  }> = {},
  errorMessage: string | null = null,
): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <WorktreeDiscardDialog
        worktreeName="owl"
        description={description}
        busy={false}
        errorMessage={errorMessage}
        onConfirm={handlers.onConfirm ?? jest.fn()}
        onRetry={handlers.onRetry ?? jest.fn()}
        onCancel={handlers.onCancel ?? jest.fn()}
      />,
    );
  });
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('WorktreeDiscardDialog (CAN-5336)', () => {
  it('names every target path and missing source, warns it is permanent and may be the only copy', () => {
    render(BASE);
    const dialog = byTestId(WORKTREE_DISCARD_DIALOG_TEST_ID);
    expect(dialog.textContent).toContain('Discard worktree “owl”?');
    expect(dialog.textContent).toContain('permanently deletes these folders');
    expect(dialog.textContent).toContain("They can't be recovered.");
    const targets = Array.from(
      byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-targets`).querySelectorAll(
        'li',
      ),
    ).map((row) => row.textContent);
    expect(targets).toEqual([
      'Worktree folder/data/workspaces/ws/worktrees/wt',
      'Quarantined checkout/data/workspaces/ws/worktrees/.wt.archive-quarantine',
    ]);
    expect(dialog.textContent).toContain('may hold the only copy');
    expect(
      byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-sources`).textContent,
    ).toBe('Missing source repository/Volumes/Share/repo-a');
    expect(dialog.textContent).toContain(
      'Its chats, plans and cost history are deleted too.',
    );
    expect(
      byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-disconnected`).textContent,
    ).toBe(WORKTREE_DISCARD_DISCONNECTED_WARNING);
    expect(dialog.textContent).not.toMatch(/restore|checkpoint/i);
    expect(
      byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-confirm`).textContent,
    ).toBe('Discard worktree (source missing)');
  });

  it('names the uncommitted changes of a healthy sibling repository it deletes', () => {
    render({
      ...BASE,
      targets: [
        {
          ...BASE.targets[0],
          repositories: [
            { repoId: 'a', relativePath: 'repo-a' },
            {
              repoId: 'b',
              relativePath: 'repo-b',
              uncommittedChanges: true,
            },
            {
              repoId: 'c',
              relativePath: 'repo-c',
              uncommittedChanges: 'unknown',
            },
            {
              repoId: 'd',
              relativePath: 'repo-d',
              uncommittedChanges: false,
            },
          ],
        },
      ],
    });
    const row = byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-targets`);
    expect(row.textContent).toContain('Uncommitted changes in repo-b.');
    expect(row.textContent).toContain(
      "Couldn't check repo-c for uncommitted changes.",
    );
    expect(row.textContent).not.toContain('repo-d');
  });

  it('flags uncommitted changes in a single-repo checkout', () => {
    render({
      ...BASE,
      targets: [
        {
          ...BASE.targets[0],
          repositories: [
            { repoId: 'a', relativePath: '.', uncommittedChanges: true },
          ],
        },
      ],
    });
    expect(
      byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-targets`).textContent,
    ).toContain('Has uncommitted changes.');
  });

  it('describes a discard with no folders left and no gone source', () => {
    render({
      ...BASE,
      causes: ['stranded-removal-journal'],
      sources: [],
      targets: [],
      alsoDeleted: ['chats'],
    });
    const dialog = byTestId(WORKTREE_DISCARD_DIALOG_TEST_ID);
    expect(dialog.textContent).toContain(
      'Its folders are already gone. Discarding removes it from the list for good.',
    );
    expect(dialog.textContent).toContain('Its chats are deleted too.');
    expect(
      document.querySelector(
        `[data-testid="${WORKTREE_DISCARD_DIALOG_TEST_ID}-targets"]`,
      ),
    ).toBeNull();
    expect(dialog.textContent).not.toContain('only copy');
    expect(
      byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-confirm`).textContent,
    ).toBe('Discard worktree');
  });

  it('is destructive: focus starts on Cancel; Retry and Cancel are separate answers', () => {
    const onRetry = jest.fn();
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    render(BASE, { onRetry, onCancel, onConfirm });
    expect(document.activeElement).toBe(
      byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-cancel`),
    );
    act(() => byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-retry`).click());
    act(() => byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-cancel`).click());
    act(() => byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-confirm`).click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('disables Discard for a description that is no longer discardable and shows why', () => {
    render(
      { ...BASE, status: 'refused', refusal: { reason: 'retry-available' } },
      {},
      'Nothing needs discarding now.',
    );
    expect(
      byTestId(`${WORKTREE_DISCARD_DIALOG_TEST_ID}-confirm`),
    ).toHaveProperty('disabled', true);
    expect(byTestId('confirm-dialog-error').textContent).toBe(
      'Nothing needs discarding now.',
    );
  });

  it('points a batch row at the row menu', () => {
    expect(worktreeDiscardBatchPointer(BASE)).toBe(
      'Its source repository is missing. Discard it from the row menu.',
    );
    expect(
      worktreeDiscardBatchPointer({
        ...BASE,
        causes: ['interrupted-discard'],
      }),
    ).toBe("Its removal can't finish. Discard it from the row menu.");
  });
});
