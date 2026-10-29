import {
  formatPendingSystemInstructionBlock,
  withWorktreeRelocationInstruction,
} from '../lib/pending-system-instructions';

describe('worktree relocation system instructions', () => {
  it('makes the destination cwd authoritative while preserving other instructions', () => {
    const instructions = withWorktreeRelocationInstruction(
      [{ id: 'plan', text: 'Use the approved plan.' }],
      '/worktrees/source',
      '/worktrees/destination',
    );

    expect(instructions.map(({ id }) => id)).toEqual([
      'plan',
      'worktree-relocation',
    ]);
    const block = formatPendingSystemInstructionBlock(instructions);
    expect(block).toContain('The current working directory and project root');
    expect(block).toContain('/worktrees/source');
    expect(block).toContain('/worktrees/destination');
  });

  it('replaces an unconsumed relocation when the chat is branched again', () => {
    const first = withWorktreeRelocationInstruction(
      [{ id: 'plan', text: 'Keep the persisted plan.' }],
      '/worktrees/a',
      '/worktrees/b',
    );
    const second = withWorktreeRelocationInstruction(
      first,
      '/worktrees/b',
      '/worktrees/c',
    );

    expect(second.map(({ id }) => id)).toEqual(['plan', 'worktree-relocation']);
    expect(second[0]?.text).toBe('Keep the persisted plan.');
    expect(second[1]?.text).not.toContain('/worktrees/a');
    expect(second[1]?.text).toContain('/worktrees/b');
    expect(second[1]?.text).toContain('/worktrees/c');
  });
});

it('queues branch context without a follow-up and replaces previous location metadata', () => {
  const previous = withWorktreeRelocationInstruction(
    undefined,
    '/old',
    '/source',
    { sourceBranch: 'older-branch' },
  );
  const next = withWorktreeRelocationInstruction(
    [
      ...previous,
      { id: 'independent-agent-start', text: 'Stale tool follow-up' },
    ],
    '/source',
    '/new',
    { sourceBranch: 'source-feature' },
  );
  const block = formatPendingSystemInstructionBlock(next);
  expect(next).toHaveLength(1);
  expect(block).toContain('fresh branch and working directory');
  expect(block).toContain('New working directory: "/new"');
  expect(block).toContain('Originating worktree location: "/source"');
  expect(block).toContain('Originating branch: "source-feature"');
  expect(block).toContain('read-only reference');
  expect(block).toContain('Limit all changes to the new working directory');
  expect(block).not.toContain('older-branch');
  expect(block).not.toContain('Stale tool follow-up');
  expect(block).not.toContain('Follow-up instruction');
});
