import type { JSX, SVGProps } from 'react';
import { AssignmentIcon as AppCatalogAssignmentIcon } from './AppIcons';

/**
 * Material Symbols "assignment" glyph (a clipboard with filled lines). Used to
 * indicate that a follow-up instruction has been set. Visible paths use
 * `currentColor` so callers control the color via `className`.
 */
export function AssignmentIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogAssignmentIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
