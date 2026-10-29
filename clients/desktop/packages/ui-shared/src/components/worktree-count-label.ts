/** "1 worktree" / "3 worktrees", for bulk menus and the batch removal dialog. */
export function worktreeCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'worktree' : 'worktrees'}`;
}
