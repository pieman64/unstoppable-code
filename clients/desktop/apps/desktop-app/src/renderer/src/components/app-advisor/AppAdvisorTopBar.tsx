/**
 * App Advisor workspace top bar — the popout's cowork top-bar variant.
 * Left to right:
 *
 * - an animated corner spacer (`app-advisor-top-bar-corner`) that widens
 *   only while the nav is collapsed: it reserves the persistent
 *   {@link AppAdvisorTitlebarCorner} overlay's footprint (traffic lights +
 *   nav controls) inside this bar's own background/border, so this bar's
 *   controls start right after the overlay — the same pattern as the main
 *   window's `CollapsedTitlebarToggle` spacer. The overlay itself owns the
 *   nav-control buttons; this bar renders none of them;
 * - (New Chat and the archived-chats control moved into the panel tab
 *   strip — the `+` and the tab-strip accessory — matching the worktree and
 *   cowork top bars; the line below is historical context for the
 *   scoped standalone store's `startNewChat`, opening a new chat tab within
 *   the ACTIVE Work Entry (reusing the entry's empty active tab);
 * - the archived-chats control, explicitly scoped to the active Work Entry's
 *   `(app-advisor, entryId)` chat unit;
 * - a static branded App Advisor title filling the middle (Electron drag
 *   region) — deliberately NOT a `projectsStore` lookup, the popout renderer
 *   never loads the projects list;
 * - the "Open in" dropdown and the layout dropdown pinned right.
 *
 * No `CollapsedTitlebarToggle` (the popout has no collapsible main-window
 * titlebar) and no PrStatusBar/git chrome.
 */
import { memo, type JSX } from 'react';
import { AppAdvisorIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { OpenDropdown } from '@/components/worktree/OpenDropdown';
import { SaveLayoutDefaultControl } from '@/components/panels/SaveLayoutDefaultControl';
import { shouldReserveSidebarTrafficLightRegion } from '../sidebar-layout';
import { appAdvisorTitlebarCornerWidthCss } from '@/components/app-advisor/AppAdvisorTitlebarCorner';
import { localPlatform } from '@/lib/local-platform';

export interface AppAdvisorTopBarProps {
  /** Whether the App Advisor nav is collapsed (zero-width). */
  navCollapsed: boolean;
}

export const AppAdvisorTopBar = memo(function AppAdvisorTopBar({
  navCollapsed,
}: AppAdvisorTopBarProps): JSX.Element | null {
  const workspaceId = useStandaloneChatStore((s) => s.activeChatProjectId);
  const activeWorkEntryId = useStandaloneChatStore((s) => s.activeWorkEntryId);

  // The workspace surface only mounts this bar once an entry is active;
  // this is a defensive guard for the transition frames around switches.
  if (activeWorkEntryId === null) {
    return null;
  }

  const platform: NodeJS.Platform = localPlatform();
  const cornerWidth = navCollapsed
    ? appAdvisorTitlebarCornerWidthCss(
        shouldReserveSidebarTrafficLightRegion(platform),
      )
    : 0;

  return (
    <div
      data-testid="app-advisor-top-bar"
      // `@container/prbar` on the root: OpenDropdown's compact-mode label
      // (`@[560px]/prbar:`) resolves only against an ancestor container —
      // same wiring as the worktree and cowork top bars.
      className="@container/prbar flex min-h-10.75 shrink-0 items-stretch"
    >
      <div
        className="electron-drag shrink-0 self-stretch overflow-hidden border-b bg-base/50 transition-[width] duration-150 ease-out"
        style={{ width: cornerWidth }}
        data-testid="app-advisor-top-bar-corner"
      />
      <div className="electron-drag flex min-w-0 flex-1 items-center gap-1.5 border-b bg-base/50 px-3">
        <AppAdvisorIcon className="h-3.5 w-3.5 shrink-0 fg-secondary" />
        <span className="select-none truncate text-xs font-medium fg-secondary">
          App Advisor
        </span>
      </div>
      <div className="electron-drag flex shrink-0 items-center gap-1 border-b bg-base/50 pr-3">
        <OpenDropdown projectId={workspaceId} worktreeId={activeWorkEntryId} />
        <SaveLayoutDefaultControl
          projectId={workspaceId}
          worktreeId={activeWorkEntryId}
        />
      </div>
    </div>
  );
});
