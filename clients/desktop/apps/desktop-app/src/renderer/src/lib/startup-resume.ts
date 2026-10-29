import type {
  LastActiveContext,
  SidebarItem,
} from '@canopy/desktop-shared/types';

/** Preference fields consumed by {@link resolveStartupResumeTarget}. */
export interface StartupResumePreferences {
  lastActiveContext: LastActiveContext | null;
  lastSelectedWorktreeProjectId: string;
  lastSelectedWorktreeId: string;
}

/**
 * Where the startup Resume offer would take the user. Startup never navigates
 * to this target automatically — the app always lands on the Home composer and
 * surfaces this as a dismissible "Resume" card instead (see
 * `startupResumeStore`).
 */
export type StartupResumeTarget =
  | { kind: 'worktree'; projectId: string; worktreeId: string }
  | { kind: 'cowork'; workspaceId: string; workEntryId?: string };

/**
 * Pure decision function for the one-time startup resume-offer pass.
 *
 * Rules:
 * - A `cowork` `lastActiveContext` offers that cowork workspace's chat page,
 *   but only when the workspace still exists as a cowork sidebar entry. The
 *   legacy `lastSelectedWorktree*` fields are never consulted here — cowork
 *   flows never rewrite them, so they can still name an old worktree.
 * - A `worktree` `lastActiveContext` is authoritative: offer its target if it
 *   still exists, otherwise offer nothing. Legacy fields are never consulted.
 * - Legacy fields are a migration-only fallback used solely when
 *   `lastActiveContext` is `null` (preferences written before the field
 *   existed).
 * - A dead target yields `null` (no offer) — startup already lands on Home,
 *   so there is no separate home-redirect outcome anymore.
 */
export function resolveStartupResumeTarget(
  preferences: StartupResumePreferences,
  projects: SidebarItem[],
): StartupResumeTarget | null {
  const ctx = preferences.lastActiveContext;
  if (ctx?.kind === 'cowork') {
    const coworkExists = projects.some(
      (candidate) =>
        candidate.id === ctx.workspaceId && candidate.type === 'cowork',
    );
    return coworkExists
      ? {
          kind: 'cowork',
          workspaceId: ctx.workspaceId,
          ...(ctx.workEntryId !== undefined
            ? { workEntryId: ctx.workEntryId }
            : {}),
        }
      : null;
  }

  let projectId: string;
  let worktreeId: string;
  if (ctx?.kind === 'worktree') {
    projectId = ctx.workspaceId;
    worktreeId = ctx.worktreeId;
  } else {
    projectId = preferences.lastSelectedWorktreeProjectId;
    worktreeId = preferences.lastSelectedWorktreeId;
  }

  if (!projectId || !worktreeId) {
    return null;
  }

  const project = projects.find((candidate) => candidate.id === projectId);
  const worktreeExists =
    project !== undefined &&
    project.type !== 'cowork' &&
    project.worktrees.some((worktree) => worktree.id === worktreeId);

  return worktreeExists ? { kind: 'worktree', projectId, worktreeId } : null;
}
