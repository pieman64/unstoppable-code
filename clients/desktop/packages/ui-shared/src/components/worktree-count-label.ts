/** The singular and plural names of the rows a bulk action covers. */
export interface SidebarBatchUnitLabel {
  readonly singular: string;
  readonly plural: string;
}

export const WORKTREE_BATCH_UNIT: SidebarBatchUnitLabel = {
  singular: 'worktree',
  plural: 'worktrees',
};

/** "1 chat" / "3 chats", for bulk menus and the batch removal dialog. */
export function unitCountLabel(
  unit: SidebarBatchUnitLabel,
  count: number,
): string {
  return `${count} ${count === 1 ? unit.singular : unit.plural}`;
}

/** "1 worktree" / "3 worktrees", for bulk menus and the batch removal dialog. */
export function worktreeCountLabel(count: number): string {
  return unitCountLabel(WORKTREE_BATCH_UNIT, count);
}
