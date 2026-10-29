'use client';

import {
  usePanelHostState,
  usePanelVisible,
} from '../code/panels/panel-contexts';

/**
 * Whether a find surface is on screen: its panel tab is the shown tab of its
 * group and the page hosting the grid is visible. Hosts keep hidden tabs and
 * a hidden main page mounted, so a surface registers only while this holds;
 * otherwise the bar could open on, or keep searching, content the user
 * cannot see.
 */
export function useFindSurfaceShown(): boolean {
  const hostVisible = usePanelHostState().visible !== false;
  const tabVisible = usePanelVisible();
  return hostVisible && tabVisible;
}
