'use client';

import type { JSX } from 'react';
import { FolderIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * The heading above the directory options, shared by the desktop
 * `DirectoryPicker` menu and this picker.
 */
export function DirectoryPickerHeading(): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-xs font-normal fg-secondary">
      <FolderIcon size="sm" />
      Working directory
    </div>
  );
}
