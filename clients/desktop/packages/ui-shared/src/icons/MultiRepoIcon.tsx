import type { JSX, SVGProps } from 'react';
import { MultiRepoIcon as AppCatalogMultiRepoIcon } from './AppIcons';

/**
 * Multi-repo workspace badge glyph — the stacked-folders symbol the unified
 * sidebar (ProjectHeader) uses for multi-repo workspaces. Monochrome; inherits
 * `currentColor`.
 */
export function MultiRepoIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogMultiRepoIcon
      width="12"
      height="12"
      aria-hidden="true"
      {...props}
    />
  );
}
