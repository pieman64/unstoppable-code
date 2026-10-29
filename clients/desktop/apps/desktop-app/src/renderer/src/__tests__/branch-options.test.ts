import type { BranchEntry, RepoBranchInfo } from '@canopy/desktop-shared/types';
import {
  collapseBranchDuplicates,
  getBranchProvenanceBadge,
  preserveBranchOption,
  resolveDisplayedBaseBranch,
} from '../components/worktree/branch-options';

function createBranchEntry(name: string, isRemote: boolean): BranchEntry {
  const hasLocalRef = !isRemote;
  const hasRemoteRef = isRemote;
  return {
    name,
    isRemote,
    isCurrent: false,
    isUsedByWorktree: false,
    hasLocalRef,
    hasRemoteRef,
  };
}

function createRepoBranchInfo(baseBranch: string | undefined): RepoBranchInfo {
  return {
    repoId: 'repo-1',
    repoName: 'Repo 1',
    branch: 'feature/test',
    baseBranch,
    insertions: 0,
    deletions: 0,
    commitsAhead: false,
    hasUncommittedChanges: false,
    hasRemoteTrackingBranch: false,
    hasUnpushedCommits: false,
    hasBranchBeenPushed: false,
  };
}

describe('branch-options', () => {
  it('collapses duplicate local and remote branch entries while preserving provenance', () => {
    expect(
      collapseBranchDuplicates([
        createBranchEntry('main', false),
        createBranchEntry('main', true),
        createBranchEntry('release', true),
      ]),
    ).toEqual([
      {
        name: 'main',
        isRemote: false,
        isCurrent: false,
        isUsedByWorktree: false,
        hasLocalRef: true,
        hasRemoteRef: true,
      },
      createBranchEntry('release', true),
    ]);
  });

  it('preserves a missing tracked branch in the option list', () => {
    expect(
      preserveBranchOption([createBranchEntry('main', false)], 'release/1.2'),
    ).toEqual([
      {
        name: 'release/1.2',
        isRemote: false,
        isCurrent: false,
        isUsedByWorktree: false,
        hasLocalRef: false,
        hasRemoteRef: false,
      },
      createBranchEntry('main', false),
    ]);
  });

  it('returns a local badge only for local-only branches', () => {
    expect(
      getBranchProvenanceBadge({
        hasLocalRef: true,
        hasRemoteRef: false,
      }),
    ).toBe('local');
  });

  it('returns a remote badge only for remote-only branches', () => {
    expect(
      getBranchProvenanceBadge({
        hasLocalRef: false,
        hasRemoteRef: true,
      }),
    ).toBe('remote');
  });

  it('returns no badge when a branch exists both locally and remotely', () => {
    expect(
      getBranchProvenanceBadge({
        hasLocalRef: true,
        hasRemoteRef: true,
      }),
    ).toBeNull();
  });

  it('returns no badge for preserved branches with no matching refs', () => {
    expect(
      getBranchProvenanceBadge({
        hasLocalRef: false,
        hasRemoteRef: false,
      }),
    ).toBeNull();
  });

  it('uses the threaded single-repo base branch before repo branch metadata', () => {
    expect(
      resolveDisplayedBaseBranch({
        isMultiRepo: false,
        repoBranches: [createRepoBranchInfo('develop')],
        baseBranch: 'release/1.2',
        trackedBaseBranch: 'main',
      }),
    ).toBe('release/1.2');
  });

  it('falls back to tracked single-repo base branch before repo branch metadata', () => {
    expect(
      resolveDisplayedBaseBranch({
        isMultiRepo: false,
        repoBranches: [createRepoBranchInfo('develop')],
        baseBranch: undefined,
        trackedBaseBranch: 'release/1.2',
      }),
    ).toBe('release/1.2');
  });

  it('returns a shared multi-repo base branch only when all repos match', () => {
    const sharedRepoBranches: RepoBranchInfo[] = [
      { ...createRepoBranchInfo('main'), repoId: 'repo-1' },
      { ...createRepoBranchInfo('main'), repoId: 'repo-2' },
    ];
    const mixedRepoBranches: RepoBranchInfo[] = [
      { ...createRepoBranchInfo('main'), repoId: 'repo-1' },
      { ...createRepoBranchInfo('develop'), repoId: 'repo-2' },
    ];

    expect(
      resolveDisplayedBaseBranch({
        isMultiRepo: true,
        repoBranches: sharedRepoBranches,
        baseBranch: undefined,
        trackedBaseBranch: undefined,
      }),
    ).toBe('main');
    expect(
      resolveDisplayedBaseBranch({
        isMultiRepo: true,
        repoBranches: mixedRepoBranches,
        baseBranch: undefined,
        trackedBaseBranch: undefined,
      }),
    ).toBeNull();
  });
});
