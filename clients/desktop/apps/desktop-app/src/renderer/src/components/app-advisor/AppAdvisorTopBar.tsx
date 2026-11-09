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
 * - a static branded App Advisor title filling the middle (Electron drag
 *   region) — deliberately NOT a `projectsStore` lookup, the popout renderer
 *   never loads the projects list;
 * - pinned right, as in the cowork top bar: the archived-chats control,
 *   scoped to the active Work Entry's `(app-advisor, entryId)` chat unit, the
 *   "Open in" dropdown and the layout dropdown.
 *
 * New Chat lives in the panel tab strip's `+`, matching the worktree and
 * cowork top bars. The frame (fill, divider, 9px right edge) matches the
 * cowork bar too, and the window's inset layout clears both the same way.
 *
 * No `CollapsedTitlebarToggle` (the popout has no collapsible main-window
 * titlebar) and no PrStatusBar/git chrome.
 */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { memo, type JSX } from 'react';
import { AppAdvisorIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { OpenDropdown } from '@/components/worktree/OpenDropdown';
import { ArchivedChatsControl } from '@/components/chat/ArchivedChatsControl';
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
      // The 43px row height is fixed by the titlebar corner overlay
      // (`APP_ADVISOR_TITLEBAR_ROW_HEIGHT_PX`), not the cowork bar's 46px.
      className="@container/prbar flex min-h-10.75 shrink-0 items-stretch border-b bg-secondary"
    >
      <div
        className="electron-drag shrink-0 self-stretch overflow-hidden transition-[width] duration-150 ease-out"
        style={{ width: cornerWidth }}
        data-testid="app-advisor-top-bar-corner"
      />
      <div className="electron-drag flex min-w-0 flex-1 items-center gap-1.5 px-3">
        <AppAdvisorIcon size="sm" className="shrink-0 fg-secondary" />
        <span className="select-none truncate text-xs font-medium fg-secondary">
          {ORCHESTRATOR_LABEL}
        </span>
      </div>
      <div className="electron-drag flex shrink-0 items-center gap-2 pr-2.25">
        <ArchivedChatsControl
          scope={{ projectId: workspaceId, worktreeId: activeWorkEntryId }}
        />
        <OpenDropdown projectId={workspaceId} worktreeId={activeWorkEntryId} />
        <SaveLayoutDefaultControl
          projectId={workspaceId}
          worktreeId={activeWorkEntryId}
        />
      </div>
    </div>
  );
});
