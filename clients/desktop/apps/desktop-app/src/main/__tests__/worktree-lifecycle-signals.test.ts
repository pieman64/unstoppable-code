import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  publishWorktreeLifecycleChange,
  publishWorktreeListWrite,
  subscribeWorktreeLifecycleChanges,
} from '../lib/worktree-lifecycle-signals';

const MAIN_DIR = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('worktree lifecycle signals', () => {
  it('delivers each change to every listener, past a throwing one', () => {
    const received: string[] = [];
    const unsubscribeThrowing = subscribeWorktreeLifecycleChanges(() => {
      throw new Error('listener failed');
    });
    const unsubscribe = subscribeWorktreeLifecycleChanges((change) =>
      received.push(change),
    );

    expect(() =>
      publishWorktreeLifecycleChange('projects-saved'),
    ).not.toThrow();
    unsubscribe();
    publishWorktreeLifecycleChange('workspace-deleted');
    unsubscribeThrowing();

    expect(received).toEqual(['projects-saved']);
  });

  // Branch recording and the GitHub poller write worktrees.json; an
  // unconditional signal there would re-sync the branch observer on every poll.
  it('is published only at lifecycle points and membership-changing list writes', () => {
    const publishers = (name: string): string[] =>
      sourceFiles(MAIN_DIR)
        .filter((path) => readFileSync(path, 'utf8').includes(`${name}(`))
        .map((path) => relative(MAIN_DIR, path))
        .sort();

    expect(publishers('publishWorktreeLifecycleChange')).toEqual([
      // Another origin's list: degraded read, first sight, broad recovery.
      'canopy-runtime/workspace-commit-event-handlers.ts',
      'ipc/projects.ts',
      'lib/workspace-deletion.ts',
      'lib/worktree-lifecycle-signals.ts',
      'lib/worktree-registry-reconciliation.ts',
      'lib/worktree-service.ts',
    ]);
    expect(publishers('publishWorktreeListWrite')).toEqual([
      // Another origin's list commit, diffed against the last read membership.
      'canopy-runtime/workspace-commit-event-handlers.ts',
      'canopy-runtime/workspace-commit-events.ts',
      'lib/workspace-persistence.ts',
      'lib/worktree-lifecycle-signals.ts',
    ]);
  });

  describe('publishWorktreeListWrite', () => {
    function changesFor(
      previous: Parameters<typeof publishWorktreeListWrite>[0],
      next: Parameters<typeof publishWorktreeListWrite>[1],
    ): string[] {
      const received: string[] = [];
      const unsubscribe = subscribeWorktreeLifecycleChanges((change) =>
        received.push(change),
      );
      publishWorktreeListWrite(previous, next);
      unsubscribe();
      return received;
    }

    it('stays quiet when a write keeps the same rows and setup state', () => {
      expect(
        changesFor(
          [{ id: 'wt-1' }, { id: 'wt-2', setupPhase: 'git-ready' }],
          [{ id: 'wt-2' }, { id: 'wt-1', setupPhase: 'git-ready' }],
        ),
      ).toEqual([]);
    });

    it.each([
      ['adds a row', [{ id: 'wt-1' }], [{ id: 'wt-1' }, { id: 'wt-2' }]],
      ['removes a row', [{ id: 'wt-1' }, { id: 'wt-2' }], [{ id: 'wt-1' }]],
      [
        'finishes a pending checkout',
        [{ id: 'wt-1', setupPhase: 'git-pending' }],
        [{ id: 'wt-1', setupPhase: 'git-ready' }],
      ],
      ['creates the list', [], [{ id: 'wt-1', setupPhase: 'git-pending' }]],
    ])('signals membership when a write %s', (_label, previous, next) => {
      expect(changesFor(previous, next)).toEqual(['worktree-list-membership']);
    });
  });
});
