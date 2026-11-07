import type { JSX } from 'react';
import {
  AssignmentIcon as AppCatalogAssignmentIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Material Symbols "assignment" glyph (a clipboard with filled lines). Used to
 * indicate that a follow-up instruction has been set. Visible paths use
 * `currentColor` so callers control the color via `className`.
 */
export function AssignmentIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogAssignmentIcon size="sm" aria-hidden="true" {...props} />;
}
