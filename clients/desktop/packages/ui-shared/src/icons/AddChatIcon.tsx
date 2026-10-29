import type { JSX, SVGProps } from 'react';
import { AddChatIcon as AppCatalogAddChatIcon } from './AppIcons';

/**
 * Material Symbols "add_comment" glyph (a speech bubble with a plus). Used for
 * the New Chat affordance. Visible paths use `currentColor` so callers control
 * the color via `className`.
 */
export function AddChatIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogAddChatIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
