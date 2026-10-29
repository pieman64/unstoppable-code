import type { JSX } from 'react';
import { ProjectIcon } from './ProjectIcon';

interface WorkspaceBadgeIconProps {
  isMultiRepo: boolean;
  temporary: boolean;
  /** Workspace color; tints the badge background for non-temporary workspaces. */
  color: string;
  /** Workspace name; unused for the icon itself, kept for prop compatibility. */
  name: string;
  /** Local repository used to resolve the shared project avatar. */
  repoPath?: string;
}

/**
 * Colored workspace badge shared by the worktree-join pickers so both render
 * workspace entries identically. Mirrors the sidebar's workspace glyphs: a
 * multi-repo workspace uses the stacked-folders icon, a temporary multi-repo
 * workspace uses the dashed-folders icon (on a neutral gray background), and
 * a single-repo workspace uses the folder-with-code-brackets icon.
 */
export function WorkspaceBadgeIcon({
  isMultiRepo,
  temporary,
  color,
  repoPath,
}: WorkspaceBadgeIconProps): JSX.Element {
  return (
    <ProjectIcon
      kind={isMultiRepo ? 'multi-repo' : 'single-repo'}
      temporary={temporary}
      color={color}
      repoPath={repoPath}
    />
  );
}
