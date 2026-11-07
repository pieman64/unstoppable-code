import type { JSX } from 'react';
import { ArchiveIcon, TrashIcon, type IconSize } from '../icons/AppIcons';
import type { ArchivedContainerState } from '../lib/archived-state';

export function ArchivedStateIcon({
  state,
  size = 'sm',
}: {
  state: ArchivedContainerState;
  size?: IconSize;
}): JSX.Element {
  const Icon = state === 'archived' ? ArchiveIcon : TrashIcon;
  return (
    <Icon
      size={size}
      aria-hidden="true"
      className={
        state === 'archived'
          ? 'shrink-0 fg-secondary'
          : 'shrink-0 fg-destructive'
      }
    />
  );
}
