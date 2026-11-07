import type { JSX } from 'react';
import {
  SingleRepoWorkspaceIcon as AppCatalogSingleRepoWorkspaceIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Single-repo workspace badge glyph — compact filled folder used for
 * single-repo (git) workspaces. Monochrome; inherits `currentColor`.
 */
export function SingleRepoWorkspaceIcon(props: AppIconProps): JSX.Element {
  return (
    <AppCatalogSingleRepoWorkspaceIcon
      size="sm"
      aria-hidden="true"
      {...props}
    />
  );
}
