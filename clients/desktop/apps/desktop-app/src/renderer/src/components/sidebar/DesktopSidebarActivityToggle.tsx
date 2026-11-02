import { useMemo, type JSX } from 'react';
import {
  SidebarActivityModeToggle,
  withSidebarActivitySpaceMute,
} from '@canopy/ui-app';
import {
  isSpaceNotificationMuted,
  type TitlebarIconButtonForeground,
} from '@canopy/ui-shared/components';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { useSpaceNotificationSidebarProps } from '@/hooks/useSpaceNotificationSidebarProps';
import { useDesktopSidebarActivityHost } from './desktopSidebarActivityMode';

/**
 * The desktop Activity bell, beside the context switcher when available,
 * otherwise beside Search, leaving the titlebar resource pill clear of history. Lazy-loaded
 * with the shared sidebar so the titlebar's eager bundle stays small.
 */
export function DesktopSidebarActivityToggle({
  foreground = 'titlebar',
}: {
  readonly foreground?: TitlebarIconButtonForeground;
}): JSX.Element | null {
  const activity = useDesktopSidebarActivityHost(ipcCanopyClient);
  // This bell sits outside the shared sidebar, so it attaches the rail's mute
  // lookup itself: a muted space's chats stay out of Unread (CAN-4378).
  const { getWorktreeNotificationSettings } =
    useSpaceNotificationSidebarProps();
  const host = useMemo(
    () =>
      withSidebarActivitySpaceMute(
        activity,
        getWorktreeNotificationSettings
          ? (workspaceLocalId: string, spaceLocalId: string): boolean =>
              isSpaceNotificationMuted(
                getWorktreeNotificationSettings(workspaceLocalId, spaceLocalId),
              )
          : undefined,
      ),
    [activity, getWorktreeNotificationSettings],
  );
  return (
    <SidebarActivityModeToggle
      host={host}
      capabilities={ipcCanopyClient.capabilities}
      foreground={foreground}
      className={foreground === 'titlebar' ? 'ml-1' : undefined}
    />
  );
}
