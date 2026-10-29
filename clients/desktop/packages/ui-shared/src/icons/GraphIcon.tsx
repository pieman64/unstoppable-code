import type { JSX, SVGProps } from 'react';
import { GraphIcon as AppCatalogGraphIcon } from './AppIcons';

/**
 * Polyline "graph" glyph (Material Symbols `polyline`). Shared across the
 * code-graph tool blocks, the collapsed-turn "graph" summary chip, and the
 * worktree-row "graph building" indicator so all code-graph surfaces read as
 * one family.
 */
export function GraphIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogGraphIcon width="14" height="14" {...props} />;
}
