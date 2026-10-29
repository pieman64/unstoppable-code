import {
  resolvePipelineStatus,
  type ResolvePipelineStatusInput,
} from '../resolvePipelineStatus';

const WORKTREE_KEY = 'project-1/wt-1';

function buildInput(
  overrides: Partial<Omit<ResolvePipelineStatusInput, 'worktreeKey'>> = {},
): ResolvePipelineStatusInput {
  return {
    worktreeKey: WORKTREE_KEY,
    pipelineRunningWorktreeKeys: new Set<string>(),
    pipelineUnseenWorktreeKeys: new Set<string>(),
    pipelineUnseenFailedWorktreeKeys: new Set<string>(),
    pipelinePausedWorktreeKeys: new Set<string>(),
    ...overrides,
  };
}

describe('resolvePipelineStatus', () => {
  it('returns undefined when the worktree has no pipeline activity', () => {
    expect(resolvePipelineStatus(buildInput())).toBeUndefined();
  });

  it('reports a running pipeline above every other state', () => {
    expect(
      resolvePipelineStatus(
        buildInput({
          pipelineRunningWorktreeKeys: new Set([WORKTREE_KEY]),
          pipelineUnseenWorktreeKeys: new Set([WORKTREE_KEY]),
          pipelineUnseenFailedWorktreeKeys: new Set([WORKTREE_KEY]),
          pipelinePausedWorktreeKeys: new Set([WORKTREE_KEY]),
        }),
      ),
    ).toBe('running');
  });

  // A paused execution is seen-eligible (`isSeenEligibleStatus` in
  // pipelineRunsStore), so the moment a run pauses it joins the unseen set as
  // well. The row must still report the blocker rather than the green
  // "Pipeline completed" glyph.
  it('reports a freshly paused pipeline as paused, not as an unseen result', () => {
    expect(
      resolvePipelineStatus(
        buildInput({
          pipelineUnseenWorktreeKeys: new Set([WORKTREE_KEY]),
          pipelinePausedWorktreeKeys: new Set([WORKTREE_KEY]),
        }),
      ),
    ).toBe('paused');
  });

  it('keeps reporting paused once the pause has been acknowledged', () => {
    expect(
      resolvePipelineStatus(
        buildInput({ pipelinePausedWorktreeKeys: new Set([WORKTREE_KEY]) }),
      ),
    ).toBe('paused');
  });

  it('lets an unseen failure outrank a pause on a different run', () => {
    expect(
      resolvePipelineStatus(
        buildInput({
          pipelineUnseenWorktreeKeys: new Set([WORKTREE_KEY]),
          pipelineUnseenFailedWorktreeKeys: new Set([WORKTREE_KEY]),
          pipelinePausedWorktreeKeys: new Set([WORKTREE_KEY]),
        }),
      ),
    ).toBe('unseen-failure');
  });

  it('reports an unacknowledged terminal result as unseen', () => {
    expect(
      resolvePipelineStatus(
        buildInput({ pipelineUnseenWorktreeKeys: new Set([WORKTREE_KEY]) }),
      ),
    ).toBe('unseen');
  });

  it('ignores activity belonging to other worktrees', () => {
    expect(
      resolvePipelineStatus(
        buildInput({
          pipelineRunningWorktreeKeys: new Set(['project-1/wt-2']),
          pipelinePausedWorktreeKeys: new Set(['project-2/wt-9']),
        }),
      ),
    ).toBeUndefined();
  });
});
