import { parseWorktreeListPorcelain } from '../lib/git';

describe('parseWorktreeListPorcelain', () => {
  it('maps checked-out branches to worktree paths', () => {
    const output = [
      'worktree /Users/me/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/develop',
      '',
      'worktree /Users/me/.canopy/workspaces/w/worktrees/x',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feature/foo',
      '',
      'worktree /Users/me/.canopy/repo-shadows/abc/checkout',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n');

    const result = parseWorktreeListPorcelain(output);
    expect(result.get('develop')).toBe('/Users/me/repo');
    expect(result.get('feature/foo')).toBe(
      '/Users/me/.canopy/workspaces/w/worktrees/x',
    );
    expect(result.size).toBe(2); // detached entries are skipped
  });

  it('returns an empty map for empty output', () => {
    expect(parseWorktreeListPorcelain('').size).toBe(0);
  });
});
