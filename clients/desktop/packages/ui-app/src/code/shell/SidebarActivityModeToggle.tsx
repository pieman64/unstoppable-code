'use client';

import type { JSX } from 'react';
import type { CanopyCapabilities } from '@canopy/app-core';
import { useSidebarActivityModeStore } from '@canopy/app-state';
import {
  TitlebarIconButton,
  type TitlebarIconButtonForeground,
} from '@canopy/ui-shared/components';
import { BellIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  prepareSidebarActivityLoader,
  type SidebarActivityHost,
} from './sidebar-activity-host';
import { useSidebarActivityGate } from './SidebarActivityModeView';

export interface SidebarActivityModeToggleProps {
  readonly host: SidebarActivityHost | undefined;
  readonly capabilities: CanopyCapabilities;
  readonly foreground?: TitlebarIconButtonForeground;
  readonly className?: string;
}

/**
 * The bell that turns Activity on and off. Renders nothing unless the
 * capability and a host are both present. Each host places exactly one:
 * beside the context switcher when present, otherwise in the desktop
 * titlebar or Portal sidebar header.
 */
export function SidebarActivityModeToggle({
  host,
  capabilities,
  foreground,
  className,
}: SidebarActivityModeToggleProps): JSX.Element | null {
  const active = useSidebarActivityGate(host, capabilities);
  const toggle = useSidebarActivityModeStore((state) => state.toggle);
  if (host === undefined || capabilities.sidebarActivityMode !== true)
    return null;
  // The pressed surface sits on a wrapper: the button owns its own ink.
  return (
    <span
      className={`inline-flex rounded-md ${active ? 'bg-subtle' : ''} ${className ?? ''}`}
    >
      <TitlebarIconButton
        icon={BellIcon}
        aria-label="Activity"
        aria-pressed={active}
        foreground={foreground}
        data-testid="sidebar-activity-toggle"
        onClick={(): void =>
          toggle(
            prepareSidebarActivityLoader(host, capabilities),
            host.sessionKey,
          )
        }
      />
    </span>
  );
}
