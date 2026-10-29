'use client';

import type { JSX } from 'react';
import { DropdownMenuLabel } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { SidebarPersonAvatar } from './SidebarAccountFooter';

export interface SidebarAccountMenuHeaderProps {
  readonly name: string;
  readonly email: string;
  readonly image?: string | null;
}

/**
 * The personal account menu's identity header (CAN-4057): avatar, name, and
 * email of the signed-in person. A label, not a row, so it takes no focus.
 * Renders nothing when there is neither a name nor an email to show.
 */
export function SidebarAccountMenuHeader({
  name,
  email,
  image,
}: SidebarAccountMenuHeaderProps): JSX.Element | null {
  const shownName = name.trim();
  const shownEmail = email.trim();
  if (shownName === '' && shownEmail === '') return null;
  return (
    <DropdownMenuLabel
      spacing="relaxed"
      data-testid="sidebar-account-menu-header-identity"
    >
      <span className="flex min-w-0 items-center gap-2">
        <SidebarPersonAvatar name={shownName || shownEmail} image={image} />
        <span className="flex min-w-0 flex-1 flex-col">
          {shownName !== '' ? (
            <span
              className={`${REPLAY_BLOCK_CLASS} truncate text-s font-medium fg-primary`}
              title={shownName}
            >
              {shownName}
            </span>
          ) : null}
          {shownEmail !== '' ? (
            <span
              className={`${REPLAY_BLOCK_CLASS} truncate text-xs fg-secondary`}
              title={shownEmail}
            >
              {shownEmail}
            </span>
          ) : null}
        </span>
      </span>
    </DropdownMenuLabel>
  );
}
