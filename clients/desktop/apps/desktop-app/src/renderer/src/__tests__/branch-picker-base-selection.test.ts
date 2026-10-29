import type { BranchEntry } from '@canopy/desktop-shared/types';
import { resolveBranchPickerBaseSelection } from '../components/worktree/branch-picker-base-selection';

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

describe('resolveBranchPickerBaseSelection', () => {
  it('marks the default branch as remote when only the remote ref exists', () => {
    const selection = resolveBranchPickerBaseSelection(
      [createBranchEntry('main', true)],
      null,
      'main',
    );

    expect(selection).toEqual({
      name: 'main',
      isRemote: true,
    });
  });

  it('uses the remote base branch when both local and remote refs exist', () => {
    const selection = resolveBranchPickerBaseSelection(
      [createBranchEntry('main', false), createBranchEntry('main', true)],
      'main',
      'main',
    );

    expect(selection).toEqual({
      name: 'main',
      isRemote: true,
    });
  });

  it('keeps manually typed remote-only base branches marked as remote', () => {
    const selection = resolveBranchPickerBaseSelection(
      [createBranchEntry('release/1.2', true)],
      'release/1.2',
      'main',
    );

    expect(selection).toEqual({
      name: 'release/1.2',
      isRemote: true,
    });
  });

  it('falls back to main when neither a preferred nor default branch is provided', () => {
    const selection = resolveBranchPickerBaseSelection([], null, null);

    expect(selection).toEqual({
      name: 'main',
      isRemote: false,
    });
  });
});
