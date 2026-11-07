import type { JSX } from 'react';
import {
  CoworkWorkspaceIcon as AppCatalogCoworkWorkspaceIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Cowork workspace badge glyph — the compact filled-folder symbol the unified sidebar
 * uses for cowork (non-git) workspaces. Monochrome; inherits `currentColor`.
 */
export function CoworkWorkspaceIcon(props: AppIconProps): JSX.Element {
  return (
    <AppCatalogCoworkWorkspaceIcon size="sm" aria-hidden="true" {...props} />
  );
}
