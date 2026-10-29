import {
  getSidebarNavItemDefs as getSharedSidebarNavItemDefs,
  type SidebarNavItemDef,
} from '@canopy/ui-app';

export type { SidebarNavItemDef };

/**
 * Label + icon per customizable nav key.
 *
 * The registry itself now lives in `@canopy/ui-app` so the desktop sidebar and
 * the web portal sidebar render one vocabulary rather than two hand-maintained
 * lists. This wrapper keeps the desktop call sites' import path and their
 * `Record<string, …>` shape, since `AppSidebar` and `CustomizeSidebarModal`
 * look defs up by keys read from the user's persisted (untrusted) layout.
 *
 * Presentation-only; activation and state (active page, App Advisor
 * thinking/unread, portal tone) are resolved by AppSidebar at render time.
 */
export function getSidebarNavItemDefs(): Record<string, SidebarNavItemDef> {
  return getSharedSidebarNavItemDefs();
}
