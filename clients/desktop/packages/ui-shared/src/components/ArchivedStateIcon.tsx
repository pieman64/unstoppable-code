import type { JSX } from 'react';
import { ArchiveIcon, TrashIcon } from '../icons/AppIcons';
import type { ArchivedContainerState } from '../lib/archived-state';

export function ArchivedStateIcon({
  state,
  size = 14,
}: {
  state: ArchivedContainerState;
  size?: number;
}): JSX.Element {
  const Icon = state === 'archived' ? ArchiveIcon : TrashIcon;
  return (
    <Icon
      width={size}
      height={size}
      aria-hidden="true"
      className={
        state === 'archived'
          ? 'shrink-0 fg-secondary'
          : 'shrink-0 fg-destructive'
      }
    />
  );
}
