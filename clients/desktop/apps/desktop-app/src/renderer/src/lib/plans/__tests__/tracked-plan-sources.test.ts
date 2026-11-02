import type {
  DetectedPlanEntry,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import { createTrackedPlanSourceLookup } from '../tracked-plan-sources';

function plan(
  overrides: Partial<TrackedPlanData> & Pick<TrackedPlanData, 'id'>,
): TrackedPlanData {
  return {
    projectId: 'p',
    worktreeId: 'w',
    source: 'imported',
    title: 'Plan',
    content: '# Plan',
    reviewStatus: 'pending',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    latestRevisionNumber: 1,
    revisions: [],
    linkedExecutionIds: [],
    ...overrides,
  };
}

function entry(overrides: Partial<DetectedPlanEntry>): DetectedPlanEntry {
  return {
    id: 'e',
    sourceRepoId: 'repo-1',
    sourceFilePath: 'docs/plan.md',
    status: 'detected',
    bannerSeen: false,
    detectedInChatId: 'chat-1',
    detectedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createTrackedPlanSourceLookup', () => {
  it('finds an imported plan by repo and path', () => {
    const lookup = createTrackedPlanSourceLookup(
      [
        plan({ id: 'a', sourceRepoId: 'repo-1', sourceFilePath: 'docs/a.md' }),
        plan({
          id: 'agent',
          source: 'claude',
          sourceRepoId: 'repo-1',
          sourceFilePath: 'docs/b.md',
        }),
      ],
      [],
    );

    expect(lookup('repo-1', 'docs/a.md')).toBe('a');
    expect(lookup('repo-2', 'docs/a.md')).toBeUndefined();
    // Only imported plans name a source file the user might import again.
    expect(lookup('repo-1', 'docs/b.md')).toBeUndefined();
  });

  it('treats the worktree sentinel as the workspace root', () => {
    const lookup = createTrackedPlanSourceLookup(
      [plan({ id: 'a', sourceRepoId: '__worktree__', sourceFilePath: 'p.md' })],
      [],
    );

    expect(lookup(WORKSPACE_ROOT_REPO_ID, 'p.md')).toBe('a');
  });

  it('normalizes Windows separators', () => {
    const lookup = createTrackedPlanSourceLookup(
      [
        plan({
          id: 'a',
          sourceRepoId: 'repo-1',
          sourceFilePath: 'docs\\plans\\a.md',
        }),
      ],
      [],
    );

    expect(lookup('repo-1', 'docs/plans/a.md')).toBe('a');
  });

  it('matches the worktree root under its file root id', () => {
    const lookup = createTrackedPlanSourceLookup(
      [
        plan({
          id: 'a',
          sourceRepoId: WORKSPACE_ROOT_REPO_ID,
          sourceFilePath: 'p.md',
        }),
      ],
      [],
      'single-repo-workspace',
    );

    expect(lookup('single-repo-workspace', 'p.md')).toBe('a');
  });

  it('never matches a Browse import, which keeps no repo id', () => {
    const lookup = createTrackedPlanSourceLookup(
      [plan({ id: 'a', sourceFilePath: 'plan.md' })],
      [],
    );

    expect(lookup(WORKSPACE_ROOT_REPO_ID, 'plan.md')).toBeUndefined();
  });

  it('uses imported detections only while their plan still exists', () => {
    const imported = entry({ status: 'imported', importedPlanId: 'kept' });
    const deleted = entry({
      sourceFilePath: 'docs/gone.md',
      status: 'imported',
      importedPlanId: 'gone',
    });
    const lookup = createTrackedPlanSourceLookup(
      [plan({ id: 'kept', source: 'detected' })],
      [imported, deleted],
    );

    expect(lookup('repo-1', 'docs/plan.md')).toBe('kept');
    expect(lookup('repo-1', 'docs/gone.md')).toBeUndefined();
  });
});
