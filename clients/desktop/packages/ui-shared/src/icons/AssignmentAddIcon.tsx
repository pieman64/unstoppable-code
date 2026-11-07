import type { JSX } from 'react';
import {
  AssignmentAddIcon as AppCatalogAssignmentAddIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Material Symbols "assignment_add" glyph (a clipboard with a plus badge). Used
 * to invite setting a follow-up instruction when none is set yet. Visible paths
 * use `currentColor` so callers control the color via `className`.
 */
export function AssignmentAddIcon(props: AppIconProps): JSX.Element {
  return (
    <AppCatalogAssignmentAddIcon size="sm" aria-hidden="true" {...props} />
  );
}
