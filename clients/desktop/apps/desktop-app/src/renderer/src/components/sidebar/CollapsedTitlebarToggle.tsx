import { type JSX } from 'react';
import { useSidebarStore } from '@/stores/sidebarStore';
import {
  shouldReserveSidebarTrafficLightRegion,
  titlebarCornerWidthCss,
} from '../sidebar-layout';
import { localPlatform } from '@/lib/local-platform';

/**
 * Spacer that reserves room for the persistent titlebar corner
 * (rendered by `App.tsx` as the app root's LAST child — see the paint-order
 * comment there) at the left of a page's top bar while the sidebar is hidden.
 *
 * It renders no button of its own: the corner overlay owns the single
 * app-wide toggle at constant window coordinates. Its width changes in sync
 * with the sidebar so both surfaces switch states together.
 */
export function CollapsedTitlebarToggle(): JSX.Element {
  const hidden = useSidebarStore((s) => s.hidden);
  const previewSlidIn = useSidebarStore((s) => s.previewSlidIn);
  // Pinning a revealed preview commits the docked layout in one frame (see the
  // matching derivation in AppSidebar). This spacer drives the page header's
  // leading inset, so if it kept animating while the sidebar snapped open the
  // header content would slide on its own — the project icon and branch
  // visibly flying away from a sidebar that had already arrived.
  const pinHandover = !hidden && previewSlidIn;
  const platform: NodeJS.Platform = localPlatform();

  const reserveTrafficLights = shouldReserveSidebarTrafficLightRegion(platform);

  return (
    <div
      className={`sidebar-instant-interactions electron-drag shrink-0 self-stretch overflow-hidden ${
        pinHandover
          ? ''
          : 'sidebar-layout-transition transition-[width] duration-200 ease-in-out'
      }`}
      style={{
        width: hidden ? titlebarCornerWidthCss(reserveTrafficLights, true) : 0,
      }}
      data-testid="page-titlebar-spacer"
    />
  );
}
