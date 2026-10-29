import type { JSX, SVGProps } from 'react';
import { CoworkWorkspaceIcon as AppCatalogCoworkWorkspaceIcon } from './AppIcons';

/**
 * Cowork workspace badge glyph — the compact filled-folder symbol the unified sidebar
 * uses for cowork (non-git) workspaces. Monochrome; inherits `currentColor`.
 */
export function CoworkWorkspaceIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return (
    <AppCatalogCoworkWorkspaceIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
