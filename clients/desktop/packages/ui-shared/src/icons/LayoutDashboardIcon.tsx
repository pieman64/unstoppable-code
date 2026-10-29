import type { JSX, SVGProps } from 'react';
import { LayoutDashboardIcon as AppCatalogLayoutDashboardIcon } from './AppIcons';

/**
 * Dashboard/layout glyph (a framed panel grid). Visible paths use
 * `currentColor` so callers control the color via `className`/`text-*`.
 */
export function LayoutDashboardIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return (
    <AppCatalogLayoutDashboardIcon
      width="15"
      height="15"
      aria-hidden="true"
      {...props}
    />
  );
}
