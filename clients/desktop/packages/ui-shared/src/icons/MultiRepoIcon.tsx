import type { JSX } from 'react';
import {
  MultiRepoIcon as AppCatalogMultiRepoIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Multi-repo workspace badge glyph — the stacked-folders symbol the unified
 * sidebar (ProjectHeader) uses for multi-repo workspaces. Monochrome; inherits
 * `currentColor`.
 */
export function MultiRepoIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogMultiRepoIcon size="sm" aria-hidden="true" {...props} />;
}
