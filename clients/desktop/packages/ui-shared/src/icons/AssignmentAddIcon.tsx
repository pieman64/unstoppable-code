import type { JSX, SVGProps } from 'react';
import { AssignmentAddIcon as AppCatalogAssignmentAddIcon } from './AppIcons';

/**
 * Material Symbols "assignment_add" glyph (a clipboard with a plus badge). Used
 * to invite setting a follow-up instruction when none is set yet. Visible paths
 * use `currentColor` so callers control the color via `className`.
 */
export function AssignmentAddIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogAssignmentAddIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
