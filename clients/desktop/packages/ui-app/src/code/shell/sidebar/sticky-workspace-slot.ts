import { SIDEBAR_ROOT_SELECTOR } from './sidebar-surfaces';

export const STICKY_WORKSPACE_SLOT_SELECTOR =
  '[data-sidebar-sticky-workspace-slot]';
export const STICKY_WORKSPACE_SLOT_ROW_SELECTOR =
  '[data-sidebar-sticky-slot-workspace-id]';

/**
 * Finds the dedicated sticky-slot host for a workspace without coupling the
 * workspace row components to the parent section's render lifecycle.
 *
 * Two scopes, narrowest first. The legacy section renders its slot rows inside
 * itself, so the section scope answers and nothing outside it can interfere.
 * A shared surface's rows are portaled into the rail's band, which is a
 * SIBLING of that section — so scoping to the section alone found nothing and
 * the reserved band silently stayed empty. The rail scope is the fallback.
 *
 * The two never both hold rows: which section renders is decided by the
 * shared-sidebar flag, so widening the search cannot make the narrow case
 * resolve differently.
 */
export function findStickyWorkspaceSlotHost(
  workspaceRoot: HTMLElement | null,
  workspaceId: string,
): HTMLElement | null {
  const matchIn = (scope: HTMLElement | null | undefined): HTMLElement | null =>
    Array.from(
      scope?.querySelectorAll<HTMLElement>(
        STICKY_WORKSPACE_SLOT_ROW_SELECTOR,
      ) ?? [],
    ).find(
      (candidate) =>
        candidate.dataset.sidebarStickySlotWorkspaceId === workspaceId,
    ) ?? null;

  return (
    matchIn(
      workspaceRoot?.closest<HTMLElement>(
        '[data-testid="sidebar-section-code"]',
      ),
    ) ?? matchIn(workspaceRoot?.closest<HTMLElement>(SIDEBAR_ROOT_SELECTOR))
  );
}
