/**
 * Persistent titlebar corner for the App Advisor popout — the popout analog
 * of the main window's corner overlay (`App.tsx` + `SidebarToggleButton`).
 *
 * Rendered once by {@link AppAdvisorWorkspaceSurface} as an absolutely
 * positioned overlay at constant window coordinates: a drag spacer covering
 * the macOS traffic lights, then the nav controls immediately to their
 * right — expand/collapse toggle (left-most), settings, new work entry.
 * Because the overlay never moves, the controls stay put through the nav's
 * expand/collapse width transition; only the surface beneath them changes
 * (expanded: the nav's `bg-sidebar` header row; collapsed: the top bar's
 * corner spacer, see `app-advisor-top-bar-corner`).
 *
 * The header row is `h-10.75` (43px) here, in the nav's header spacer and in
 * the top bar, and its controls sit on the row's midpoint. Electron main
 * centres the macOS traffic lights on that same midpoint at every interface
 * scale (`appAdvisorWindowButtonPosition` in
 * `@canopy/desktop-shared/lib/titlebar-geometry`), so a change to the row's
 * height must update `APP_ADVISOR_TITLEBAR_ROW_HEIGHT_PX` too.
 */
import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import { memo, useCallback, type JSX } from 'react';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { dismissPageLikeViewers } from '@/lib/dismissPageLikeViewers';
import {
  PlusMediumIcon,
  SettingsIcon,
  SidebarHiddenLeftWideIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  shouldReserveSidebarTrafficLightRegion,
  titlebarToggleLeadingCss,
  TITLEBAR_TOGGLE_FOOTPRINT_PX,
  TITLEBAR_TOGGLE_GAP_PX,
  withTrafficLightReserveCss,
} from '../sidebar-layout';
import { TitlebarIconButton } from '@canopy/ui-shared';
import { localPlatform } from '@/lib/local-platform';

/** Controls hosted in the corner: toggle, settings, new entry. */
const CORNER_CONTROL_COUNT = 3;

/** Trailing padding after the corner controls (main-app corner parity). */
const CORNER_TRAILING_PX = 8;

/**
 * Total corner footprint as a CSS length. The top bar's collapsed spacer
 * reserves exactly this width so its own controls start right after the
 * overlay. The traffic-light reserve stays physical under the
 * interface-scale zoom; the gap, controls and trailing pad zoom with the UI.
 */
export function appAdvisorTitlebarCornerWidthCss(
  reserveTrafficLights: boolean,
): string {
  return withTrafficLightReserveCss(
    reserveTrafficLights,
    TITLEBAR_TOGGLE_GAP_PX +
      CORNER_CONTROL_COUNT * TITLEBAR_TOGGLE_FOOTPRINT_PX +
      CORNER_TRAILING_PX,
  );
}

export interface AppAdvisorTitlebarCornerProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Opens the in-popout App Advisor settings modal. */
  onOpenSettings: () => void;
}

export const AppAdvisorTitlebarCorner = memo(function AppAdvisorTitlebarCorner({
  collapsed,
  onToggleCollapsed,
  onOpenSettings,
}: AppAdvisorTitlebarCornerProps): JSX.Element {
  const createWorkEntry = useStandaloneChatStore((s) => s.createWorkEntry);

  const handleNewEntry = useCallback((): void => {
    // Explicit navigation to a fresh live entry dismisses the page-like
    // archived-container viewer (mirrors AppAdvisorNav's entry selection) —
    // otherwise the viewer keeps covering the newly created entry.
    // createWorkEntry → selectWorkEntry already clears the legacy overlay.
    dismissPageLikeViewers();
    void createWorkEntry();
  }, [createWorkEntry]);

  const platform: NodeJS.Platform = localPlatform();
  const leadingCss = titlebarToggleLeadingCss(
    shouldReserveSidebarTrafficLightRegion(platform),
  );

  return (
    <div
      // The sticky tier keeps these persistent window-chrome controls
      // clickable above the z-30 archived-container overlay while the top bar
      // is unmounted.
      className="absolute left-0 top-0 z-sticky flex h-10.75 items-center"
      data-testid="app-advisor-titlebar-corner"
    >
      <div
        className="electron-drag h-full shrink-0"
        style={{ width: leadingCss }}
      />
      <TitlebarIconButton
        onClick={onToggleCollapsed}
        icon={SidebarHiddenLeftWideIcon}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-expanded={!collapsed}
        data-testid="app-advisor-nav-collapse"
        // The control had no visible tooltip before; keep it that way.
        tooltipLabel=""
      />
      <TitlebarIconButton
        onClick={onOpenSettings}
        icon={SettingsIcon}
        iconSize={14}
        aria-label={`${ORCHESTRATOR_LABEL} settings`}
        tooltipLabel="Settings"
        data-testid="app-advisor-nav-settings"
      />
      <TitlebarIconButton
        onClick={handleNewEntry}
        icon={PlusMediumIcon}
        iconSize={14}
        aria-label="New work entry"
        data-testid="app-advisor-nav-new-entry"
      />
    </div>
  );
});
