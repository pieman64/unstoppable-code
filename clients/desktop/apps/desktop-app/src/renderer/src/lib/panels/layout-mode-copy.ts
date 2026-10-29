import type { WorkspaceLayoutMode } from '@canopy/desktop-shared/types';

export interface WorkspaceLayoutModeCopy {
  readonly label: string;
  readonly description: string;
}

/** Sentence-case labels and descriptions shared by Settings and the header menu. */
export const WORKSPACE_LAYOUT_MODE_COPY: Record<
  WorkspaceLayoutMode,
  WorkspaceLayoutModeCopy
> = {
  minimal: {
    label: 'Minimal',
    description:
      'A focused layout with fixed chat, side panel, and bottom drawer areas.',
  },
  advanced: {
    label: 'Advanced',
    description: 'Full panel controls and customizable layouts.',
  },
};
