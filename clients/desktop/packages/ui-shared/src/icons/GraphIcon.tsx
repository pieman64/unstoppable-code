import type { JSX } from 'react';
import {
  GraphIcon as AppCatalogGraphIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Polyline "graph" glyph (Material Symbols `polyline`). Shared across the
 * code-graph tool blocks, the collapsed-turn "graph" summary chip, and the
 * worktree-row "graph building" indicator so all code-graph surfaces read as
 * one family.
 */
export function GraphIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogGraphIcon size="sm" {...props} />;
}
