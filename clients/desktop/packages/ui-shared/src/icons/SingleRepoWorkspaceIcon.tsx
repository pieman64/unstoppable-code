import type { JSX, SVGProps } from 'react';
import { SingleRepoWorkspaceIcon as AppCatalogSingleRepoWorkspaceIcon } from './AppIcons';

/**
 * Single-repo workspace badge glyph — compact filled folder used for
 * single-repo (git) workspaces. Monochrome; inherits `currentColor`.
 */
export function SingleRepoWorkspaceIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return (
    <AppCatalogSingleRepoWorkspaceIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
