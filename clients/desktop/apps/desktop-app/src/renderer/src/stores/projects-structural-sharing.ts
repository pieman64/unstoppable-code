import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';

// Projects arrive over IPC as fresh copies on every reload and worktree event.
// Reusing the previous objects for unchanged data keeps identities stable, so
// unchanged reloads do not re-render, and any older list something still holds
// shares its worktrees and discovery data instead of carrying a copy of each.

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Deep equality for the plain (JSON-like) data the projects IPC delivers. */
function plainDataEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => plainDataEqual(item, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        plainDataEqual(left[key], right[key]),
    )
  );
}

function shareById<T extends { readonly id: string }>(
  previous: T[],
  next: T[],
  share: (previousItem: T, nextItem: T) => T,
): T[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const shared = next.map((item) => {
    const previousItem = previousById.get(item.id);
    return previousItem === undefined ? item : share(previousItem, item);
  });
  const unchanged =
    shared.length === previous.length &&
    shared.every((item, index) => item === previous[index]);
  return unchanged ? previous : shared;
}

/** `next`, reusing `previous` or its `discovery` wherever they are equal. */
function shareUnchangedWorktree(
  previous: WorktreeData,
  next: WorktreeData,
): WorktreeData {
  if (plainDataEqual(previous, next)) return previous;
  if (
    previous.discovery !== undefined &&
    next.discovery !== undefined &&
    previous.discovery !== next.discovery &&
    plainDataEqual(previous.discovery, next.discovery)
  ) {
    return { ...next, discovery: previous.discovery };
  }
  return next;
}

/** `next`, reusing the previous worktrees that are unchanged (matched by id). */
function shareUnchangedWorktrees(
  previous: WorktreeData[],
  next: WorktreeData[],
): WorktreeData[] {
  return shareById(previous, next, shareUnchangedWorktree);
}

function shareUnchangedProject(
  previous: SidebarItem,
  next: SidebarItem,
): SidebarItem {
  if (plainDataEqual(previous, next)) return previous;
  if (previous.type === 'cowork' || next.type === 'cowork') return next;
  const worktrees = shareUnchangedWorktrees(previous.worktrees, next.worktrees);
  return worktrees === next.worktrees ? next : { ...next, worktrees };
}

/**
 * `next`, reusing every previous project, worktree and discovery object that
 * is unchanged, and the previous array itself when nothing changed.
 */
export function shareUnchangedProjects(
  previous: SidebarItem[],
  next: SidebarItem[],
): SidebarItem[] {
  return shareById(previous, next, shareUnchangedProject);
}
