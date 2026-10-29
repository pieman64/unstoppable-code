import type { JSX, SVGProps } from 'react';
import { BuildingIcon as AppCatalogBuildingIcon } from './AppIcons';

/**
 * Office/organization building glyph. Used for the Organization entry in the
 * account menu (originally the web TopNav's icon-only mobile form, CAN-1220).
 * Monochrome; inherits `currentColor`.
 */
export function BuildingIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogBuildingIcon
      width="20"
      height="20"
      aria-hidden="true"
      {...props}
    />
  );
}
