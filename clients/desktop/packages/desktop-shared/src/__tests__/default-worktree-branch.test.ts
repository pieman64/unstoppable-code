import * as protocol from '@canopy/protocol/worktree-branch-names';
import * as shim from '../lib/default-worktree-branch';

// The behavioural cases live with the implementation in @canopy/protocol.
describe('default-worktree-branch shim', () => {
  it('re-exports the protocol helpers unchanged', () => {
    expect(shim.makeDefaultWorktreeBranchName).toBe(
      protocol.makeDefaultWorktreeBranchName,
    );
    expect(shim.isDefaultWorktreeBranchName).toBe(
      protocol.isDefaultWorktreeBranchName,
    );
    expect(shim.DEFAULT_WORKTREE_DISPLAY_NAME).toBe(
      protocol.DEFAULT_WORKTREE_DISPLAY_NAME,
    );
  });
});
