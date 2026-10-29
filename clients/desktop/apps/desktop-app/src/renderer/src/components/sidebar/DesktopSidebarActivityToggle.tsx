import type { JSX } from 'react';
import { SidebarActivityModeToggle } from '@canopy/ui-app';
import type { TitlebarIconButtonForeground } from '@canopy/ui-shared/components';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { useDesktopSidebarActivityHost } from './desktopSidebarActivityMode';

/**
 * The desktop Activity bell, beside the context switcher when available,
 * otherwise in the sidebar titlebar beside the resource pill. Lazy-loaded
 * with the shared sidebar so the titlebar's eager bundle stays small.
 */
export function DesktopSidebarActivityToggle({
  foreground = 'titlebar',
}: {
  readonly foreground?: TitlebarIconButtonForeground;
}): JSX.Element | null {
  const host = useDesktopSidebarActivityHost(ipcCanopyClient);
  return (
    <SidebarActivityModeToggle
      host={host}
      capabilities={ipcCanopyClient.capabilities}
      foreground={foreground}
      className={foreground === 'titlebar' ? 'ml-1' : undefined}
    />
  );
}
