import type { JSX } from 'react';
import {
  WorkspaceMultiSelectPicker as SharedWorkspaceMultiSelectPicker,
  type WorkspaceMultiSelectPickerProps,
  type WorkspacePickerOption as SharedWorkspacePickerOption,
} from '@canopy/ui-app/code/shell/WorkspaceMultiSelectPicker';
import { WorkspaceBadgeIcon } from '../shared/WorkspaceBadgeIcon';

/**
 * Desktop's project option: the shared one plus the local repository the
 * canonical project icon resolves its avatar from. `AdhocMultiRepoJoinOption`
 * is structurally compatible.
 */
export interface WorkspacePickerOption extends SharedWorkspacePickerOption {
  /** Single-repo path used by the canonical project icon. */
  readonly repoPath?: string;
}

/** Desktop's icon for a picker row: the avatar resolves over IPC. */
export function renderDesktopWorkspaceOption(
  option: WorkspacePickerOption,
): JSX.Element {
  return (
    <WorkspaceBadgeIcon
      isMultiRepo={option.isMultiRepo}
      temporary={option.temporary === true}
      color={option.color}
      name={option.name}
      repoPath={option.repoPath}
    />
  );
}

/** The shared project picker with desktop's project icon. */
export function WorkspaceMultiSelectPicker(
  props: Omit<
    WorkspaceMultiSelectPickerProps<WorkspacePickerOption>,
    'renderOptionIcon'
  >,
): JSX.Element {
  return (
    <SharedWorkspaceMultiSelectPicker
      {...props}
      renderOptionIcon={renderDesktopWorkspaceOption}
    />
  );
}
